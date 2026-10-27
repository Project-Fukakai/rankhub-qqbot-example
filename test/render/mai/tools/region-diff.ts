/**
 * 任意区域差异（spike 排查用）。
 *
 *   pnpm exec tsx test/render/mai/tools/region-diff.ts [s1] x y w h [可选多组 x y w h ...]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVIDENCE_DIR, decodePng, regionDiff } from '../helpers.js';

const args = process.argv.slice(2);
const sample = /^s\d+$/.test(args[0] ?? '') ? (args.shift() as string) : 's1';
const referencePath = join(
  EVIDENCE_DIR,
  sample === 's1' ? 'maimai-reference.png' : `maimai-reference-${sample}.png`,
);
const nodePath = join(EVIDENCE_DIR, `maimai-node-${sample}.png`);

const reference = await decodePng(readFileSync(referencePath));
const node = await decodePng(readFileSync(nodePath));

while (args.length >= 4) {
  const [x, y, w, h] = args.splice(0, 4).map(Number) as [number, number, number, number];
  const diff = regionDiff(reference, node, { x, y, w, h });
  console.log(
    `(${x},${y}) ${w}×${h}: ${(diff.ratio * 100).toFixed(2)}% changed，` +
      `maxΔ=${diff.maxDelta}，meanΔ=${diff.meanDeltaOnChanged.toFixed(1)}`,
  );
}
