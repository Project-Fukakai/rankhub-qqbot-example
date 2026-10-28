/**
 * `/me` 名片渲染器：HTML/CSS → playwright-core（headless Chromium）截图。
 *
 * 与 `src/render/phi` 相同的注入思路：
 * 1. `buildCardHtml` 生成单页 HTML，图片/字体全部 `data:` URL 内联（不发任何网络请求）；
 * 2. `page.setContent` 注入（base URL 为 about:blank，输出与工作目录无关）；
 * 3. 等字体 + 图片 decode + 两帧 rAF 后截 `body`（整页）或 `.game-card`（单卡证据）。
 *
 * 静态素材（App 字体、arcaea 背景/横幅/评级图标、phigros 课题徽章、maimai DX Rating 徽章与
 * 数字）从 `vendor/card/**` 读取，由 `scripts/fetch-assets-card.mjs` 准备；缺失时降级，
 * 渲染不会失败。动态图片（头像/曲绘/立绘/二维码）只从调用方传入的 `Buffer` 来。
 */
import { chromium, type Browser, type Page } from 'playwright-core';

import {
  CARD_WIDTH,
  buildCardHtml,
  buildGameCardHtml,
  type CardAssetBundle,
} from './html.js';
import {
  PHI_FAMILY,
  SAIRA_FAMILY,
  findBrowserExecutable,
  fontFaceCss,
  loadCardAssets,
  type BrowserLaunchTarget,
} from './assets.js';
import type {
  PlayerCardGameCard,
  PlayerCardInput,
  PlayerCardRect,
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

interface RenderTarget {
  page: Page;
  /** 实际加载（内联）的字体 family。 */
  families: string[];
  assets: ReturnType<typeof loadCardAssets>;
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
    return this.renderWith((assets) => buildCardHtml(input, this.assetBundle(assets)), 'body');
  }

  /** 只渲染一张游戏卡（1120×448），用于证据截图 / 单卡调试。 */
  async renderGameCard(card: PlayerCardGameCard): Promise<Buffer> {
    const result = await this.renderGameCardDetail(card);
    return result.buffer;
  }

  /** 只渲染一张游戏卡并返回详细信息。 */
  async renderGameCardDetail(card: PlayerCardGameCard): Promise<PlayerCardRenderResult> {
    return this.renderWith(
      (assets) => buildGameCardHtml(card, this.assetBundle(assets)),
      'article.game-card',
    );
  }

  private assetBundle(assets: ReturnType<typeof loadCardAssets>): CardAssetBundle {
    const faces = this.options.includePhiFont === true
      ? assets.fonts
      : assets.fonts.filter((face) => face.family !== PHI_FAMILY);
    return {
      fontFaceCss: fontFaceCss(faces),
      images: assets.images,
    };
  }

  private async renderWith(
    build: (assets: RenderTarget['assets']) => ReturnType<typeof buildCardHtml>,
    clipSelector: 'body' | 'article.game-card',
  ): Promise<PlayerCardRenderResult> {
    const assets = loadCardAssets(this.options.assetsDir);
    const built = build(assets);
    const browser = await this.ensureBrowser();
    const page = await browser.newPage({
      viewport: { width: CARD_WIDTH, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
    });
    const families = this.options.includePhiFont === true
      ? assets.families
      : assets.families.filter((family) => family !== PHI_FAMILY);
    try {
      await page.setContent(built.html, { waitUntil: 'load', timeout: this.timeoutMs });
      const ready = await this.waitForRenderReady(page, families);
      const measured = await this.measure(page, clipSelector);
      const pageTarget = this.browserTarget;
      if (!pageTarget) throw new Error('名片渲染器未记录 Chromium 来源，无法继续');

      let buffer = await this.screenshot(page, 'png', clipSelector);
      let format: 'png' | 'jpeg' = 'png';
      if (buffer.length > this.maxImageBytes) {
        buffer = await this.screenshot(page, 'jpeg', clipSelector);
        format = 'jpeg';
      }

      return {
        buffer,
        format,
        width: measured.width,
        height: measured.height,
        html: built.html,
        summary: built.summary,
        usedStaticAssets: built.usedStaticAssets,
        missingStaticAssets: built.missingStaticAssets,
        diagnostics: {
          browserPath: pageTarget.executablePath,
          browserSource: pageTarget.source,
          fontFamilies: families,
          fontsReady: ready.fontsReady,
          cardRects: measured.cardRects,
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

  /** 等字体、图片解码、FittedBox 等价缩放完成，并让排版落定（两帧 rAF）。 */
  private async waitForRenderReady(
    page: Page,
    families: string[],
  ): Promise<RenderReadyReport> {
    await page.waitForLoadState('load', { timeout: this.timeoutMs });
    const report = await page.evaluate(async (fontFamilies) => {
      try {
        if (document.fonts?.ready) await document.fonts.ready;
      } catch {
        /* 字体加载失败也要继续截图 */
      }
      // Flutter FittedBox(scaleDown) 的等价测量：字体就绪后重新缩放一次。
      try {
        (window as unknown as { __cardFitText?: () => void }).__cardFitText?.();
      } catch {
        /* 无脚本时忽略 */
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
      for (const family of fontFamilies) {
        try {
          // 声明了但未使用的字体不会真正加载：先显式 load 再 check。
          await document.fonts.load(`16px "${family}"`);
          if (!document.fonts.check(`16px "${family}"`)) fontsReady = false;
        } catch {
          fontsReady = false;
        }
      }
      return {
        fontsReady,
        imageCount: images.length,
        imagesDecoded: images.filter((img) => img.complete && img.naturalWidth > 0).length,
      };
    }, families);
    // 兜底：极慢机器上图片 decode 事件可能晚一帧。
    await page.waitForTimeout(60);
    return report;
  }

  private async measure(
    page: Page,
    clipSelector: 'body' | 'article.game-card',
  ): Promise<{
    width: number;
    height: number;
    cardRects: PlayerCardRect[];
    scrollWidth: number;
    clientWidth: number;
  }> {
    const selector = clipSelector === 'body' ? 'body' : 'article.game-card';
    const box = await page.locator(selector).first().boundingBox();
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
      cardRects: Array.from(document.querySelectorAll('article.game-card')).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          game: element.getAttribute('data-game') ?? '',
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        };
      }),
    }));
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      cardRects: layout.cardRects,
      scrollWidth: layout.scrollWidth,
      clientWidth: layout.clientWidth,
    };
  }

  private async screenshot(
    page: Page,
    format: 'png' | 'jpeg',
    clipSelector: 'body' | 'article.game-card',
  ): Promise<Buffer> {
    const options =
      format === 'png'
        ? ({ type: 'png' as const, animations: 'disabled' as const, caret: 'hide' as const })
        : ({
            type: 'jpeg' as const,
            quality: 90,
            animations: 'disabled' as const,
            caret: 'hide' as const,
          });
    const selector = clipSelector === 'body' ? 'body' : 'article.game-card';
    return page.locator(selector).first().screenshot(options);
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

/** 仅用于日志/排查：当前会用到哪些字体/素材。 */
export function describeCardAssets(options: { assetsDir?: string } = {}): {
  fonts: string[];
  hasDisplayFont: boolean;
  staticAssets: number;
  missing: string[];
} {
  const assets = loadCardAssets(options.assetsDir);
  return {
    fonts: assets.families,
    hasDisplayFont: assets.families.includes(SAIRA_FAMILY),
    staticAssets: Object.keys(assets.images).length,
    missing: assets.missing,
  };
}
