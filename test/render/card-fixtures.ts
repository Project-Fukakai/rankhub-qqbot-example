/**
 * 名片渲染测试素材：用 @napi-rs/canvas **现场生成**占位图，不触网。
 *
 * - banner / 头像 / 曲绘 / 立绘 / 二维码 全部按固定随机种子生成，结果是确定性的；
 * - 游戏图标优先用 `vendor/card/icons/{game}-icon.png`（仓库已放入，与正式数据同源），
 *   缺失时回退到现场生成的圆形占位图 —— 保证 CI/新克隆没有 vendor 也能跑；
 * - 三张卡的数据形状严格按冻结契约 `src/contracts/index.ts` 的判别联合：
 *   maimai（rating/b35/b15/头像/背景板/最近同步）、phigros（rks/课题模式/难度/达成统计/
 *   曲绘）、arcaea（potential/b50/b10/头像/立绘/最近同步）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';

import type {
  PhigrosDifficulty,
  PlayerCardArcaeaCardData,
  PlayerCardInput,
  PlayerCardMaimaiCardData,
  PlayerCardPhigrosCardData,
} from '../../src/render/card/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ICON_DIR = join(REPO_ROOT, 'vendor', 'card', 'icons');
const PHIGROS_COVERS_DIR = join(REPO_ROOT, 'vendor', 'covers', 'phigros');
/** 固定取这一首的曲绘作为 phigros 卡片背景示例（`backgroundSongId` 的取值来源）。 */
const PHIGROS_COVER_SONG_ID = 'SURREALISM.Itsuki.0';
/** 测试用固定同步时间：UTC ISO → 期望展示为 Asia/Shanghai 的 2026-10-27 21:05。 */
export const FIXTURE_SYNCED_AT = '2026-10-27T13:05:00.000Z';
export const FIXTURE_SYNCED_DISPLAY = '2026-10-27 21:05';

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
 * 没有缓存时返回 null（卡片走 App 的 grey900 纯色兜底）。
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

// ─────────────────────────────── 卡片 fixture ───────────────────────────────

/** maimai：15023 → DX Rating 徽章第 11 档（App `_assetIndex`）。 */
export function maimaiCard(overrides: Partial<PlayerCardMaimaiCardData> = {}): PlayerCardMaimaiCardData {
  const card: PlayerCardMaimaiCardData = {
    game: 'maimai',
    name: '星野 みなと',
    rating: 15023,
    b35Rating: 14980,
    b15Rating: 15080,
    avatar: avatarPng(240, '#ffd7e8', '#c8317f'),
    lastSyncedAt: FIXTURE_SYNCED_AT,
    ...overrides,
  };
  return card;
}

/** phigros：RKS 15.4321、课题模式 415（4 段位 + 15）、IN 难度统计。 */
export function phigrosCard(overrides: Partial<PlayerCardPhigrosCardData> = {}): PlayerCardPhigrosCardData {
  const card: PlayerCardPhigrosCardData = {
    game: 'phigros',
    name: '星野 みなと',
    rks: 15.4321,
    challengeModeRank: 415,
    avatar: avatarPng(240, '#c9f5ff', '#127ba3'),
    background:
      phigrosCover() ??
      gradientPng(1120, 1120, '#0f3548', '#10131d', { blobs: true, seed: 22 }),
    difficulty: 'IN',
    achievements: { played: 120, clear: 98, fc: 64, phi: 3 },
    ...overrides,
  };
  return card;
}

/** arcaea：PTT 12.34（rating 图标第 5 档）、B50 12.10 / B10 11.98、1080 立绘。 */
export function arcaeaCard(overrides: Partial<PlayerCardArcaeaCardData> = {}): PlayerCardArcaeaCardData {
  const card: PlayerCardArcaeaCardData = {
    game: 'arcaea',
    name: '星野 みなと',
    potential: 12.34,
    b50Avg: 12.1,
    b10Avg: 11.98,
    avatar: avatarPng(240, '#e8dcff', '#4b2f9e'),
    characterArtwork: gradientPng(1080, 1080, '#3b2a63', '#120c22', {
      blobs: true,
      seed: 33,
    }),
    lastSyncedAt: FIXTURE_SYNCED_AT,
    ...overrides,
  };
  return card;
}

/** 完整素材：3 个游戏 + 3 张卡片 + banner/头像/二维码，覆盖三套 App 版式。 */
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
    cards: [maimaiCard(), phigrosCard(), arcaeaCard()],
    qr: qrPng(420),
  };
}

/** 最小输入：没有 banner / 头像 / 卡片 / 二维码，也没有任何游戏。 */
export function buildMinimalCardInput(): PlayerCardInput {
  return {
    displayName: '匿名玩家',
    uid: null,
    games: [],
    cards: [],
  };
}

/**
 * 稀疏数据：三张卡但 rating/potential 为 null、没有头像/曲绘/立绘/背景板，
 * 全部走 App 的 `--` / 纯色 / person 图标兜底。
 */
export function buildSparseCardInput(): PlayerCardInput {
  return {
    displayName: 'Sparse Player',
    uid: '900001',
    bio: null,
    banner: null,
    avatar: null,
    games: [{ name: 'maimai', icon: gameIcon('maimai') }],
    cards: [
      {
        game: 'maimai',
        name: '',
        rating: null,
        b35Rating: null,
        b15Rating: null,
        lastSyncedAt: null,
      },
      {
        game: 'phigros',
        name: 'Sparse Player',
        rks: null,
        challengeModeRank: 0,
        difficulty: 'AT',
        achievements: { played: 0, clear: 0, fc: 0, phi: 0 },
      },
      {
        game: 'arcaea',
        name: 'Sparse Player',
        potential: null,
        b50Avg: null,
        b10Avg: null,
        lastSyncedAt: null,
      },
    ],
    qr: null,
  };
}

