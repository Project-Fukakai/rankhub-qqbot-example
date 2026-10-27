/**
 * `/me` 名片渲染器：HTML/CSS → playwright-core（headless Chromium）截图。
 *
 * 与 `src/render/phi` 相同的注入思路，但版式是本仓库自绘的（不依赖 phi-plugin 模板）：
 * 1. `buildCardHtml` 生成单页 HTML，图片/字体全部 `data:` URL 内联（不发任何网络请求）；
 * 2. `page.setContent` 注入（base URL 为 about:blank，输出与工作目录无关）；
 * 3. 等字体 + 图片 decode + 两帧 rAF 后用 `body` 元素截图，宽度固定 1200、高度随内容。
 */
import { chromium, type Browser, type Page } from 'playwright-core';

import {
  DISPLAY_FONT_FAMILY,
  displayFontFaceCss,
  findBrowserExecutable,
  loadDisplayFont,
  type BrowserLaunchTarget,
} from './assets.js';
import { CARD_WIDTH, buildCardHtml } from './html.js';
import type {
  PlayerCardInput,
  PlayerCardRenderResult,
  PlayerCardRenderer,
  PlayerCardRendererOptions,
} from './types.js';

/** QQ 图片上限约 5MB，留 0.5MB 余量；超过则降级 JPEG。 */
export const MAX_CARD_IMAGE_BYTES = 4.5 * 1024 * 1024;

/** 截图 viewport 初始高度；只用于启动页面，实际输出高度取 body 盒模型。 */
const VIEWPORT_HEIGHT = 900;

interface RenderReadyReport {
  fontsReady: boolean;
  imageCount: number;
  imagesDecoded: number;
}

/** 名片渲染器实现（对外类型见 `PlayerCardRenderer`）。 */
export class CardRenderer implements PlayerCardRenderer {
  private readonly options: PlayerCardRendererOptions;
  private readonly timeoutMs: number;
  private readonly maxImageBytes: number;
  private browser: Browser | null = null;
  private browserTarget: BrowserLaunchTarget | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: PlayerCardRendererOptions = {}) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxImageBytes = options.maxImageBytes ?? MAX_CARD_IMAGE_BYTES;
  }

  /** 渲染并返回 PNG/JPEG 字节（超过 `maxImageBytes` 时降级 JPEG）。 */
  async renderPlayerCard(input: PlayerCardInput): Promise<Buffer> {
    const result = await this.renderPlayerCardDetail(input);
    return result.buffer;
  }

  /** 渲染并返回 HTML / 尺寸 / 诊断信息（测试与排查用）。 */
  async renderPlayerCardDetail(input: PlayerCardInput): Promise<PlayerCardRenderResult> {
    const font = loadDisplayFont(this.options.fontsDir);
    const { html, summary } = buildCardHtml(input, {
      fontFaceCss: displayFontFaceCss(font),
    });

    const browser = await this.ensureBrowser();
    const page = await browser.newPage({
      viewport: { width: CARD_WIDTH, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
    });
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: this.timeoutMs });
      const ready = await this.waitForRenderReady(page, font?.family ?? null);
      const measured = await this.measure(page);
      const pageTarget = this.browserTarget;
      if (!pageTarget) throw new Error('名片渲染器未记录 Chromium 来源，无法继续');

      let buffer = await this.screenshot(page, 'png');
      let format: 'png' | 'jpeg' = 'png';
      if (buffer.length > this.maxImageBytes) {
        buffer = await this.screenshot(page, 'jpeg');
        format = 'jpeg';
      }

      return {
        buffer,
        format,
        width: measured.width,
        height: measured.height,
        html,
        summary,
        diagnostics: {
          browserPath: pageTarget.executablePath,
          browserSource: pageTarget.source,
          displayFont: font?.family ?? null,
          fontsReady: ready.fontsReady,
          scrollWidth: measured.scrollWidth,
          clientWidth: measured.clientWidth,
        },
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const target = findBrowserExecutable(this.options.browserPath);
    const browser = await chromium.launch({
      executablePath: target.executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        // 与 phi 渲染器保持一致：即便将来换成 file:// 页面也不被跨源拦截。
        '--allow-file-access-from-files',
        '--font-render-hinting=none',
        '--force-color-profile=srgb',
      ],
    });
    this.browser = browser;
    this.browserTarget = target;
    browser.on('disconnected', () => {
      if (this.browser === browser) this.browser = null;
    });
    return browser;
  }

  /** 等字体、图片解码完成，并让排版落定（两帧 rAF）。 */
  private async waitForRenderReady(
    page: Page,
    displayFamily: string | null,
  ): Promise<RenderReadyReport> {
    await page.waitForLoadState('load', { timeout: this.timeoutMs });
    const report = await page.evaluate(async (family) => {
      try {
        if (document.fonts?.ready) await document.fonts.ready;
      } catch {
        /* 字体加载失败也要继续截图 */
      }
      const images = Array.from(document.images);
      await Promise.all(
        images.map((img) =>
          img.complete && img.naturalWidth > 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              }),
        ),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      let fontsReady = true;
      if (family) {
        try {
          fontsReady = document.fonts.check(`16px "${family}"`);
        } catch {
          fontsReady = false;
        }
      }
      return {
        fontsReady,
        imageCount: images.length,
        imagesDecoded: images.filter((img) => img.complete && img.naturalWidth > 0).length,
      };
    }, displayFamily);
    // 兜底：极慢机器上图片 decode 事件可能晚一帧。
    await page.waitForTimeout(60);
    return report;
  }

  private async measure(page: Page): Promise<{
    width: number;
    height: number;
    scrollWidth: number;
    clientWidth: number;
  }> {
    const box = await page.locator('body').boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('名片页面尺寸为空，无法截图');
    }
    const layout = await page.evaluate(() => ({
      scrollWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
        document.body.offsetWidth,
      ),
      clientWidth: document.documentElement.clientWidth,
    }));
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      scrollWidth: layout.scrollWidth,
      clientWidth: layout.clientWidth,
    };
  }

  private async screenshot(page: Page, format: 'png' | 'jpeg'): Promise<Buffer> {
    const options =
      format === 'png'
        ? ({ type: 'png' as const, animations: 'disabled' as const, caret: 'hide' as const })
        : ({
            type: 'jpeg' as const,
            quality: 90,
            animations: 'disabled' as const,
            caret: 'hide' as const,
          });
    return page.locator('body').screenshot(options);
  }

  /** 关闭 Chromium。可重复调用。 */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const browser = this.browser;
    if (!browser) return;
    this.browser = null;
    this.closing = browser
      .close()
      .catch(() => {})
      .then(() => {
        this.closing = null;
      });
    return this.closing;
  }
}

/** 创建名片渲染器（对外签名见 `PlayerCardRenderer`）。 */
export function createPlayerCardRenderer(
  options: PlayerCardRendererOptions = {},
): PlayerCardRenderer {
  return new CardRenderer(options);
}

/** 仅用于日志/排查：当前会用到哪些字体。 */
export function describeCardAssets(options: { fontsDir?: string } = {}): {
  displayFont: string | null;
  displayFontPath: string | null;
  displayFontBytes: number;
  displayFontFamily: string;
} {
  const font = loadDisplayFont(options.fontsDir);
  return {
    displayFont: font ? font.family : null,
    displayFontPath: font ? font.path : null,
    displayFontBytes: font ? font.bytes : 0,
    displayFontFamily: DISPLAY_FONT_FAMILY,
  };
}
