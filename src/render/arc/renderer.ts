/**
 * Arcaea B50 海报渲染器：模板 HTML → 本机 Chromium 截图 → PNG Buffer。
 *
 * 路线与 `src/render/phi/renderer.ts` 一致（同一个 Chromium + 同一组 launch 参数）：
 * 版式全部来自 design 稿 best-posters 的 CSS，Node 侧只负责数据映射与截图。
 *
 * 使用方式：
 * ```ts
 * const renderer = createArcaeaRenderer();
 * try {
 *   const png = await renderer.renderArcaeaB50({ profileName, potential, items });
 * } finally {
 *   await renderer.close();
 * }
 * ```
 * 素材准备（首次/更新）：`node scripts/fetch-assets-arc.mjs`
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';

import {
  findBrowserExecutable,
  loadArcAssets,
  REPO_ROOT,
  type ArcAssets,
  type BrowserLaunchTarget,
} from './assets.js';
import { buildArcTemplateData, type ArcTemplateData } from './data.js';
import { buildArcPosterHtml } from './template.js';
import type { ArcaeaB50RenderInput } from './types.js';

/** QQ 图片上限约 5MB，留 0.5MB 余量（与 phi 渲染器同口径）。 */
export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

/** 海报定宽（best-posters `css/base.css:50` `.poster{width:2600px}`）。 */
export const POSTER_WIDTH = 2600;

export interface ArcaeaRendererOptions {
  /** 素材目录（默认 `vendor/arc`，可用 ARC_ASSETS_DIR 覆盖）。 */
  assetsDir?: string;
  /** Chromium 可执行文件（默认 RENDER_BROWSER_PATH / playwright 缓存）。 */
  browserPath?: string;
  /** 渲染时刻（测试固定时间用）。 */
  now?: Date;
  /** 页面加载/截图超时（ms）。 */
  timeoutMs?: number;
  /** PNG 超过该字节数时降级为 JPEG quality 90；再超则整体缩到 85%。 */
  maxImageBytes?: number;
  /** 临时 HTML 目录（默认 `<repo>/data/tmp/arc-render`）。 */
  tempDir?: string;
  /**
   * 截图视口（默认 2600×1200：宽度必须等于海报定宽）。
   *
   * 为什么宽度不能小：Chromium 的元素截图只绘制布局视口横向范围内的内容，
   * 视口 1400px 时 2600px 海报会被悄悄裁掉右边 1200px（高度方向则会完整绘制）。
   * 渲染器仍会在测量后自动把视口宽度撑到海报宽度，这里只是省掉一次 resize。
   */
  viewport?: { width: number; height: number };
}

export interface ArcRenderResult {
  buffer: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 渲染出的 HTML（测试断言无残留模板标记用）。 */
  html: string;
  /** 模板数据（测试断言用）。 */
  data: ArcTemplateData;
  diagnostics: {
    assetsDir: string;
    browserPath: string;
    browserSource: BrowserLaunchTarget['source'];
    /** 页面里 Saira 字体是否可用（file:// 字体被 CORS 拦截时是 false）。 */
    fontsReady: boolean;
    /** 曲绘命中的卡片数。 */
    coversFound: number;
    /** 回落到占位图的卡片数。 */
    coversMissing: number;
    /** 截图时的视口宽度（必须 ≥ 海报宽度，否则 Chromium 只绘制视口内的横向部分）。 */
    viewportWidth: number;
    viewportHeight: number;
  };
}

function insertBeforeClosingTag(html: string, tag: string, snippet: string): string {
  const index = html.toLowerCase().lastIndexOf(`</${tag}>`);
  if (index < 0) return `${html}\n${snippet}\n`;
  return `${html.slice(0, index)}${snippet}\n${html.slice(index)}`;
}

/**
 * 追加渲染期修复样式（不影响版式，只消除截图时的浮点误差）。
 *
 * - `html,body` 去掉默认外边距并压掉滚动条占位，避免元素截图的宽高多 1px；
 * - `background-attachment` 固定，避免长页面滚动时背景位移。
 */
export const ARC_OVERRIDES_CSS = `
html,body{margin:0;padding:0;overflow:hidden}
img{max-width:none}
`.trim();

/** 在模板 HTML 的 `</head>` 前注入渲染期 overrides。 */
export function injectOverrides(html: string): string {
  return insertBeforeClosingTag(html, 'head', `<style id="rankhub-arc-overrides">\n${ARC_OVERRIDES_CSS}\n</style>\n`);
}

