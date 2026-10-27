/**
 * maimai b50 渲染测试（移植路线）。
 *
 * 验收口径来自 lead 的 spike 决议（evidence/qqbot/render/maimai-spike.md）：
 *   1. PNG 签名 / 尺寸 1400×1600 / 体积 < 5MB / 单图 ≤1.5s；
 *   2. 与 maimaiDX 参考图：无全局平移（±1px 内）、头部差异 ≤5%、单卡差异 ≤20%、无结构错位；
 *   3. 缺数据兜底（缺定数显示 `? -> rating`、缺曲绘回落 0.png）不抛错。
 *
 * 全图像素差只做记录，不做门槛：PIL 与 Skia 的字形/缩放抗锯齿天生不同，
 * 用 3% 全图门槛会把「完全正确的移植」判死。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GameScore, MaimaiB50RenderInput } from '../../../src/contracts/index.js';
import {
  MaimaiRenderer,
  MaiSongData,
  buildFooterText,
  computeRating,
  pickBuckets,
  rateOf,
  toB50Model,
} from '../../../src/render/mai/index.js';
import { fitTitle } from '../../../src/render/mai/text.js';
import { loadSongData } from '../../../src/render/mai/data.js';
import {
  ASSETS_DIR,
  EVIDENCE_DIR,
  HEADER_REGION,
  bestShift,
  decodePng,
  loadFixture,
  pixelDiff,
  regionDiff,
  sampleOf,
  toGameScore,
  toRenderInput,
  worstCardDiff,
} from './helpers.js';

const assetsReady = existsSync(join(ASSETS_DIR, 'pic', 'prism_plus', 'b50.png'));
const referenceName = (id: string): string =>
  id === 's1' ? 'maimai-reference.png' : `maimai-reference-${id}.png`;
const referencePath = (id: string): string => join(EVIDENCE_DIR, referenceName(id));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RENDER_MS = 1500;

/** 无 vendor 资源时整组跳过（CI/新克隆先跑 scripts/fetch-assets-mai.mjs）。 */
describe.skipIf(!assetsReady)('maimai b50：基础产物', () => {
  const renderer = new MaimaiRenderer({ assetsDir: ASSETS_DIR });
  const samples = loadFixture().samples.map((sample) => sample.id);

  it.each(samples)('%s 输出合法 PNG（签名/尺寸/体积/耗时）', async (id) => {
    const started = performance.now();
    const png = await renderer.renderMaimaiB50(toRenderInput(sampleOf(id)));
    const elapsed = performance.now() - started;

    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.length).toBeLessThan(MAX_BYTES);

    const image = await decodePng(png);
    expect(image.width).toBe(1400);
    expect(image.height).toBe(1600);
    expect(elapsed).toBeLessThan(MAX_RENDER_MS);
  });

  it('renderMaimaiB50 三次渲染结果完全一致（确定性）', async () => {
    const input = toRenderInput(sampleOf('s1'));
    const a = await renderer.renderMaimaiB50(input);
    const b = await renderer.renderMaimaiB50(input);
    expect(a.equals(b)).toBe(true);
  });

  it('renderPhigrosRks 明确报错（避免装配成缺功能的 Renderer）', async () => {
    await expect(renderer.renderPhigrosRks()).rejects.toThrow(/Phigros/);
  });

  it('close() 可重复调用', async () => {
    await expect(renderer.close()).resolves.toBeUndefined();
    await expect(renderer.close()).resolves.toBeUndefined();
  });
});

