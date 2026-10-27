/**
 * maimai b50 渲染测试/Fixture 公共工具。
 *
 * - 把 test/render/mai/fixtures/b50-fixture.json 转成契约输入（MaimaiB50RenderInput）
 * - PNG 解码与逐像素差异（同尺寸、逐通道阈值）
 *
 * 这个文件同时被 vitest 用例和 spike 采样 CLI（tools/render-sample.ts）复用，
 * 保证「人工看的图」与「自动化断言的图」是同一套输入。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, loadImage } from '@napi-rs/canvas';

import type { GameScore, MaimaiB50RenderInput } from '../../../src/contracts/index.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const FIXTURE_PATH = join(HERE, 'fixtures', 'b50-fixture.json');
export const ASSETS_DIR = join(REPO_ROOT, 'vendor', 'mai');
export const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'qqbot', 'render');

interface FixtureRow {
  song_id: number;
  song_name: string;
  type: 'SD' | 'DX';
  level_index: number;
  level: string;
  level_value: number;
  rating: number;
  achievements: number;
  rate: string;
  fc: string | null;
  fs: string | null;
  dx_score: number;
  max_dx_score: number;
}

export interface FixtureSample {
  id: string;
  note: string;
  theme: 'prism_plus' | 'circle';
  service: string;
  player: {
    qqid: number | null;
    name: string;
    rating: number;
    course_rank: number;
    class_rank: number;
    trophy: { id: number; name: string; color: string } | null;
  };
  sd: FixtureRow[];
  dx: FixtureRow[];
}

export interface Fixture {
  totals: { sd: number; dx: number };
  counts: { sd: number; dx: number };
  samples: FixtureSample[];
}

let cachedFixture: Fixture | null = null;

export function loadFixture(): Fixture {
  if (!cachedFixture) {
    cachedFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  }
  return cachedFixture;
}

export function sampleOf(id: string): FixtureSample {
  const sample = loadFixture().samples.find((item) => item.id === id);
  if (!sample) throw new Error(`fixture 里没有样例 ${id}`);
  return sample;
}

/** fixture 行 → 契约 GameScore（模拟 RankHub getBests 的返回）。 */
export function toGameScore(row: FixtureRow): GameScore {
  return {
    scoreId: `${row.song_id}-${row.level_index}`,
    songId: String(row.song_id),
    songName: row.song_name,
    type: row.type.toLowerCase(),
    difficulty: ['basic', 'advanced', 'expert', 'master', 'remaster'][row.level_index] ?? null,
    levelIndex: row.level_index,
    level: row.level,
    achievements: row.achievements,
    score: null,
    rating: row.rating,
    rank: row.rate,
    dxScore: row.dx_score,
    dxStar: null,
    fc: row.fc,
    fs: row.fs,
    playTime: null,
    native: null,
  };
}

/** fixture 样例 → 契约输入（latest=15 / archive=35）。 */
export function toRenderInput(sample: FixtureSample): MaimaiB50RenderInput & {
  courseRank: number;
  classRank: number;
  trophy: { name: string; color: string } | null;
  theme: 'prism_plus' | 'circle';
} {
  return {
    profileName: sample.player.name,
    rating: sample.player.rating,
    buckets: [
      { key: 'latest', label: 'B15', total: sample.dx.length, items: sample.dx.map(toGameScore) },
      { key: 'archive', label: 'B35', total: sample.sd.length, items: sample.sd.map(toGameScore) },
    ],
    totals: { b35: sample.sd.reduce((sum, row) => sum + row.rating, 0), b15: sample.dx.reduce((sum, row) => sum + row.rating, 0) },
    computedAt: '2026-10-27T00:00:00.000Z',
    courseRank: sample.player.course_rank,
    classRank: sample.player.class_rank,
    trophy: sample.player.trophy ? { name: sample.player.trophy.name, color: sample.player.trophy.color } : null,
    theme: sample.theme,
  };
}

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 解码 PNG 为 RGBA 像素（@napi-rs/canvas 无 DOM ImageData 依赖）。 */
export async function decodePng(buffer: Buffer): Promise<DecodedImage> {
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(data) };
}

export interface PixelDiff {
  width: number;
  height: number;
  /** 任一通道差值 > threshold 的像素数。 */
  changed: number;
  total: number;
  /** changed / total。 */
  ratio: number;
  /** 最大通道差。 */
  maxDelta: number;
  /** 平均通道差（仅统计 changed 像素）。 */
  meanDeltaOnChanged: number;
}

/**
 * 逐像素差异：同尺寸、逐通道阈值 16（spike 判定口径）。
 * 尺寸不一致直接抛错（b50 尺寸是固定的 1400×1600）。
 */
export function pixelDiff(
  a: DecodedImage,
  b: DecodedImage,
  threshold = 16,
): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  const total = a.width * a.height;
  let changed = 0;
  let maxDelta = 0;
  let sumChanged = 0;
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    const dr = Math.abs(a.data[p]! - b.data[p]!);
    const dg = Math.abs(a.data[p + 1]! - b.data[p + 1]!);
    const db = Math.abs(a.data[p + 2]! - b.data[p + 2]!);
    const da = Math.abs(a.data[p + 3]! - b.data[p + 3]!);
    const delta = Math.max(dr, dg, db, da);
    if (delta > maxDelta) maxDelta = delta;
    if (delta > threshold) {
      changed += 1;
      sumChanged += delta;
    }
  }
  return {
    width: a.width,
    height: a.height,
    changed,
    total,
    ratio: changed / total,
    maxDelta,
    meanDeltaOnChanged: changed === 0 ? 0 : sumChanged / changed,
  };
}

