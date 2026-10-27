/**
 * 名片渲染测试素材：用 @napi-rs/canvas **现场生成**占位图，不触网。
 *
 * - banner / 头像 / 卡片背景 / 二维码 全部按固定随机种子生成，结果是确定性的；
 * - 游戏图标优先用 `vendor/card/icons/{game}-icon.png`（仓库已放入，与正式数据同源），
 *   缺失时回退到现场生成的圆形占位图 —— 保证 CI/新克隆没有 vendor 也能跑。
 *
 * 数据约定与 `src/commands/me.ts` 一致：`title` = 玩家名，`subtitle` =「游戏名 · 评分体系」，
 * `rating` 已格式化为展示字符串，`fields` 是 2-4 个统计小块（labels 取自 `src/rankhub/profile.ts`）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';

import type { PlayerCardInput } from '../../src/render/card/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ICON_DIR = join(REPO_ROOT, 'vendor', 'card', 'icons');
const PHIGROS_COVERS_DIR = join(REPO_ROOT, 'vendor', 'covers', 'phigros');
/** 固定取这一首的曲绘作为「App 自定义背景」示例（`background_song_id` 的取值来源）。 */
const PHIGROS_COVER_SONG_ID = 'SURREALISM.Itsuki.0';

/** 确定性 PRNG（mulberry32），用于生成「看起来像二维码」的方块。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 渐变占位图（可叠加几个半透明圆，模拟「有内容」的照片）。 */
export function gradientPng(
  width: number,
  height: number,
  from: string,
  to: string,
  options: { blobs?: boolean; seed?: number } = {},
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (options.blobs) {
    const rand = mulberry32(options.seed ?? 7);
    for (let i = 0; i < 9; i += 1) {
      const radius = Math.min(width, height) * (0.16 + rand() * 0.3);
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + rand() * 0.12})`;
      ctx.arc(rand() * width, rand() * height, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas.toBuffer('image/png');
}

/** 圆形头像占位图（径向渐变 + 外圈，避免依赖字体）。 */
export function avatarPng(size: number, from: string, to: string): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(
    size * 0.35,
    size * 0.3,
    size * 0.05,
    size / 2,
    size / 2,
    size * 0.7,
  );
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = size * 0.05;
  ctx.arc(size / 2, size / 2, size * 0.33, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.arc(size * 0.34, size * 0.32, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toBuffer('image/png');
}

/** 游戏图标占位图：圆底 + 同心环 + 角标方块。 */
export function gameIconPng(size: number, from: string, to: string, seed = 3): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const rand = mulberry32(seed);
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.18 + rand() * 0.18})`;
    ctx.lineWidth = Math.max(2, size * 0.035);
    ctx.arc(size / 2, size / 2, size * (0.28 + i * 0.09), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.beginPath();
  ctx.arc(size * 0.68, size * 0.34, size * 0.08, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toBuffer('image/png');
}

/**
 * 游戏图标：优先读 `vendor/card/icons/<game>-icon.png`（仓库内置的测试 fixture），
 * 缺失时回退到现场生成的占位图。
 */
export function gameIcon(game: 'maimai' | 'phigros' | 'arcaea'): Buffer {
  const vendorPath = join(ICON_DIR, `${game}-icon.png`);
  if (existsSync(vendorPath)) return readFileSync(vendorPath);
  const palette: Record<typeof game, [string, string]> = {
    maimai: ['#ffd0e4', '#ff5f9e'],
    phigros: ['#c7f3ff', '#33b6e6'],
    arcaea: ['#e3d4ff', '#7b5cff'],
  };
  const [from, to] = palette[game];
  return gameIconPng(160, from, to);
}

/**
 * App 的 phigros 卡片背景 = 玩家选中的曲绘（`phigros_player_card.dart:153-156`）。
 * 测试从曲绘缓存（`vendor/covers/phigros`，由 fetch-assets-phi 准备）里取固定一首，
 * 没有缓存时返回 null（卡片走纯色兜底）。
 */
export function phigrosCover(): Buffer | null {
  const indexPath = join(PHIGROS_COVERS_DIR, 'index.json');
  if (!existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      songs?: Record<string, { file?: string | null }>;
    };
    const file = index.songs?.[PHIGROS_COVER_SONG_ID]?.file;
    if (!file) return null;
    const path = join(PHIGROS_COVERS_DIR, file);
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

/** 伪二维码：白底 + 44% 随机黑块 + 三个定位角，尺寸/密度接近真实二维码。 */
export function qrPng(size: number, seed = 20261027): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const margin = Math.round(size * 0.06);
  const modules = 33;
  const cell = (size - margin * 2) / modules;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const isFinder = (row: number, col: number): boolean =>
    (row < 7 && col < 7) ||
    (row < 7 && col >= modules - 7) ||
    (row >= modules - 7 && col < 7);

  const rand = mulberry32(seed);
  ctx.fillStyle = '#0d0f14';
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (isFinder(row, col)) continue;
      if (rand() < 0.44) {
        ctx.fillRect(margin + col * cell, margin + row * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }

  // 三个定位角：7x7 实心 + 5x5 白洞 + 3x3 实心。
  const drawFinder = (row: number, col: number): void => {
    const x = margin + col * cell;
    const y = margin + row * cell;
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(x, y, cell * 7, cell * 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + cell, y + cell, cell * 5, cell * 5);
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(x + cell * 2, y + cell * 2, cell * 3, cell * 3);
  };
  drawFinder(0, 0);
  drawFinder(0, modules - 7);
  drawFinder(modules - 7, 0);
  return canvas.toBuffer('image/png');
}

/** 完整素材：3 个游戏 + 3 张卡片 + banner/头像/二维码，覆盖全部版式分支。 */
export function buildFullCardInput(): PlayerCardInput {
  return {
    displayName: '星野 みなと',
    uid: '100234567',
    bio: '主玩 maimai 与 phigros 的休闲玩家 · 偶尔打 Arcaea · 欢迎来群里对刷',
    banner: gradientPng(1200, 520, '#25406e', '#7b2d5e', { blobs: true, seed: 11 }),
    avatar: avatarPng(320, '#8fb4ff', '#2b3560'),
    games: [
      { name: 'maimai DX', icon: gameIcon('maimai') },
      { name: 'Phigros', icon: gameIcon('phigros') },
      { name: 'Arcaea', icon: gameIcon('arcaea') },
    ],
    cards: [
      {
        // maimai 的 background 恒为 null（`src/rankhub/profile.ts` 里 name_plate 不是图片）：
        // 刻意不传背景，让渲染器使用 App 的默认背景板（vendor/card/backgrounds/maimai.png）。
        game: 'maimai',
        title: '星野 みなと',
        subtitle: 'maimai DX · DX rating',
        rating: '15023',
        avatar: avatarPng(240, '#ffd7e8', '#c8317f'),
        fields: [
          { label: '段位', value: 'SSS' },
          { label: 'CLASS', value: '11' },
          { label: '星级', value: '★ 3' },
        ],
      },
      {
        game: 'phigros',
        title: '星野 みなと',
        subtitle: 'Phigros · Ranking Score',
        rating: '15.4321',
        // App 里 phigros 背景是玩家选的曲绘；没有曲绘缓存时用生成图兜底，保证 CI 也能跑。
        background:
          phigrosCover() ??
          gradientPng(1040, 416, '#0f3548', '#10131d', { blobs: true, seed: 22 }),
        avatar: avatarPng(240, '#c9f5ff', '#127ba3'),
        fields: [
          { label: '课题模式', value: '白 15' },
          { label: '游戏版本', value: 'v3.16.0' },
        ],
      },
      {
        game: 'arcaea',
        title: '星野 みなと',
        subtitle: 'Arcaea · Potential',
        rating: '12.34',
        // 不传背景：渲染器使用 App 内置的 assets/arcaea/bg_light.png（vendor/card/backgrounds/arcaea.png）；
        // 玩家自定义 nameplate 时，/me 会把 nameplate 作为 background 传进来。
        avatar: avatarPng(240, '#e8dcff', '#4b2f9e'),
        fields: [
          { label: 'Best 30 均值', value: '12.10' },
          { label: 'Best 50 均值', value: '11.98' },
          { label: '搭档', value: '光' },
        ],
      },
    ],
    qr: qrPng(420),
  };
}

/** 最小输入：没有 banner / 头像 / 卡片背景 / 二维码，也没有任何游戏与卡片。 */
export function buildMinimalCardInput(): PlayerCardInput {
  return {
    displayName: '匿名玩家',
    uid: null,
    games: [],
    cards: [],
  };
}

/** 缺可选素材但有卡片：rating 为 null、无背景/头像、字段为空，全部走兜底。 */
export function buildSparseCardInput(): PlayerCardInput {
  return {
    displayName: 'Sparse Player',
    uid: '900001',
    bio: null,
    banner: null,
    avatar: null,
    games: [{ name: 'Phigros', icon: gameIcon('phigros') }],
    cards: [
      {
        game: 'phigros',
        title: 'Sparse Player',
        rating: null,
        fields: [],
      },
    ],
    qr: null,
  };
}

/** 超长文案：验证截断与横向不溢出。 */
export function buildLongTextCardInput(): PlayerCardInput {
  const long = '非常长的昵称'.repeat(20);
  return {
    displayName: long,
    uid: '1234567890'.repeat(4),
    bio: '很长的个人简介'.repeat(40),
    games: [{ name: 'maimai'.repeat(6), icon: gameIcon('maimai') }],
    cards: [
      {
        game: 'maimai',
        title: long,
        subtitle: '很长的副标题'.repeat(10),
        rating: '15023150231502315023',
        fields: [
          { label: '标签'.repeat(10), value: '值'.repeat(20) },
          { label: 'B35', value: '14980' },
        ],
      },
    ],
  };
}