/** 参考图对比：参考图缺失时整组跳过（需 .venv-ref + vendor 资源）。 */
describe.skipIf(!assetsReady)('maimai b50：与 maimaiDX 参考图结构一致', () => {
  const renderer = new MaimaiRenderer({ assetsDir: ASSETS_DIR });
  const sampleIds = loadFixture().samples.map((sample) => sample.id);
  const cases = sampleIds.filter((id) => existsSync(referencePath(id)));

  it.skipIf(cases.length === 0).each(cases)('%s 无全局平移（±1px 内）', async (id) => {
    const reference = await decodePng(readFileSync(referencePath(id)));
    const node = await decodePng(await renderer.renderMaimaiB50(toRenderInput(sampleOf(id))));
    expect(node.width).toBe(reference.width);
    expect(node.height).toBe(reference.height);

    const shift = bestShift(reference, node);
    expect({ dx: shift.dx, dy: shift.dy }).toEqual({ dx: 0, dy: 0 });
  });

  it.skipIf(cases.length === 0).each(cases)('%s 头部差异 ≤5%', async (id) => {
    const reference = await decodePng(readFileSync(referencePath(id)));
    const node = await decodePng(await renderer.renderMaimaiB50(toRenderInput(sampleOf(id))));
    const header = regionDiff(reference, node, HEADER_REGION);
    // 记录全图差异便于回归观察（不设门槛）
    const full = pixelDiff(reference, node);
    expect(full.ratio).toBeLessThan(0.2);
    expect(header.ratio).toBeLessThanOrEqual(0.05);
  });

  it.skipIf(cases.length === 0).each(cases)('%s 单卡差异 ≤20%（50 张全查）', async (id) => {
    const reference = await decodePng(readFileSync(referencePath(id)));
    const node = await decodePng(await renderer.renderMaimaiB50(toRenderInput(sampleOf(id))));
    const worst = worstCardDiff(reference, node);
    expect(worst.rect.w).toBe(264);
    expect(worst.rect.h).toBe(109);
    expect(worst.diff.ratio).toBeLessThanOrEqual(0.2);
  });
});

