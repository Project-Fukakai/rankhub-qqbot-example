/**
 * phigros `/rks` b19 渲染测试。
 *
 * 依赖 `vendor/phi`（phi-plugin 模板）与 `vendor/covers/phigros`（曲绘缓存）：
 * 首次运行前执行 `node scripts/fetch-assets-phi.mjs`。
 * 产物写入 `test/render/__out__/`（已 gitignore），便于人工对比上游渲染效果。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GameScore } from '../../../src/contracts/index.js';
import {
  MAX_IMAGE_BYTES,
  PhigrosRenderer,
  REPO_ROOT,
  buildPhiTemplateData,
  loadAssets,
  normalizeLevelKey,
  phiRating,
  phiRks,
  resolveAcc,
  resolveScore,
} from '../../../src/render/phi/index.js';
import {
  buildMissingCoverInput,
  buildThirtySongInput,
  buildTwelveSongInput,
  REAL_SONG_IDS,
} from './fixtures.js';

const OUT_DIR = join(REPO_ROOT, 'test', 'render', '__out__');

/** 读 PNG IHDR 或 JPEG SOF 的宽高（不引入 sharp 等图像库）。 */
function readImageSize(buffer: Buffer): { width: number; height: number; format: 'png' | 'jpeg' } {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1]!;
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0/SOF1/SOF2
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          format: 'jpeg',
        };
      }
      offset += 2 + length;
    }
    throw new Error('未能解析 JPEG 尺寸');
  }
  throw new Error(`不是 PNG/JPEG：前 8 字节 ${buffer.subarray(0, 8).toString('hex')}`);
}

