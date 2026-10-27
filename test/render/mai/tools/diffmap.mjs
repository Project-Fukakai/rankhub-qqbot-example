#!/usr/bin/env node
/**
 * 差异热力图（spike 排查用）：把两张同尺寸 PNG 的逐像素差异压成 100×100 网格打印。
 *
 *   node test/render/mai/tools/diffmap.mjs <参考图> <移植图>
 *
 * 字符含义：. <0.5%   1 <5%   2 <20%   3 <50%   4 <80%   5 ≥80%（该格内差异像素占比）
 */
import { readFileSync } from 'node:fs';

import { createCanvas, loadImage } from '@napi-rs/canvas';

const CELL = 100;

async function decode(path) {
  const img = await loadImage(readFileSync(path));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

const [refPath, nodePath] = process.argv.slice(2);
if (!refPath || !nodePath) {
  console.error('用法：node test/render/mai/tools/diffmap.mjs <参考图> <移植图>');
  process.exit(2);
}

const a = await decode(refPath);
const b = await decode(nodePath);
if (a.width !== b.width || a.height !== b.height) {
  console.error(`尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`);
  process.exit(1);
}

const W = a.width;
const H = a.height;
const rows = [];
for (let y = 0; y < H; y += CELL) {
  let line = '';
  for (let x = 0; x < W; x += CELL) {
    let changed = 0;
    let total = 0;
    for (let yy = y; yy < Math.min(y + CELL, H); yy += 1) {
      for (let xx = x; xx < Math.min(x + CELL, W); xx += 1) {
        const p = (yy * W + xx) * 4;
        const d = Math.max(
          Math.abs(a.data[p] - b.data[p]),
          Math.abs(a.data[p + 1] - b.data[p + 1]),
          Math.abs(a.data[p + 2] - b.data[p + 2]),
          Math.abs(a.data[p + 3] - b.data[p + 3]),
        );
        total += 1;
        if (d > 16) changed += 1;
      }
    }
    const ratio = changed / total;
    line += ratio < 0.005 ? '.' : ratio < 0.05 ? '1' : ratio < 0.2 ? '2' : ratio < 0.5 ? '3' : ratio < 0.8 ? '4' : '5';
  }
  rows.push(`${String(y).padStart(4)} ${line}`);
}
console.log(`网格 ${CELL}px；列 = x/100，行首数字 = y`);
console.log(rows.join('\n'));
