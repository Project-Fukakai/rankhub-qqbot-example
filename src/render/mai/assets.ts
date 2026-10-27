/**
 * maimaiDX 静态资源访问层（@napi-rs/canvas 版）。
 *
 * 资源目录结构（vendor/mai，由 scripts/fetch-assets-mai.mjs 生成）：
 *   pic/        UI_* 素材 + b50_score_* + SD/DX + Name.png + logo.png + prism_plus/ + circle/
 *   cover/      <songId % 10000>.png（缺图回落 0.png）
 *   plate/      0.png（默认名牌）
 *   shougou/    UI_CMN_Shougou_<Color>.png
 *   font/       SIYUAN / TBFONT / FOTNEWRODIN / SHANGGUMONO
 *
 * 字体用 canvas.registerFont（GlobalFonts.registerFromPath），进程内只需注册一次。
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image } from '@napi-rs/canvas';

import type { FontFamily } from './text.js';
import type { MaiTheme } from './constants.js';

/** 字体族 → 资源包内文件名（resources.py 的 SIYUAN/TBFONT/FOTNEWRODIN/SHANGGUMONO）。 */
export const FONT_FILES: Record<FontFamily, string> = {
  SIYUAN: 'ResourceHanRoundedCN-Bold.ttf',
  TBFONT: 'Torus SemiBold.otf',
  FOTNEWRODIN: 'FOT-NewRodin Pro EB.otf',
  SHANGGUMONO: 'ShangguMonoSC-Regular.otf',
};

/**
 * 面积平均（box）重采样。
 *
 * 为什么不用 Skia 的 drawImage 缩放：PIL `Image.resize` 默认是「带抗锯齿的 BICUBIC」，
 * 而 Skia 的 imageSmoothingQuality 没有等价档位。实测 400→75 的曲绘：
 *   high 60% / low 59% 像素超凡差阈值，medium 8%，面积平均 2.1%（vs PIL 参考）。
 * 所以缩小统一走自己的面积平均，放大仍交给 Skia（PIL 放大也只有轻微差异）。
 */
