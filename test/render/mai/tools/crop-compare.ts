/**
 * 裁切对比图（spike 排查用）：把参考图与移植图的同一块区域左右拼接并放大，便于肉眼比对。
 *
 *   pnpm exec tsx test/render/mai/tools/crop-compare.ts <参考图> <移植图> <x> <y> <w> <h> <输出> [scale]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { createCanvas, loadImage } from '@napi-rs/canvas';

const [refPath, nodePath, xStr, yStr, wStr, hStr, outPath, scaleStr] = process.argv.slice(2);
if (!outPath) {
  console.error('用法：<参考图> <移植图> <x> <y> <w> <h> <输出> [scale]');
  process.exit(2);
}
const x = Number(xStr);
const y = Number(yStr);
const w = Number(wStr);
const h = Number(hStr);
const scale = Number(scaleStr ?? '3');

const [ref, node] = await Promise.all(
  [refPath!, nodePath!].map(async (path) => {
    const img = await loadImage(readFileSync(path));
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas;
  }),
);

const canvas = createCanvas(w * 2 * scale + 12, h * scale);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.imageSmoothingEnabled = false;
ctx.drawImage(ref!, x, y, w, h, 0, 0, w * scale, h * scale);
ctx.drawImage(node!, x, y, w, h, w * scale + 12, 0, w * scale, h * scale);
writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log(`左=参考 右=移植（${w}×${h} × ${scale}）→ ${outPath}`);
