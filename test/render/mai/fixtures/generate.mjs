#!/usr/bin/env node
/**
 * 生成 b50 渲染测试用固定 fixture（确定性、可复现）。
 *
 * 数据来源：vendor/mai/data.json（lxns song list 快照，含定数 level_value 与 notes.total）。
 * 评级/rating 公式照 maimaiDX constants.BASE_RA_SPP + core/utils/calc.compute_rating。
 *
 * 用法：node test/render/mai/fixtures/generate.mjs
 * 产物：test/render/mai/fixtures/b50-fixture.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
const DATA = JSON.parse(readFileSync(join(ROOT, 'vendor', 'mai', 'data.json'), 'utf8'));

const ACHIEVEMENT_LIST = [50, 60, 70, 75, 80, 90, 94, 97, 98, 99, 99.5, 100, 100.5];
const BASE_RA_SPP = [7, 8, 9.6, 11.2, 12, 13.6, 15.2, 16.8, 20, 20.3, 20.8, 21.1, 21.6, 22.4];
const RANK_BY_ACH = [
  [50, 'd'],
  [60, 'c'],
  [70, 'b'],
  [75, 'bb'],
  [80, 'bbb'],
  [90, 'a'],
  [94, 'aa'],
  [97, 'aaa'],
  [98, 's'],
  [99, 'sp'],
  [99.5, 'ss'],
  [100, 'ssp'],
  [100.5, 'sss'],
  [Infinity, 'sssp'],
];

function baseRa(ach) {
  const i = ACHIEVEMENT_LIST.findIndex((th) => ach < th);
  return BASE_RA_SPP[i === -1 ? BASE_RA_SPP.length - 1 : i];
}
function rateOf(ach) {
  return RANK_BY_ACH.find(([th]) => ach < th)[1];
}
function ratingOf(ds, ach) {
  return Math.floor(ds * (Math.min(100.5, ach) / 100) * baseRa(ach));
}

/** 确定性的伪随机（LCG），避免依赖 Math.random 导致 fixture 漂移。 */
let seed = 20261027;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

/** 从 data.json 里选「高定数」谱面，分 SD / DX 两组。 */
function pool(chartType, minLevelValue) {
  const out = [];
  for (const song of DATA.songs) {
    for (const d of song.difficulties) {
      if (d.type !== chartType) continue;
      if (d.difficulty < 3) continue; // 只用 Master / Re:Master
      if (!d.level_value || d.level_value < minLevelValue) continue;
      if (!d.notes_total) continue;
      out.push({ song, d });
    }
  }
  out.sort((a, b) => b.d.level_value - a.d.level_value || a.song.id - b.song.id);
  return out;
}

const FC_POOL = ['fc', 'fcp', 'ap', 'app', null, null];
const FS_POOL = ['fs', 'fsp', 'fsd', 'fsdp', 'sync', null, null];

function buildSide(chartType, count, minLevelValue, achBase) {
  const chosen = [];
  const seen = new Set();
  for (const item of pool(chartType, minLevelValue)) {
    if (chosen.length >= count) break;
    const songId = chartType === 'dx' ? item.song.id + 10000 : item.song.id;
    if (seen.has(songId)) continue;
    seen.add(songId);
    chosen.push({ songId, ...item });
  }
  if (chosen.length < count) throw new Error(`${chartType} 谱面不足：${chosen.length}/${count}`);

  return chosen.map(({ song, d, songId }, idx) => {
    // 达成率沿 100.5 → 99.x 平滑衰减，夹杂边界值（.0 / 100.5）用于渲染测试
    const drift = idx * 0.021;
    const achievements = Math.max(97.5, Math.min(100.5, achBase - drift));
    // 保留 4 位小数（maimai 达成率显示口径）
    const ach = Math.round(achievements * 10000) / 10000;
    const rating = ratingOf(d.level_value, ach);
    const maxDx = d.notes_total * 3;
    const dxScore = Math.round(maxDx * (0.9 + rnd() * 0.099));
    return {
      song_id: songId,
      song_name: song.title,
      type: chartType === 'dx' ? 'DX' : 'SD',
      level_index: d.difficulty,
      level: d.level,
      level_value: d.level_value,
      rating,
      achievements: ach,
      rate: rateOf(ach),
      fc: pick(FC_POOL),
      fs: pick(FS_POOL),
      dx_score: dxScore,
      max_dx_score: maxDx,
      has_cover: true,
    };
  });
}