export function areaResizePixels(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor((dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.ceil(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor((dx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.ceil(((dx + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const p = (sy * sw + sx) * 4;
          r += src[p]!;
          g += src[p + 1]!;
          b += src[p + 2]!;
          a += src[p + 3]!;
          n += 1;
        }
      }
      const q = (dy * dw + dx) * 4;
      out[q] = r / n;
      out[q + 1] = g / n;
      out[q + 2] = b / n;
      out[q + 3] = a / n;
    }
  }
  return out;
}

const REQUIRED_FILES = [
  'pic/b50_score_basic.png',
  'pic/Name.png',
  'pic/SD.png',
  'pic/prism_plus/b50.png',
  'pic/prism_plus/logo.png',
  'plate/0.png',
  'shougou/UI_CMN_Shougou_Rainbow.png',
  'font/ResourceHanRoundedCN-Bold.ttf',
  'font/Torus SemiBold.otf',
  'font/FOT-NewRodin Pro EB.otf',
];

/** 常驻解码图片上限（曲绘 640 KB/张，192 张 ≈ 125 MB 上限）。 */
const MAX_CACHED_IMAGES = 192;
/** 缩放结果上限（75×75 级别的 canvas，很小）。 */
const MAX_SCALED_CANVASES = 512;

export class MaiAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaiAssetError';
  }
}

/** 解析静态资源根目录：显式参数 > MAIMAIDX_STATIC > <cwd>/vendor/mai。 */
export function resolveAssetsDir(explicit?: string): string {
  const dir = explicit ?? (process.env.MAIMAIDX_STATIC || '').trim() ?? '';
  const root = dir ? resolve(dir) : resolve(process.cwd(), 'vendor', 'mai');
  return root;
}

let fontsRegistered = false;

/** 注册四个字体（幂等）。缺字体时给出可执行提示，而不是静默降级成默认字体。 */
export function ensureFonts(dir: string): void {
  if (fontsRegistered) return;
  for (const [family, file] of Object.entries(FONT_FILES)) {
    const path = join(dir, 'font', file);
    if (!existsSync(path)) {
      throw new MaiAssetError(
        `缺少字体 ${path}；先运行 \`node scripts/fetch-assets-mai.mjs\`（或设置 MAIMAIDX_STATIC）`,
      );
    }
    if (!GlobalFonts.has(family) && !GlobalFonts.registerFromPath(path, family)) {
      throw new MaiAssetError(`字体注册失败：${path}`);
    }
  }
  fontsRegistered = true;
}

/**
 * 解码图片。
 *
 * 注意：`new Image(); img.src = buffer` 在 @napi-rs/canvas 里能立刻拿到 width/height，
 * 但像素是异步解码的，直接 drawImage 会画成空白 —— 必须 await `loadImage`。
 * 所以 b50 采用「先 preload 再同步绘制」两步走（见 draw.ts collectAssetPaths）。
 */
export async function loadImageFile(path: string): Promise<Image> {
  try {
    return await loadImage(path);
  } catch (error) {
    throw new MaiAssetError(
      `缺少或无法解码资源 ${path}；先运行 \`node scripts/fetch-assets-mai.mjs\`（错误：${(error as Error).message}）`,
    );
  }
}

/** b50 渲染用到的全部素材入口。同一进程内复用（图片/缩放结果都带缓存）。 */
export class MaiAssets {
  readonly dir: string;
  private readonly images = new Map<string, Image>();
  private readonly pending = new Map<string, Promise<Image>>();
  private readonly scaled = new Map<string, Canvas>();
  private readonly scaledOrder: string[] = [];

  constructor(explicitDir?: string) {
    this.dir = resolveAssetsDir(explicitDir);
    const missing = REQUIRED_FILES.filter((rel) => !existsSync(join(this.dir, rel)));
    if (missing.length > 0) {
      throw new MaiAssetError(
        `maimai 静态资源不完整（${this.dir}），缺少：${missing.join(', ')}；` +
          '先运行 `node scripts/fetch-assets-mai.mjs`（或设置 MAIMAIDX_STATIC）',
      );
    }
    ensureFonts(this.dir);
  }

  /** 校验资源目录基本可用（不注册字体、不抛错，供 CLI/测试做前置检查）。 */
  static isReady(dir = resolveAssetsDir()): boolean {
    return REQUIRED_FILES.every((rel) => existsSync(join(dir, rel)));
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }

  /** LRU 命中：把键移到队尾（Map 保持插入序）。 */
  private touch(rel: string): void {
    const img = this.images.get(rel);
    if (!img) return;
    this.images.delete(rel);
    this.images.set(rel, img);
  }

  private evictImages(): void {
    // 曲绘是 400×400 RGBA（约 640 KB/张），必须限制常驻数量，否则长跑进程会被
    // 1681 张曲绘撑爆（~1 GB）。超出后按最久未用淘汰，下次渲染重新解码（~1–2 ms/张）。
    while (this.images.size > MAX_CACHED_IMAGES) {
      const oldest = this.images.keys().next();
      if (oldest.done) break;
      this.images.delete(oldest.value);
    }
  }

  /** 预载一批图片（并行解码），绘制阶段即可同步取用。 */
  async preload(rels: Iterable<string>): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const rel of new Set(rels)) {
      if (this.images.has(rel)) {
        this.touch(rel);
        continue;
      }
      let pending = this.pending.get(rel);
      if (!pending) {
        pending = loadImageFile(this.path(rel));
        this.pending.set(rel, pending);
      }
      tasks.push(
        pending.then((img) => {
          this.images.set(rel, img);
        }),
      );
    }
    await Promise.all(tasks);
    this.evictImages();
  }

  /** 预载后的原图（按路径缓存）。未预载会抛错，避免画空白图。 */
  image(rel: string): Image {
    const cached = this.images.get(rel);
    if (cached) {
      this.touch(rel);
      return cached;
    }
    throw new MaiAssetError(`资源未预载：${rel}（渲染前需 await assets.preload(...)）`);
  }

  /** pic/<name> */
  pic(name: string): Image {
    return this.image(`pic/${name}`);
  }

  /** pic/<theme>/<name> */
  themed(theme: MaiTheme, name: string): Image {
    return this.image(`pic/${theme}/${name}`);
  }

  /** cover/<songId % 10000>.png，缺图回落 cover/0.png。 */
  coverRel(songId: number): string {
    const rel = `cover/${((songId % 10000) + 10000) % 10000}.png`;
    return existsSync(this.path(rel)) ? rel : 'cover/0.png';
  }

  cover(songId: number): Image {
    return this.image(this.coverRel(songId));
  }

  /** 曲绘缩放到 75×75（走面积平均，与参考图最接近）。 */
  scaledCover(songId: number, w: number, h: number): Canvas {
    return this.scaledImage(this.coverRel(songId), w, h);
  }

  /** shougou/<name> */
  shougou(name: string): Image {
    return this.image(`shougou/${name}`);
  }

  /** plate/<name>，缺图回落 plate/0.png。 */
  plate(name: string): Image {
    const rel = `plate/${name}`;
    if (existsSync(this.path(rel))) return this.image(rel);
    return this.image('plate/0.png');
  }

  /**
   * 缩放到 w×h 的离屏 canvas（带缓存）。
   *
   * PIL 的 `Image.resize` 默认 BICUBIC；这里用 Skia 的 imageSmoothingQuality='high'
   * 做等价降采样，结果与参考图的差异已纳入 spike 的像素差基线与测试阈值。
   */
  scaledImage(rel: string, w: number, h: number): Canvas {
    const key = `${rel}@${w}x${h}`;
    const cached = this.scaled.get(key);
    if (cached) return cached;

    const img = this.image(rel);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');

    if (img.width >= w * 1.5 || img.height >= h * 1.5) {
      // 缩小：用面积平均，贴近 PIL 的 antialias-bicubic
      const source = createCanvas(img.width, img.height);
      const sourceCtx = source.getContext('2d');
      sourceCtx.drawImage(img, 0, 0);
      const src = sourceCtx.getImageData(0, 0, img.width, img.height).data;
      const pixels = areaResizePixels(src, img.width, img.height, w, h);
      const imageData = ctx.createImageData(w, h);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
    }

    this.scaled.set(key, canvas);
    this.scaledOrder.push(key);
    // 简单 FIFO 上限：b50 单图约 60 张缩放结果，跨请求再复用一批
    while (this.scaledOrder.length > MAX_SCALED_CANVASES) {
      const oldest = this.scaledOrder.shift();
      if (oldest) this.scaled.delete(oldest);
    }
    return canvas;
  }

  /** 资源目录大小（字节，供诊断）。 */
  sizeBytes(): number {
    let total = 0;
    for (const rel of REQUIRED_FILES) {
      try {
        total += statSync(this.path(rel)).size;
      } catch {
        // 忽略
      }
    }
    return total;
  }
}
