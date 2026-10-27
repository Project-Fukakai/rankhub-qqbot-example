/**
 * 名片渲染测试素材：用 @napi-rs/canvas **现场生成**占位图（不依赖 `vendor/` 素材、不触网）。
 *
 * 生成的 banner / 头像 / 游戏图标 / 卡片背景 / 二维码都是确定性的（固定随机种子），
 * 保证同一份代码在任何机器上渲染出的版式一致、可对比。
 */
import { createCanvas } from '@napi-rs/canvas';

import type { PlayerCardInput } from '../../src/render/card/index.js';

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
  const gradient = ctx.createRadialGradient(size * 0.35, size * 0.3, size * 0.05, size / 2, size / 2, size * 0.7);
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

/** 伪二维码：白底 + 45% 随机黑块 + 三个定位角，尺寸/密度接近真实二维码。 */
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

/** 完整素材：3 个游戏 + 3 张卡片 + banner/头像/背景/二维码，覆盖全部版式分支。 */
export function buildFullCardInput(): PlayerCardInput {
  return {
    displayName: '星野 みなと',
    uid: '100234567',
    bio: '主玩 maimai 与 phigros 的休闲玩家 · 偶尔打 Arcaea · 欢迎来群里对刷',
    banner: gradientPng(1200, 300, '#25406e', '#7b2d5e', { blobs: true, seed: 11 }),
    avatar: avatarPng(320, '#8fb4ff', '#2b3560'),
    games: [
      { name: 'maimai', icon: gameIconPng(160, '#ffd0e4', '#ff5f9e', 1) },
      { name: 'phigros', icon: gameIconPng(160, '#c7f3ff', '#33b6e6', 2) },
      { name: 'arcaea', icon: gameIconPng(160, '#e3d4ff', '#7b5cff', 3) },
    ],
    cards: [
      {
        game: 'maimai',
        title: 'maimai DX',
        rating: '15023',
        subtitle: 'DX rating · 更新于 2026-10-27',
        background: gradientPng(1200, 260, '#3a2148', '#14253f', { blobs: true, seed: 21 }),
        avatar: avatarPng(240, '#ffd7e8', '#c8317f'),
        fields: [
          { label: 'B35', value: '14980' },
          { label: 'B15', value: '15031' },
          { label: 'DX 分', value: '312' },
          { label: '最佳达成率', value: '100.5%' },
        ],
      },
      {
        game: 'phigros',
        title: 'Phigros',
        rating: '15.4321',
        subtitle: 'Ranking Score · 更新于 2026-10-27',
        background: gradientPng(1200, 260, '#10394b', '#101d36', { blobs: true, seed: 22 }),
        avatar: avatarPng(240, '#c9f5ff', '#127ba3'),
        fields: [
          { label: 'RKS', value: '15.4321' },
          { label: '最高定数', value: '15.8' },
          { label: 'phi', value: '3' },
        ],
      },
      {
        game: 'arcaea',
        title: 'Arcaea',
        rating: '12.34',
        subtitle: 'Potential · 更新于 2026-10-27',
        background: gradientPng(1200, 260, '#2d2150', '#131427', { blobs: true, seed: 23 }),
        avatar: avatarPng(240, '#e8dcff', '#4b2f9e'),
        fields: [
          { label: 'Potential', value: '12.34' },
          { label: '最高定数', value: '10+' },
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

/** 缺可选素材但有卡片：rating 为 null、无背景/头像、字段为空。 */
export function buildSparseCardInput(): PlayerCardInput {
  return {
    displayName: 'Sparse Player',
    uid: '900001',
    bio: null,
    banner: null,
    avatar: null,
    games: [{ name: 'phigros', icon: gameIconPng(128, '#99e7ff', '#0f6d8c') }],
    cards: [
      {
        game: 'phigros',
        title: 'Phigros',
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
    games: [{ name: 'maimai'.repeat(6), icon: gameIconPng(96, '#ffd0e4', '#c8317f') }],
    cards: [
      {
        game: 'maimai',
        title: long,
        rating: '15023150231502315023',
        subtitle: '副标题'.repeat(20),
        fields: [
          { label: '标签'.repeat(10), value: '值'.repeat(20) },
          { label: 'B35', value: '14980' },
        ],
      },
    ],
  };
}