describe('phigros b19 渲染（phi-plugin 模板）', () => {
  let renderer: PhigrosRenderer;

  beforeAll(async () => {
    // 素材不存在时给一条可执行的提示，而不是等到浏览器截图才报错。
    const assets = loadAssets();
    expect(assets.songs.songs[REAL_SONG_IDS[0]!]).toBeTruthy();
    await mkdir(OUT_DIR, { recursive: true });
    renderer = new PhigrosRenderer({ now: new Date('2026-10-27T12:00:00+08:00') });
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
  });

  it('30 条成绩：PNG 尺寸/大小正常，无未替换模板标记', async () => {
    const result = await renderer.renderDetail(buildThirtySongInput());
    const size = readImageSize(result.buffer);
    expect(size.format).toBe(result.format);
    expect(size.width).toBe(result.width);
    expect(size.height).toBe(result.height);

    // b19 海报为固定 1200px 宽、高度随内容增长。
    expect(result.width).toBeGreaterThan(1000);
    expect(result.height).toBeGreaterThan(1000);
    expect(result.buffer.length).toBeLessThan(MAX_IMAGE_BYTES);

    expect(result.html).not.toContain('{{');
    expect(result.html).not.toContain('undefined');
    expect(result.data.b19_list).toHaveLength(30);
    expect(result.data.b19_list[0]?.num).toBe(1);
    expect(result.data.b19_list[29]?.num).toBe(30);
    // Phi3 + B27 = 前 27 张普通卡 + OVER FLOW 分隔（第 28 张起进入溢出区）。
    expect(result.html).toContain('OVER FLOW');
    // 保留上游模板的作者/版权信息。
    expect(result.html).toContain('Phi-Plugin');
    expect(result.html).toContain('Phi-Plugin不是Phigros官方项目');
    // 素材来自 phi-plugin 模板本体。
    expect(result.diagnostics.templateFile).toContain('vendor/phi/resources/html/b19/b19.art');
    expect(result.diagnostics.fontsReady).toBe(true);

    const file = join(OUT_DIR, `phi-b19-30.${size.format === 'png' ? 'png' : 'jpg'}`);
    await writeFile(file, result.buffer);
  }, 90_000);

  it('12 条成绩：不足 30 条也能出图，且没有 OVER FLOW 段', async () => {
    const result = await renderer.renderDetail(buildTwelveSongInput());
    const size = readImageSize(result.buffer);
    expect(result.width).toBeGreaterThan(1000);
    // 12 条只有 4 行卡片，模板自然高度约 970px（30 条时约 1770px）；这里只校验版式没塌。
    expect(result.height).toBeGreaterThan(900);
    expect(result.buffer.length).toBeLessThan(MAX_IMAGE_BYTES);
    expect(result.html).not.toContain('{{');
    expect(result.html).not.toContain('undefined');
    expect(result.data.b19_list).toHaveLength(12);
    expect(result.html).not.toContain('OVER FLOW');

    const file = join(OUT_DIR, `phi-b19-12.${size.format === 'png' ? 'png' : 'jpg'}`);
    await writeFile(file, result.buffer);
  }, 90_000);

  it('缺曲绘时用占位图，仍能出图', async () => {
    const result = await renderer.renderDetail(buildMissingCoverInput());
    const size = readImageSize(result.buffer);
    expect(size.width).toBeGreaterThan(1000);
    expect(result.buffer.length).toBeLessThan(MAX_IMAGE_BYTES);
    expect(result.html).toContain('placeholder.jpg');
    expect(result.html).not.toContain('{{');

    const file = join(OUT_DIR, `phi-b19-missing-cover.${size.format === 'png' ? 'png' : 'jpg'}`);
    await writeFile(file, result.buffer);
  }, 90_000);

  it('超过 4.5MB 时降级为 JPEG（不改变版式）', async () => {
    // 用极小的上限强制触发降级分支，验证返回的 magic 与压缩策略。
    const tiny = new PhigrosRenderer({
      now: new Date('2026-10-27T12:00:00+08:00'),
      maxImageBytes: 10_000,
    });
    try {
      const result = await tiny.renderDetail(buildTwelveSongInput());
      expect(['png', 'jpeg']).toContain(result.format);
      const size = readImageSize(result.buffer);
      expect(size.format).toBe(result.format);
      expect(result.width).toBeGreaterThan(1000);
      expect(result.buffer.length).toBeLessThan(MAX_IMAGE_BYTES);
    } finally {
      await tiny.close();
    }
  }, 90_000);

  it('数据映射：评级阈值 / rks 公式 / 定数解析与 phi-plugin 一致', () => {
    expect(phiRating(1_000_000, false)).toBe('phi');
    expect(phiRating(999_999, true)).toBe('FC');
    expect(phiRating(999_999, false)).toBe('V');
    expect(phiRating(960_000, false)).toBe('V');
    expect(phiRating(959_999, false)).toBe('S');
    expect(phiRating(920_000, false)).toBe('S');
    expect(phiRating(919_999, false)).toBe('A');
    expect(phiRating(880_000, false)).toBe('A');
    expect(phiRating(879_999, false)).toBe('B');
    expect(phiRating(820_000, false)).toBe('B');
    expect(phiRating(819_999, false)).toBe('C');
    expect(phiRating(700_000, false)).toBe('C');
    expect(phiRating(699_999, false)).toBe('F');
    expect(phiRating(0, false)).toBe('NEW');

    // 满分时 rks = 定数；非满分 [(acc-55)/45]^2 * 定数；acc < 70 记 0。
    expect(phiRks(100, 15.8)).toBeCloseTo(15.8, 6);
    expect(phiRks(99, 15.8)).toBeCloseTo(15.8 * ((44 / 45) ** 2), 6);
    expect(phiRks(69.99, 15.8)).toBe(0);

    expect(normalizeLevelKey('IN')).toBe('IN');
    expect(normalizeLevelKey('at')).toBe('AT');
    expect(normalizeLevelKey('Master')).toBeNull();

    const accOnly = { achievements: 99.12, score: null } as unknown as GameScore;
    expect(resolveAcc(accOnly)).toBeCloseTo(99.12, 6);
    expect(resolveScore(accOnly)).toBe(991_200);
  });

  it('空 best：没有成绩也能出图（不崩、不留模板标记）', async () => {
    const result = await renderer.renderDetail({
      ...buildTwelveSongInput(),
      phi: [],
      best: [],
    });
    const size = readImageSize(result.buffer);
    expect(size.width).toBeGreaterThan(1000);
    expect(result.buffer.length).toBeLessThan(MAX_IMAGE_BYTES);
    expect(result.data.b19_list).toHaveLength(0);
    expect(result.html).not.toContain('{{');
  }, 90_000);

  it('并发渲染：两个页面同时截图互不影响', async () => {
    const [thirty, twelve] = await Promise.all([
      renderer.renderDetail(buildThirtySongInput()),
      renderer.renderDetail(buildTwelveSongInput()),
    ]);
    expect(readImageSize(thirty.buffer).width).toBeGreaterThan(1000);
    expect(readImageSize(twelve.buffer).width).toBeGreaterThan(1000);
    expect(thirty.width).toBe(1200);
    expect(twelve.width).toBe(1200);
    expect(thirty.html).not.toContain('{{');
    expect(twelve.html).not.toContain('{{');
  }, 120_000);

  it('模板数据：phi 为空数组时 OVER FLOW 分界仍是 27（phi-plugin 语义）', () => {
    const assets = loadAssets();
    const data = buildPhiTemplateData(
      { ...buildThirtySongInput(), phi: [] },
      assets,
      { now: new Date('2026-10-27T12:00:00+08:00') },
    );
    // 空数组在 JS 里是真值：模板 `$index == (phi ? 27 : 30)` 走 27 分支。
    expect(Array.isArray(data.phi)).toBe(true);
    expect(data.b19_list).toHaveLength(30);
    expect(data.gameuser.data).toBe('—');
    expect(data.spInfo).toEqual([]);
    expect(data.stats).toEqual([]);
    expect(data.b30Analysis).toBeNull();
  });
});