const sd = buildSide('standard', 35, 14.4, 100.49);
const dx = buildSide('dx', 15, 14.3, 100.5);
const sdTotal = sd.reduce((s, x) => s + x.rating, 0);
const dxTotal = dx.reduce((s, x) => s + x.rating, 0);

const longName = '【超長曲名テスト】まだまだまだまだ続くタイトルでレイアウト崩れを確認する曲';

const clone = (v) => JSON.parse(JSON.stringify(v));

const samples = [
  {
    id: 's1',
    note: '默认头（无称号）：PRiSM PLUS 主题、15000 段位',
    theme: 'prism_plus',
    service: 'Diving-Fish',
    player: {
      qqid: null,
      name: '霧島ハル',
      rating: sdTotal + dxTotal,
      course_rank: 8,
      class_rank: 20,
      trophy: null,
    },
  },
  {
    id: 's2',
    note: '称号条（金）+ 16500 段位：验证 shougou 与 rating 高位数字',
    theme: 'prism_plus',
    service: 'Lxns-Network',
    player: {
      qqid: null,
      name: '星野 あかり',
      rating: sdTotal + dxTotal + 1200,
      course_rank: 12,
      class_rank: 25,
      trophy: { id: 1, name: '舞萌DX 2026 全曲 SSS', color: 'Gold' },
    },
  },
  {
    id: 's3',
    note: '边界样例：超长曲名（省略号）、1 条 Re:Master、缺 fc/fs',
    theme: 'prism_plus',
    service: 'Diving-Fish',
    player: {
      qqid: null,
      name: 'テストプレイヤー',
      rating: sdTotal + dxTotal - 800,
      course_rank: 0,
      class_rank: 1,
      trophy: null,
    },
  },
];

for (const sample of samples) {
  sample.sd = sample.sd ?? clone(sd);
  sample.dx = sample.dx ?? clone(dx);
}

// s3 覆写：首条换成长曲名 + 去掉 fc/fs，末条换成 15.0 Re:Master
samples[2].sd = clone(sd);
samples[2].dx = clone(dx);
samples[2].sd[0] = {
  ...samples[2].sd[0],
  song_name: longName,
  fc: null,
  fs: null,
};
// 末条换成一张真实存在的 Re:Master（Prism 主题也有 4 档底图，用于验证 5 档难度图）
const rm = DATA.songs
  .flatMap((song) => song.difficulties.map((d) => ({ song, d })))
  .find(({ song, d }) => d.type === 'dx' && d.difficulty === 4 && !samples[0].dx.some((x) => x.song_id === song.id + 10000));
samples[2].dx[14] = {
  song_id: rm.song.id + 10000,
  song_name: rm.song.title,
  type: 'DX',
  level_index: 4,
  level: rm.d.level,
  level_value: rm.d.level_value,
  rating: ratingOf(rm.d.level_value, samples[2].dx[14].achievements),
  achievements: samples[2].dx[14].achievements,
  rate: rateOf(samples[2].dx[14].achievements),
  fc: samples[2].dx[14].fc,
  fs: samples[2].dx[14].fs,
  dx_score: samples[2].dx[14].dx_score,
  max_dx_score: rm.d.notes_total * 3,
  has_cover: true,
};

const fixture = {
  generatedAt: '2026-10-27T00:00:00.000Z',
  generator: 'test/render/mai/fixtures/generate.mjs',
  dataSource: 'vendor/mai/data.json',
  note: '确定性 fixture；改数据需同时更新 Node 渲染与 Python 参考渲染',
  totals: { sd: sdTotal, dx: dxTotal },
  counts: { sd: sd.length, dx: dx.length },
  samples,
};

const out = join(HERE, 'b50-fixture.json');
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `[fixtures] 写入 ${out}\n  sd=${sd.length} dx=${dx.length} sdTotal=${sdTotal} dxTotal=${dxTotal} rating≈${sdTotal + dxTotal}`,
);
