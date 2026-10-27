#!/usr/bin/env node
/**
 * 差异可视化（spike 排查用）：输出 |参考图 - 移植图| 的放大灰度图（×4）。
 *
 *   node test/render/mai/tools/diffimage.mjs <参考图> <移植图> <输出 PNG>
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { createCanvas, loadImage } from '@napi-rs/canvas';

const [refPath, nodePath, outPath] = process.argv.slice(2);
if (!refPath || !nodePath || !outPath) {
  console.error('用法：node test/render/mai/tools/diffimage.mjs <参考图> <移植图> <输出 PNG>');
  process.exit(2);
}

async function decode(path) {
  const img = await loadImage(readFileSync(path));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

const a = await decode(refPath);
const b = await decode(nodePath);
if (a.width !== b.width || a.height !== b.height) {
  console.error(`尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`);
  process.exit(1);
}

const canvas = createCanvas(a.width, a.height);
const ctx = canvas.getContext('2d');
const out = ctx.createImageData(a.width, a.height);
for (let i = 0; i < a.width * a.height; i += 1) {
  const p = i * 4;
  const d = Math.max(
    Math.abs(a.data[p] - b.data[p]),
    Math.abs(a.data[p + 1] - b.data[p + 1]),
    Math.abs(a.data[p + 2] - b.data[p + 2]),
  );
  const v = Math.min(255, d * 4);
  out.data[p] = v;
  out.data[p + 1] = v;
  out.data[p + 2] = v;
  out.data[p + 3] = 255;
}
ctx.putImageData(out, 0, 0);
writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log(`差异图已写入 ${outPath}`);
