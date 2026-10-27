/**
 * 单卡差异分布（spike 排查用）：打印 50 张成绩卡各自的差异率，按差到好排序。
 *
 *   pnpm exec tsx test/render/mai/tools/card-diff.ts [s1]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EVIDENCE_DIR,
  decodePng,
  cardRects,
  regionDiff,
} from '../helpers.js';

const sample = process.argv[2] ?? 's1';
const referencePath = join(
  EVIDENCE_DIR,
  sample === 's1' ? 'maimai-reference.png' : `maimai-reference-${sample}.png`,
);
const nodePath = join(EVIDENCE_DIR, `maimai-node-${sample}.png`);

const reference = await decodePng(readFileSync(referencePath));
const node = await decodePng(readFileSync(nodePath));

const rows = cardRects().map((rect, index) => ({
  index,
  section: index < 35 ? 'sd' : 'dx',
  rect,
  ratio: regionDiff(reference, node, rect).ratio,
}));
rows.sort((a, b) => b.ratio - a.ratio);
for (const row of rows.slice(0, 15)) {
  console.log(
    `#${String(row.index).padStart(2)} ${row.section} @(${row.rect.x},${row.rect.y}) ${(row.ratio * 100).toFixed(2)}%`,
  );
}
const ratios = rows.map((r) => r.ratio);
console.log(
  `\n卡片差异：中位 ${(ratios[Math.floor(ratios.length / 2)]! * 100).toFixed(2)}% ` +
    `最大 ${(ratios[0]! * 100).toFixed(2)}% 最小 ${(ratios[ratios.length - 1]! * 100).toFixed(2)}% ` +
    `>20% 的有 ${ratios.filter((r) => r > 0.2).length} 张`,
);