/** 超长文案：验证截断与横向不溢出（名字走 FittedBox 等价缩放，bio 走 CSS 截断）。 */
export function buildLongTextCardInput(): PlayerCardInput {
  const long = '非常长的昵称'.repeat(20);
  return {
    displayName: long,
    uid: '1234567890'.repeat(4),
    bio: '很长的个人简介'.repeat(40),
    games: [{ name: 'maimai'.repeat(6), icon: gameIcon('maimai') }],
    cards: [
      { ...maimaiCard(), name: long, b35Rating: 14980 },
      { ...phigrosCard(), name: long },
      { ...arcaeaCard(), name: long },
    ] as PlayerCardInput['cards'],
  };
}

/** 单张 phigros 卡（难度颜色测试用）。 */
export function buildPhigrosDifficultyCard(difficulty: PhigrosDifficulty): PlayerCardInput {
  return {
    displayName: 'Difficulty Test',
    uid: '1',
    games: [],
    cards: [phigrosCard({ difficulty })],
  };
}

/** 单张 maimai 卡（调用方动态背景板覆盖静态 frame 的测试用）。 */
export function buildMaimaiFrameCard(): PlayerCardInput {
  return {
    displayName: 'Frame Test',
    uid: '1',
    games: [],
    cards: [
      maimaiCard({
        frame: gradientPng(1080, 452, '#3d1e2c', '#0e0a12', { blobs: true, seed: 5 }),
      }),
    ],
  };
}

// ───────────────────────────── 自定义素材（task-8） ─────────────────────────────

/**
 * 生成一张「一眼能看出是自定义素材」的高对比占位图：
 * 斜条纹 + 左上角实色标签块 + 右下角大圆点，标签文字只为人工看图时辨认。
 * 颜色/布局与任何 App 默认素材都不相同，便于测试断言「自定义真的覆盖了默认」。
 */
function customMarkerPng(
  width: number,
  height: number,
  options: {
    from: string;
    to: string;
    accent: string;
    label: string;
    seed?: number;
  },
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, options.from);
  gradient.addColorStop(1, options.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // 45° 斜条纹（固定间隔，不随尺寸抖动）。
  const stripe = Math.max(24, Math.round(Math.min(width, height) * 0.045));
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  const span = Math.ceil(Math.hypot(width, height));
  for (let x = -span; x < span; x += stripe * 2) {
    ctx.fillRect(x, -span, stripe, span * 2);
  }
  ctx.restore();

  // 左上角实色标签块 + 文字（文字只是标记，测试不依赖字体度量）。
  const tagHeight = Math.max(48, Math.round(height * 0.14));
  const tagWidth = Math.min(width, Math.max(240, Math.round(width * 0.62)));
  ctx.fillStyle = options.accent;
  ctx.fillRect(0, 0, tagWidth, tagHeight);
  ctx.fillStyle = '#101014';
  ctx.font = `bold ${Math.round(tagHeight * 0.5)}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(options.label, Math.round(tagHeight * 0.25), Math.round(tagHeight / 2));

  // 右下角大圆点（高对比，便于抽样像素）。
  const radius = Math.min(width, height) * 0.18;
  const rand = mulberry32(options.seed ?? 77);
  ctx.beginPath();
  ctx.fillStyle = options.accent;
  ctx.globalAlpha = 0.9;
  ctx.arc(width - radius - width * 0.04, height - radius - height * 0.05, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // 几个小色块，避免「大片纯色」被压缩算法抹平。
  for (let i = 0; i < 6; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? options.accent : 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(rand() * width * 0.5, height * 0.55 + rand() * height * 0.35, width * 0.06, height * 0.04);
  }
  return canvas.toBuffer('image/png');
}

/** 自定义 maimai 背景板（明显不同于 App frame 455203 / 任何纯色兜底）。 */
export function customMaimaiFrame(): Buffer {
  return customMarkerPng(1080, 452, {
    from: '#ff2d75',
    to: '#1b0a3c',
    accent: '#ffd400',
    label: 'CUSTOM FRAME',
    seed: 101,
  });
}

/** 自定义 phigros 曲绘（明显不同于默认曲绘缓存 / grey900 纯色）。 */
export function customPhigrosCover(): Buffer {
  return customMarkerPng(1120, 1120, {
    from: '#00d5ff',
    to: '#3b0764',
    accent: '#ff5d00',
    label: 'CUSTOM COVER',
    seed: 202,
  });
}

/** 自定义 arcaea 立绘（1080×1080，明显不同于默认 bg_light / 纯色）。 */
export function customArcaeaArtwork(): Buffer {
  return customMarkerPng(1080, 1080, {
    from: '#7cff00',
    to: '#00121f',
    accent: '#ff00c8',
    label: 'CUSTOM ART',
    seed: 303,
  });
}

/** 自定义 arcaea 头像（「名片板」位置）：棋盘格 + 高对比色，明显不同于 person 占位。 */
export function customArcaeaAvatar(): Buffer {
  const size = 240;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cell = size / 12;
  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      ctx.fillStyle = (row + column) % 2 === 0 ? '#00e5ff' : '#240046';
      ctx.fillRect(column * cell, row * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
  ctx.fillStyle = '#ffea00';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toBuffer('image/png');
}
