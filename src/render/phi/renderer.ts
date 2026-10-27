/**
 * phi-plugin b19 渲染器：art-template 渲染 `b19.art` → 临时 HTML → 本机 Chromium 截图。
 *
 * 版式/字体/CSS 全部来自 `vendor/phi`（phi-plugin 固定 commit），本文件只负责：
 * 1. 让 `{{extend defaultLayout}}` 生效（art-template 需要按文件名加载模板）；
 * 2. 注入少量 overrides（隐藏 RankHub 输入里没有数据的块）；
 * 3. 等字体/图片就绪后用 playwright-core 截取 body 元素。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import template from 'art-template';
import { chromium, type Browser, type Page } from 'playwright-core';

import type {
  MaimaiB50RenderInput,
  PhigrosRksRenderInput,
  Renderer,
} from '../../contracts/index.js';
import {
  findBrowserExecutable,
  loadAssets,
  REPO_ROOT,
  type BrowserLaunchTarget,
  type PhiAssets,
} from './assets.js';
import { buildPhiTemplateData, type PhiTemplateData } from './data.js';

/** QQ 图片上限约 5MB，留 0.5MB 余量。 */
export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

/**
 * RankHub 输入没有的字段只做「视觉隐藏」：一律用 `visibility: hidden` 而不是 `display: none`。
 *
 * 原因：b19.css 里这些都是正常排版的一部分（`.clgBox` / `.rks` 是 `.playerInfo` 的子项，
 * `.suggest` 与 `.acc` 平分 `.acc-box`），`display: none` 会把它们从布局里摘掉，
 * 进而挤动相邻元素（实测 `.suggest` 一摘，准确率就会离开上游位置；`.clgBox` 虽然本身是
 * absolute 不受影响，但保留布局更稳）。保留盒子、隐藏像素，版式与 phi-plugin 完全一致。
 *
 * - recordInfo：逐难度 cleared / FC / phi 统计（RankHub 契约里没有）
 * - clgBox：挑战模式等级（无数据）
 * - suggest：推分建议（无数据）
 * - spInfoBox：版本提示（空）
 */
export const PHI_OVERRIDES_CSS = `
/* RankHub 注入：仅隐藏输入中不存在的数据块的像素，保留其布局占位；其余样式全部沿用 phi-plugin b19.css */
.recordInfo, .whiteLine { visibility: hidden !important; }
.clgBox { visibility: hidden !important; }
.suggest { visibility: hidden !important; }
.spInfoBox:not(:has(.spInfo)) { visibility: hidden !important; }
`.trim();

export interface PhiRendererOptions {
  /** phi-plugin `resources` 目录（默认 `vendor/phi/resources`，可用 PHI_PLUGIN_RES 覆盖）。 */
  resourcesDir?: string;
  /** 曲绘缓存目录（默认 `vendor/covers/phigros`，可用 PHI_COVERS_DIR 覆盖）。 */
  coversDir?: string;
  /** Chromium 可执行文件（默认 RENDER_BROWSER_PATH / playwright 缓存）。 */
  browserPath?: string;
  /** 模板主题，phi-plugin 默认 `star`；传 `default` 时用默认背景。 */
  theme?: string;
  /** 渲染时间（测试固定时间用）。 */
  now?: Date;
  /** 页面加载/截图超时（ms）。 */
  timeoutMs?: number;
  /** PNG 超过该字节数时降级为 JPEG quality 90。 */
  maxImageBytes?: number;
  /** 临时 HTML 目录（默认 `<repo>/data/tmp/phi-render`）。 */
  tempDir?: string;
}

export interface PhiRenderResult {
  buffer: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 渲染出的 HTML（测试断言无残留模板标记用）。 */
  html: string;
  /** 模板数据（测试断言用）。 */
  data: PhiTemplateData;
  /** 模板/浏览器来源，便于排查部署问题。 */
  diagnostics: {
    templateFile: string;
    browserPath: string;
    browserSource: BrowserLaunchTarget['source'];
    /** 页面里 PHI / Aldrich 字体是否可用（file:// 字体被 CORS 拦截时会是 false）。 */
    fontsReady: boolean;
  };
}

function insertBeforeClosingTag(html: string, tag: string, snippet: string): string {
  const index = html.toLowerCase().lastIndexOf(`</${tag}>`);
  if (index < 0) return `${html}\n${snippet}\n`;
  return `${html.slice(0, index)}${snippet}\n${html.slice(index)}`;
}

/** 在模板 HTML 的 </head> 前注入 overrides 样式。 */
export function injectOverrides(html: string): string {
  return insertBeforeClosingTag(
    html,
    'head',
    `    <style id="rankhub-phi-overrides">\n${PHI_OVERRIDES_CSS}\n    </style>\n`,
  );
}

/**
 * phi-plugin b19 渲染器。
 *
 * 只负责 phigros；maimai 由 `src/render/mai` 负责。`renderMaimaiB50` 显式抛错，
 * 避免与 `src/render/mai` 的渲染器一起被误装配成「悄悄缺功能」的 Renderer
 * （装配层 `src/bot/renderer.ts` 会分别调用各自的方法）。
 */
