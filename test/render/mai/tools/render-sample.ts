/**
 * spike / 回归采样 CLI：用移植实现渲染 fixture 样例，并与 Python 参考图做像素对比。
 *
 *   pnpm exec tsx test/render/mai/tools/render-sample.ts            # 全部样例
 *   pnpm exec tsx test/render/mai/tools/render-sample.ts s1         # 只跑 s1
 *
 * 产物：
 *   evidence/qqbot/render/maimai-node-<id>.png     移植实现输出
 *   evidence/qqbot/render/maimai-reference[-<id>].png  Python 参考图（已存在则复用）
 *
 * 输出：每样例耗时、尺寸、逐通道阈值 16 的差异率。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMaimaiRenderer } from '../../../../src/render/mai/index.js';
import {
  ASSETS_DIR,
  EVIDENCE_DIR,
  FOOTER_REGION,
  HEADER_REGION,
  bestShift,
  decodePng,
  loadFixture,
  pixelDiff,
  regionDiff,
  toRenderInput,
  worstCardDiff,
} from '../helpers.js';

const threshold = Number(process.env.MAI_DIFF_THRESHOLD ?? '16');
const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const fixture = loadFixture();
const samples = only.length > 0 ? fixture.samples.filter((s) => only.includes(s.id)) : fixture.samples;

mkdirSync(EVIDENCE_DIR, { recursive: true });

const renderer = createMaimaiRenderer({ assetsDir: ASSETS_DIR });

let failed = false;
for (const sample of samples) {
  const input = toRenderInput(sample);
  const started = performance.now();
  const png = await renderer.renderMaimaiB50(input);
  const elapsed = performance.now() - started;

  const outPath = join(EVIDENCE_DIR, `maimai-node-${sample.id}.png`);
  writeFileSync(outPath, png);
  const image = await decodePng(png);

  const referenceName = sample.id === 's1' ? 'maimai-reference.png' : `maimai-reference-${sample.id}.png`;
  const referencePath = join(EVIDENCE_DIR, referenceName);
  let diffLine = '参考图缺失（跳过像素对比）';
  if (existsSync(referencePath)) {
    const ref = await decodePng(readFileSync(referencePath));
    const full = pixelDiff(ref, image, threshold);
    const header = regionDiff(ref, image, HEADER_REGION, threshold);
    const card = worstCardDiff(ref, image, threshold);
    const footer = regionDiff(ref, image, FOOTER_REGION, threshold);
    const shift = bestShift(ref, image);
    const okHeader = header.ratio <= 0.05;
    const okCard = card.diff.ratio <= 0.2;
    const okShift = shift.dx === 0 && shift.dy === 0;
    if (!okHeader || !okCard || !okShift) failed = true;
    diffLine = [
      `全图 ${(full.ratio * 100).toFixed(2)}%（maxΔ=${full.maxDelta}）`,
      `头部 ${(header.ratio * 100).toFixed(2)}% ${okHeader ? '✓ ≤5%' : '✗ >5%'}`,
      `最差卡片#${card.index} ${(card.diff.ratio * 100).toFixed(2)}% ${okCard ? '✓ ≤20%' : '✗ >20%'}`,
      `页脚 ${(footer.ratio * 100).toFixed(2)}%（允许文案不同）`,
      `最佳平移 dx=${shift.dx} dy=${shift.dy} ${okShift ? '✓ 无偏移' : '✗ 有偏移'}（score ${shift.zeroScore.toFixed(2)} vs ${shift.score.toFixed(2)}）`,
    ].join('；');
  }

  const slow = elapsed > 1500;
  if (slow) failed = true;
  console.log(
    `[${sample.id}] ${image.width}×${image.height} ${(png.length / 1024 / 1024).toFixed(2)}MB ` +
      `${elapsed.toFixed(0)}ms ${slow ? '✗ >1.5s' : '✓ ≤1.5s'} → ${outPath}\n      ${diffLine}`,
  );
}

await renderer.close();
process.exitCode = failed ? 1 : 0;