/** Arcaea B50 渲染器（懒加载 Chromium，可复用；用完记得 `close()`）。 */
export class ArcaeaRenderer {
  private readonly options: ArcaeaRendererOptions;
  private readonly maxImageBytes: number;
  private readonly timeoutMs: number;
  private readonly tempDir: string;
  private assets: ArcAssets | null = null;
  private browser: Browser | null = null;
  private browserTarget: BrowserLaunchTarget | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: ArcaeaRendererOptions = {}) {
    this.options = options;
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.tempDir = options.tempDir ?? join(REPO_ROOT, 'data', 'tmp', 'arc-render');
  }

  /** 素材集合（首次调用时载入并缓存；重跑 fetch 脚本需新建渲染器或清缓存）。 */
  getAssets(): ArcAssets {
    this.assets ??= loadArcAssets(this.options.assetsDir ? { assetsDir: this.options.assetsDir } : {});
    return this.assets;
  }

  /** 渲染 B50 海报，返回 PNG Buffer（超限时可能降级为 JPEG）。 */
  async renderArcaeaB50(input: ArcaeaB50RenderInput): Promise<Buffer> {
    const result = await this.renderDetail(input);
    return result.buffer;
  }

  /** 渲染并返回 HTML / 尺寸 / 诊断信息（测试与排查用）。 */
  async renderDetail(input: ArcaeaB50RenderInput): Promise<ArcRenderResult> {
    const assets = this.getAssets();
    const data = buildArcTemplateData(input, assets, this.options.now ? { now: this.options.now } : {});
    const html = injectOverrides(buildArcPosterHtml(data));
    const htmlPath = await this.writeTempHtml(html);
    try {
      const browser = await this.ensureBrowser();
      const viewport = this.options.viewport ?? { width: POSTER_WIDTH, height: 1200 };
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, locale: 'zh-CN' });
      try {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: this.timeoutMs });
        const fontsReady = await this.waitForRenderReady(page);
        const browserTarget = this.browserTarget;
        if (!browserTarget) throw new Error('Arcaea 渲染器未完成浏览器初始化');

        // 视口宽度不足会让元素截图横向裁切，这里按实测海报宽度兜底撑开。
        const viewportSize = page.viewportSize() ?? viewport;
        const measured = await this.measure(page);
        if (measured.width > viewportSize.width) {
          await page.setViewportSize({ width: measured.width, height: viewportSize.height });
        }
        const effectiveViewport = page.viewportSize() ?? viewport;
        /**
         * 体积降级阶梯（QQ 图片上限约 5MB）：
         *   PNG → JPEG q90 → 整体缩 85% 的 JPEG。
         * 依次收集候选，取第一个落在上限内的；全超限时取体积最小的那个（而不是最后一档，
         * 否则 1MB 上限会拿到比 JPEG 更大的缩放 PNG）。
         */
        const candidates: { buffer: Buffer; format: 'png' | 'jpeg'; width: number; height: number }[] = [];
        const png = await this.screenshot(page, 'png');
        candidates.push({ buffer: png, format: 'png', ...measured });
        if (png.length > this.maxImageBytes) {
          const jpeg = await this.screenshot(page, 'jpeg');
          candidates.push({ buffer: jpeg, format: 'jpeg', ...measured });
          if (jpeg.length > this.maxImageBytes) {
            await page.addStyleTag({ content: 'html { zoom: 0.85; }' });
            const zoomedMeasured = await this.measure(page);
            const zoomed = await this.screenshot(page, 'jpeg');
            candidates.push({ buffer: zoomed, format: 'jpeg', ...zoomedMeasured });
          }
        }
        const chosen =
          candidates.find((candidate) => candidate.buffer.length <= this.maxImageBytes) ??
          candidates.reduce((smallest, candidate) =>
            candidate.buffer.length < smallest.buffer.length ? candidate : smallest,
          );

        return {
          buffer: chosen.buffer,
          format: chosen.format,
          width: chosen.width,
          height: chosen.height,
          html,
          data,
          diagnostics: {
            assetsDir: assets.assetsDir,
            browserPath: browserTarget.executablePath,
            browserSource: browserTarget.source,
            fontsReady,
            coversFound: data.diagnostics.coversFound,
            coversMissing: data.diagnostics.coversMissing,
            viewportWidth: effectiveViewport.width,
            viewportHeight: effectiveViewport.height,
          },
        };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await rm(htmlPath, { force: true }).catch(() => {});
    }
  }

  private async writeTempHtml(html: string): Promise<string> {
    await mkdir(this.tempDir, { recursive: true });
    const digest = createHash('sha1').update(html).digest('hex').slice(0, 16);
    const path = join(this.tempDir, `arc-${process.pid}-${Date.now()}-${digest}.html`);
    await writeFile(path, html, 'utf8');
    return path;
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
        // file:// 页面加载本地字体/图片时避免被当成跨源拦截（与 phi 渲染器一致）。
        '--allow-file-access-from-files',
        '--font-render-hinting=none',
      ],
    });
    this.browser = browser;
    this.browserTarget = target;
    browser.on('disconnected', () => {
      if (this.browser === browser) this.browser = null;
    });
    return browser;
  }

  /** 等字体、曲绘解码与两帧绘制完成。 */
  private async waitForRenderReady(page: Page): Promise<boolean> {
    await page.waitForLoadState('load', { timeout: this.timeoutMs });
    const fontsReady = await page.evaluate(async () => {
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
      try {
        return document.fonts?.check('16px Saira') ?? false;
      } catch {
        return false;
      }
    });
    // 兜底：极端慢机器上字体/图片事件可能延迟。
    await page.waitForTimeout(80);
    return fontsReady;
  }

  private async measure(page: Page): Promise<{ width: number; height: number }> {
    const box = await page.locator('#poster').boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('Arcaea 海报尺寸为空，无法截图');
    }
    return { width: Math.round(box.width), height: Math.round(box.height) };
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
    return page.locator('#poster').screenshot(options);
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

export function createArcaeaRenderer(options: ArcaeaRendererOptions = {}): ArcaeaRenderer {
  return new ArcaeaRenderer(options);
}