// ───────────────────────── 结构性对比指标（spike 验收口径） ─────────────────────────

/** 头部区域：y < 230（b50 背景 + logo/名牌/头像/rating 牌/称号条/页脚之外的头部文字）。 */
export const HEADER_REGION = { x: 0, y: 0, w: 1400, h: 230 } as const;
/** 页脚区域：y ≥ 1520（页脚署名与数据源文案允许不同，只记录不设阈值）。 */
export const FOOTER_REGION = { x: 0, y: 1520, w: 1400, h: 80 } as const;
/** 单卡尺寸（b50_score_*.png 原生 264×109）。 */
export const CARD_SIZE = { w: 264, h: 109 } as const;
/** 成绩卡网格：与 src/render/mai/constants.ts GRID 一致。 */
export const CARD_GRID = {
  startX: 16,
  sdInitialY: 235,
  dxInitialY: 1085,
  gap: 114,
  step: 276,
  cols: 5,
  sdRows: 7,
  dxRows: 3,
} as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 区域像素差（超界自动裁剪）。 */
export function regionDiff(
  a: DecodedImage,
  b: DecodedImage,
  rect: Rect,
  threshold = 16,
): PixelDiff {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(a.width, rect.x + rect.w);
  const y1 = Math.min(a.height, rect.y + rect.h);
  let changed = 0;
  let total = 0;
  let maxDelta = 0;
  let sumChanged = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * a.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[p]! - b.data[p]!),
        Math.abs(a.data[p + 1]! - b.data[p + 1]!),
        Math.abs(a.data[p + 2]! - b.data[p + 2]!),
        Math.abs(a.data[p + 3]! - b.data[p + 3]!),
      );
      total += 1;
      if (d > maxDelta) maxDelta = d;
      if (d > threshold) {
        changed += 1;
        sumChanged += d;
      }
    }
  }
  return {
    width: x1 - x0,
    height: y1 - y0,
    changed,
    total,
    ratio: total === 0 ? 1 : changed / total,
    maxDelta,
    meanDeltaOnChanged: changed === 0 ? 0 : sumChanged / changed,
  };
}

/** 全部 50 张成绩卡的区域（sd 35 张 + dx 15 张）。 */
export function cardRects(): Rect[] {
  const rects: Rect[] = [];
  for (let i = 0; i < CARD_GRID.sdRows * CARD_GRID.cols; i += 1) {
    const row = Math.floor(i / CARD_GRID.cols);
    const col = i % CARD_GRID.cols;
    rects.push({
      x: CARD_GRID.startX + col * CARD_GRID.step,
      y: CARD_GRID.sdInitialY + row * CARD_GRID.gap,
      w: CARD_SIZE.w,
      h: CARD_SIZE.h,
    });
  }
  for (let i = 0; i < CARD_GRID.dxRows * CARD_GRID.cols; i += 1) {
    const row = Math.floor(i / CARD_GRID.cols);
    const col = i % CARD_GRID.cols;
    rects.push({
      x: CARD_GRID.startX + col * CARD_GRID.step,
      y: CARD_GRID.dxInitialY + row * CARD_GRID.gap,
      w: CARD_SIZE.w,
      h: CARD_SIZE.h,
    });
  }
  return rects;
}

/** 单张成绩卡差异的最大值（遍历 50 张卡，返回最差那张的指标与位置）。 */
export function worstCardDiff(
  a: DecodedImage,
  b: DecodedImage,
  threshold = 16,
): { rect: Rect; index: number; diff: PixelDiff } {
  const rects = cardRects();
  let worst = { rect: rects[0]!, index: 0, diff: regionDiff(a, b, rects[0]!, threshold) };
  rects.forEach((rect, index) => {
    const diff = regionDiff(a, b, rect, threshold);
    if (diff.ratio > worst.diff.ratio) worst = { rect, index, diff };
  });
  return worst;
}

/**
 * 全局平移检测：在 dx,dy ∈ {-1,0,1} 内找平均绝对差最小的位移。
 * 若最优位移不是 (0,0) 且明显优于 (0,0)，说明移植实现整体偏移了。
 */
export function bestShift(
  a: DecodedImage,
  b: DecodedImage,
  step = 3,
): { dx: number; dy: number; score: number; zeroScore: number } {
  let best = { dx: 0, dy: 0, score: Number.POSITIVE_INFINITY, zeroScore: Number.POSITIVE_INFINITY };
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      let sum = 0;
      let count = 0;
      for (let y = 4; y < a.height - 4; y += step) {
        for (let x = 4; x < a.width - 4; x += step) {
          const pa = ((y + dy) * a.width + (x + dx)) * 4;
          const pb = (y * b.width + x) * 4;
          sum +=
            Math.abs(a.data[pa]! - b.data[pb]!) +
            Math.abs(a.data[pa + 1]! - b.data[pb + 1]!) +
            Math.abs(a.data[pa + 2]! - b.data[pb + 2]!);
          count += 3;
        }
      }
      const score = sum / count;
      if (dx === 0 && dy === 0) best.zeroScore = score;
      if (score < best.score) best = { dx, dy, score, zeroScore: best.zeroScore };
    }
  }
  return { ...best, zeroScore: best.zeroScore };
}