/** 纯映射/兜底逻辑：不依赖 PNG 资源之外的东西，但用真实 data.json 校验口径。 */
describe.skipIf(!assetsReady)('maimai b50：数据映射与兜底', () => {
  const songData = loadSongData(ASSETS_DIR);

  it('评级与 rating 公式与上游 constants/calc 一致', () => {
    // 阈值来自 constants.ACHIEVEMENT_LIST：<100 → ssp，<100.5 → sss，>=100.5 → sssp
    expect(rateOf(100.5)).toBe('sssp');
    expect(rateOf(100.4)).toBe('sss');
    expect(rateOf(99.9)).toBe('ssp');
    expect(rateOf(99.4)).toBe('ss');
    expect(rateOf(98.5)).toBe('sp');
    expect(rateOf(97.9)).toBe('s');
    expect(rateOf(49)).toBe('d');
    // compute_rating：floor(ds * min(100.5, ach)/100 * base)
    // base 由达成率档位决定：100.5+ → 22.4，<97 → 16.8，<98 → 20.0
    expect(computeRating(13.5, 100.5)).toBe(Math.floor(13.5 * 1.005 * 22.4));
    expect(computeRating(14.9, 96.5)).toBe(Math.floor(14.9 * 0.965 * 16.8));
    expect(computeRating(14.9, 97.5)).toBe(Math.floor(14.9 * 0.975 * 20.0));
  });

  it('latest/archive bucket 映射为 dx/sd，且合计 rating 正确', () => {
    const input = toRenderInput(sampleOf('s1'));
    const buckets = pickBuckets(input);
    expect(buckets.dx).toHaveLength(15);
    expect(buckets.sd).toHaveLength(35);

    const model = toB50Model(input, songData);
    expect(model.sd).toHaveLength(35);
    expect(model.dx).toHaveLength(15);
    const sample = sampleOf('s1');
    expect(model.sdTotal).toBe(sample.sd.reduce((sum, row) => sum + row.rating, 0));
    expect(model.dxTotal).toBe(sample.dx.reduce((sum, row) => sum + row.rating, 0));
    expect(model.player.name).toBe(sample.player.name);
  });

  it('bucket key 不认识时按条目数兜底（35 条 → B35）', () => {
    const items: GameScore[] = Array.from({ length: 50 }, (_, i) => ({
      ...toGameScore(sampleOf('s1').sd[i % 35]!),
      scoreId: `x-${i}`,
    }));
    const input: MaimaiB50RenderInput = {
      profileName: 'x',
      rating: 15000,
      buckets: [
        { key: 'bucket-a', items: items.slice(0, 15) },
        { key: 'bucket-b', items: items.slice(15) },
      ],
      totals: {},
      computedAt: '2026-10-27T00:00:00.000Z',
    };
    const buckets = pickBuckets(input);
    expect(buckets.sd).toHaveLength(35);
    expect(buckets.dx).toHaveLength(15);
  });

  it('未知曲目/缺定数：levelValue 为 null，渲染不抛错（显示 `? -> rating`）', async () => {
    const unknown: GameScore = {
      scoreId: 'unknown',
      songId: '999999',
      songName: '未知曲目【测试】',
      type: 'dx',
      difficulty: 'master',
      levelIndex: 3,
      level: null,
      achievements: 99.5,
      score: null,
      rating: null,
      rank: 'ss',
      dxScore: null,
      dxStar: null,
      fc: 'ap',
      fs: 'fs',
      playTime: null,
      native: null,
    };
    const input: MaimaiB50RenderInput = {
      profileName: '缺数据玩家',
      rating: 15000,
      buckets: [
        { key: 'latest', items: [unknown] },
        { key: 'archive', items: [unknown] },
      ],
      totals: {},
      computedAt: '2026-10-27T00:00:00.000Z',
    };
    const model = toB50Model(input, songData);
    expect(model.dx[0]!.levelValue).toBeNull();
    expect(model.dx[0]!.rating).toBe(0);

    const renderer = new MaimaiRenderer({ assetsDir: ASSETS_DIR });
    const png = await renderer.renderMaimaiB50(input);
    expect(png.subarray(0, 4).equals(PNG_SIGNATURE.subarray(0, 4))).toBe(true);
  });

  it('空 buckets 仍能渲染背景图（不抛错）', async () => {
    const renderer = new MaimaiRenderer({ assetsDir: ASSETS_DIR });
    const png = await renderer.renderMaimaiB50({
      profileName: '空数据',
      rating: 0,
      buckets: [],
      totals: {},
      computedAt: '2026-10-27T00:00:00.000Z',
    });
    const image = await decodePng(png);
    expect(image.width).toBe(1400);
  });

  it('页脚保留上游署名（Designed by Yuri-YuzuChaN & BlueDeer233）', () => {
    const footer = buildFooterText('RankHub', 'RankHub');
    expect(footer.startsWith('Designed by Yuri-YuzuChaN & BlueDeer233.')).toBe(true);
    expect(footer).toContain('Data from RankHub.');
    expect(footer.endsWith('Generated by RankHub BOT')).toBe(true);
  });

  it('data.json 缺失时返回空表（渲染退化为 `? -> rating`）', () => {
    const empty = MaiSongData.load('/nonexistent/maimai-static');
    expect(empty.size).toBe(0);
    expect(empty.levelValue(834, 4)).toBeNull();
    expect(empty.maxDxScore(834, 4)).toBeNull();
  });

  it('曲名超宽按上游列宽规则截断加省略号', () => {
    const long = '【超長曲名テスト】まだまだまだまだ続くタイトルでレイアウト崩れを確認する曲';
    expect(fitTitle(long).endsWith('...')).toBe(true);
    expect(fitTitle('short')).toBe('short');
  });

  it('缺曲绘回落 cover/0.png（渲染不抛错）', async () => {
    const row = { ...toGameScore(sampleOf('s1').sd[0]!), songId: '1999999', scoreId: 'no-cover' };
    const renderer = new MaimaiRenderer({ assetsDir: ASSETS_DIR });
    const png = await renderer.renderMaimaiB50({
      profileName: '缺曲绘',
      rating: 15000,
      buckets: [{ key: 'archive', items: [row] }],
      totals: {},
      computedAt: '2026-10-27T00:00:00.000Z',
    });
    expect(png.length).toBeGreaterThan(1000);
  });
});