export class PhigrosRenderer implements Renderer {
  private readonly options: PhiRendererOptions;
  private readonly maxImageBytes: number;
  private readonly timeoutMs: number;
  private readonly tempDir: string;
  private assets: PhiAssets | null = null;
  private templateCache: { path: string; mtimeMs: number; source: string } | null = null;
  private browser: Browser | null = null;
  private browserTarget: BrowserLaunchTarget | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: PhiRendererOptions = {}) {
    this.options = options;
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.tempDir = options.tempDir ?? join(REPO_ROOT, 'data', 'tmp', 'phi-render');
  }

  private getAssets(): PhiAssets {
    this.assets ??= loadAssets({
      ...(this.options.resourcesDir ? { resourcesDir: this.options.resourcesDir } : {}),
      ...(this.options.coversDir ? { coversDir: this.options.coversDir } : {}),
    });
    return this.assets;
  }

  /** 渲染 phigros `/rks` 图片（b19 版式）。 */
  async renderPhigrosRks(input: PhigrosRksRenderInput): Promise<Buffer> {
    const result = await this.renderDetail(input);
    return result.buffer;
  }

  async renderMaimaiB50(): Promise<Buffer> {
    throw new Error(
      'PhigrosRenderer 不实现 maimai 渲染；请使用 src/render/mai 的渲染器，或在装配层把两种渲染器组合成 Renderer。',
    );
  }

  /** 渲染并返回 HTML / 尺寸 / 诊断信息（测试与排查用）。 */
  async renderDetail(input: PhigrosRksRenderInput): Promise<PhiRenderResult> {
    const assets = this.getAssets();
    const data = buildPhiTemplateData(input, assets, {
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.theme ? { theme: this.options.theme } : {}),
    });

    const html = this.renderHtml(assets, data);
    const htmlPath = await this.writeTempHtml(html);
    try {
      const browser = await this.ensureBrowser();
      const page = await browser.newPage({
        viewport: { width: 1400, height: 1200 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
      });
      try {
        await page.goto(pathToFileURL(htmlPath).href, {
          waitUntil: 'load',
          timeout: this.timeoutMs,
        });
        const fontsReady = await this.waitForRenderReady(page);
        const pageTarget = this.browserTarget!;
        const measured = await this.measure(page);
        let buffer = await this.screenshot(page, 'png');
        let format: 'png' | 'jpeg' = 'png';
        let width = measured.width;
        let height = measured.height;

        if (buffer.length > this.maxImageBytes) {
          buffer = await this.screenshot(page, 'jpeg');
          format = 'jpeg';
        }
        // 极端情况（全屏曲绘、超长列表）：缩小 15% 再截一次 PNG。
        if (buffer.length > this.maxImageBytes) {
          await page.addStyleTag({ content: 'html { zoom: 0.85; }' });
          const zoomed = await this.measure(page);
          buffer = await this.screenshot(page, 'png');
          format = 'png';
          width = zoomed.width;
          height = zoomed.height;
        }

        return {
          buffer,
          format,
          width,
          height,
          html,
          data,
          diagnostics: {
            templateFile: assets.b19Template,
            browserPath: pageTarget.executablePath,
            browserSource: pageTarget.source,
            fontsReady,
          },
        };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await rm(htmlPath, { force: true }).catch(() => {});
    }
  }

  /**
   * 读取模板源码（按 mtime 缓存），并把 phi-plugin 里残留的 art-template 旧版语法
   * `{{#value}}` 归一成 `{{@value}}`。
   *
   * 两者语义完全一致（art-template 4 内部就是把 `#` 当 raw 输出并打一条升级 warning），
   * 这里只改写内存中的源码、不动 `vendor/phi` 文件，作用是避免每次渲染都往 stderr 打 warning。
   */
  private loadTemplateSource(path: string): string {
    const mtimeMs = statSync(path).mtimeMs;
    if (this.templateCache?.path === path && this.templateCache.mtimeMs === mtimeMs) {
      return this.templateCache.source;
    }
    const source = readFileSync(path, 'utf8').replace(/\{\{#/g, '{{@');
    this.templateCache = { path, mtimeMs, source };
    return source;
  }

  /**
   * 用 art-template 渲染：`render(source, data, { filename })`。
   *
   * `options.filename` 必须是模板的绝对路径，`{{extend defaultLayout}}` /
   * `{{include ...}}` 才能解析子模板（defaultLayout 本身由数据传入绝对路径）。
   */
  private renderHtml(assets: PhiAssets, data: PhiTemplateData): string {
    const rendered = template.render(this.loadTemplateSource(assets.b19Template), data, {
      filename: assets.b19Template,
      cache: false,
    });
    if (typeof rendered !== 'string') throw new Error('art-template 渲染结果不是字符串');
    return injectOverrides(rendered);
  }

  private async writeTempHtml(html: string): Promise<string> {
    await mkdir(this.tempDir, { recursive: true });
    const digest = createHash('sha1').update(html).digest('hex').slice(0, 16);
    const path = join(this.tempDir, `b19-${process.pid}-${Date.now()}-${digest}.html`);
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
        // file:// 页面加载本地字体/图片时避免被当成跨源拦截。
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

  /** 等字体、图片与 b19 的自动字号调整脚本全部跑完。 */
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
      // template 的 adjustFontSize 挂在 document.fonts.ready 上，再等一帧让它落定。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try {
        return document.fonts?.check('16px PHI') ?? false;
      } catch {
        return false;
      }
    });
    // 兜底：极端慢机器上字体/图片事件可能延迟。
    await page.waitForTimeout(80);
    return fontsReady;
  }

  private async measure(page: Page): Promise<{ width: number; height: number }> {
    const box = await page.locator('body').boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('b19 页面尺寸为空，无法截图');
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

export function createPhigrosRenderer(options: PhiRendererOptions = {}): PhigrosRenderer {
  return new PhigrosRenderer(options);
}

/** 仅用于日志：确认素材路径存在。 */
export function describeAssets(options: { resourcesDir?: string; coversDir?: string } = {}): {
  resourcesDir: string;
  coversDir: string;
  songs: number;
  templateExists: boolean;
} {
  const assets = loadAssets(options);
  return {
    resourcesDir: assets.resourcesDir,
    coversDir: assets.coversDir,
    songs: Object.keys(assets.songs.songs).length,
    templateExists: existsSync(assets.b19Template),
  };
}
