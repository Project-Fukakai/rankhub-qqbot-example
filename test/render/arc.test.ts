/**
 * Arcaea B50 海报渲染测试。
 *
 * 依赖 `vendor/arc`（曲绘/字体/logo/索引）：首次运行前执行
 *   `node scripts/fetch-assets-arc.mjs`
 * 产物写入 `test/render/__out__/`（已 gitignore），即验收要求的 reference PNG。
 *
 * 覆盖：
 * 1. 50 条 fixture 全量渲染（断言宽度 / 字节 / 无模板残留），产出 arc-reference.png；
 * 2. 缺曲绘（未知 songId）回落占位图且不抛异常；
 * 3. 空列表也能出图（降级不崩）；
 * 4. 纯数据映射单测（难度/等级/判定/PTT/分数分隔），不启动浏览器。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GameScore } from '../../src/contracts/index.js';
import {
  ArcaeaRenderer,
  BEST_VISIBLE,
  POSTER_WIDTH,
  REPO_ROOT,
  arcaeaGrade,
  arcaeaPtt,
  buildArcTemplateData,
  deriveGrade,
  describeArcAssets,
  formatJudgements,
  formatPlayTime,
  formatPotential,
  formatScore,
  loadArcAssets,
  lookupSong,
  resolveCoverFile,
  type ArcAssets,
  type ArcaeaB50RenderInput,
  type ArcaeaScore,
} from '../../src/render/arc/index.js';

const OUT_DIR = join(REPO_ROOT, 'test', 'render', '__out__');
const REFERENCE_PNG = join(OUT_DIR, 'arc-reference.png');

/** 固定渲染时刻，避免 reference PNG 随日期变化。 */
const FIXED_NOW = new Date('2026-10-27T18:24:51+08:00');
const FIXED_COMPUTED_AT = '2026-10-27T18:24:51+08:00';

/** 读 PNG IHDR / JPEG SOF 的宽高（与 phi 渲染测试同款，不引入图像库）。 */
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

/** FNV-1a：fixture 里所有"随机"值都来自它，保证每次运行结果一致。 */
function fnv1a(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return hash >>> 0;
}

interface FixtureSong {
  songId: string;
  difficulty: string;
  level: string;
  constant: number;
  difficultyIndex: number;
}

/** 从曲绘索引里取「定数最高」的一批曲目，让 fixture 的高分卡片落在高难曲上。 */
function pickFixtureSongs(assets: ArcAssets, count: number): FixtureSong[] {
  const rows: FixtureSong[] = [];
  for (const songId of Object.keys(assets.index.songs).sort()) {
    const entry = assets.index.songs[songId]!;
    for (const level of Object.values(entry.levels)) {
      if (level.constant == null) continue;
      rows.push({
        songId,
        difficulty: level.difficulty,
        level: level.level ?? String(level.constant),
        constant: level.constant,
        difficultyIndex: level.difficultyIndex ?? 2,
      });
    }
  }
  rows.sort((left, right) => right.constant - left.constant || left.songId.localeCompare(right.songId));
  if (rows.length < count) {
    throw new Error(`vendor/arc 曲绘索引只有 ${rows.length} 条可用谱面，不足以构造 ${count} 条 fixture`);
  }
  return rows.slice(0, count);
}

/**
 * 构造 50 条 fixture：分数按名次从满分局往回退，判定/通关类型与分数自洽。
 *
 * 名次-分数分档（贴近真实 B50 的形状）：
 *   0-1   PURE MEMORY  10,000,000
 *   2-11  EX+          9.90M ~ 9.98M
 *   12-31 EX           9.70M ~ 9.89M
 *   32-49 AA           9.50M ~ 9.69M
 */
function buildFiftyItemInput(assets: ArcAssets): ArcaeaB50RenderInput {
  const songs = pickFixtureSongs(assets, BEST_VISIBLE);
  const items: ArcaeaScore[] = songs.map((song, index) => {
    const jitter = fnv1a(`${song.songId}:${index}`) % 2500;
    let score: number;
    if (index < 2) score = 10_000_000;
    else if (index < 12) score = 9_900_000 + Math.round(((11 - index) / 9) * 80_000) + (jitter % 900);
    else if (index < 32) score = 9_700_000 + Math.round(((31 - index) / 19) * 190_000) + (jitter % 800);
    else score = 9_500_000 + Math.round(((49 - index) / 17) * 190_000) + (jitter % 700);

    const noteCount = 900 + (fnv1a(`${song.songId}:notes`) % 700);
    const pureMemory = index < 2;
    const fullRecall = !pureMemory && index % 5 === 3;
    const nearCount = pureMemory ? 0 : 2 + (jitter % 18);
    const missCount = pureMemory || fullRecall ? 0 : 1 + (jitter % 4);
    const perfectCount = noteCount - nearCount - missCount;
    const shinyPerfectCount = pureMemory
      ? perfectCount
      : Math.floor(perfectCount * (0.962 + (jitter % 30) / 1000));
    const clearType = pureMemory ? 3 : fullRecall ? 2 : 1;
    const playMinutes = 25 + (fnv1a(`${song.songId}:time`) % 900);

    return {
      songId: song.songId,
      title: assets.index.songs[song.songId]?.title ?? song.songId,
      score,
      rating: arcaeaPtt(song.constant, score, clearType),
      level: song.level,
      levelIndex: song.difficultyIndex,
      difficulty: song.difficulty,
      constant: song.constant,
      clearType,
      scoreRank: arcaeaGrade(score),
      perfectCount,
      shinyPerfectCount,
      nearCount,
      missCount,
      // 一半用分钟、一半用已格式化字符串，两条路径都覆盖到。
      ...(index % 2 === 0 ? { playMinutes } : { playTime: formatPlayTime(playMinutes) }),
    };
  });

  return {
    profileName: 'Hikari',
    potential: 12.3456,
    items,
    computedAt: FIXED_COMPUTED_AT,
  };
}

describe('arcaea B50 渲染（best-posters 版式）', () => {
  let renderer: ArcaeaRenderer;
  let assets: ArcAssets;

  beforeAll(async () => {
    // 素材不存在时给一条可执行的提示，而不是等到浏览器截图才报错。
    assets = loadArcAssets();
    expect(Object.keys(assets.index.songs).length).toBeGreaterThan(0);
    await mkdir(OUT_DIR, { recursive: true });
    renderer = new ArcaeaRenderer({
      now: FIXED_NOW,
      // 测试要稳定拿到 PNG：关掉降级为 JPEG 的阈值（真实链路仍按 4.5MB 降级）。
      maxImageBytes: Number.POSITIVE_INFINITY,
    });
  }, 120_000);

  afterAll(async () => {
    await renderer?.close();
  });

  it('50 条成绩：PNG 宽 2600 / 字节 > 100KB，产出 reference PNG', async () => {
    const startedAt = Date.now();
    const result = await renderer.renderDetail(buildFiftyItemInput(assets));
    const elapsed = Date.now() - startedAt;

    const size = readImageSize(result.buffer);
    expect(result.format).toBe('png');
    expect(size.format).toBe('png');
    // 海报定宽 2600px（验收：宽 > 2000）。
    expect(size.width).toBe(POSTER_WIDTH);
    expect(size.width).toBeGreaterThan(2000);
    expect(size.height).toBeGreaterThan(2000);
    expect(result.width).toBe(size.width);
    expect(result.height).toBe(size.height);
    expect(result.buffer.byteLength).toBeGreaterThan(100 * 1024);

    // 50 张卡片全部落到 DOM 里，且曲绘全部命中（fixture 取自曲绘索引）。
    expect(result.data.cards).toHaveLength(50);
    expect(result.data.sectionCount).toBe(50);
    expect(result.data.diagnostics.coversMissing).toBe(0);
    expect(result.diagnostics.coversFound).toBe(50);
    expect(result.diagnostics.fontsReady).toBe(true);
    // 视口窄于海报宽度时 Chromium 会横向裁切，这里守住"截图确实覆盖整幅海报"。
    expect(result.diagnostics.viewportWidth).toBeGreaterThanOrEqual(size.width);

    // 模板是纯字符串拼装，不该有未替换标记或 JS 的 undefined/NaN 漏出来。
    expect(result.html).not.toContain('{{');
    expect(result.html).not.toContain('undefined');
    expect(result.html).not.toContain('NaN');
    expect(result.html).toContain('game-arcaea');
    expect(result.html.match(/class="score-card"/g) ?? []).toHaveLength(50);

    await writeFile(REFERENCE_PNG, result.buffer);
    // 供 CI 日志/验收记录：尺寸、字节、耗时、素材概况。
    console.log(
      `[arc-reference] ${size.width}×${size.height}px, ${(result.buffer.byteLength / 1024).toFixed(1)}KB, ` +
        `${elapsed}ms → ${REFERENCE_PNG}`,
    );
    console.log(`[arc-assets] ${JSON.stringify(describeArcAssets())}`);
  }, 180_000);

  it('未知曲目（缺曲绘）回落占位图，不抛异常', async () => {
    const items: ArcaeaScore[] = Array.from({ length: 6 }, (_unused, index) => ({
      songId: `__missing_song_${index}__`,
      // 曲名/等级/判定全部缺失，验证"缺字段用占位"。
      score: 9_876_543 - index * 1000,
      rating: 11.5 - index * 0.1,
    }));
    const result = await renderer.renderDetail({ profileName: '', potential: null, items });

    expect(result.buffer.byteLength).toBeGreaterThan(50 * 1024);
    expect(result.data.cards).toHaveLength(6);
    expect(result.diagnostics.coversMissing).toBe(6);
    expect(result.diagnostics.coversFound).toBe(0);
    expect(result.data.cards[0]!.coverUrl).toContain('placeholder.svg');
    // 缺字段一律是占位符，不是 "undefined"。
    expect(result.data.cards[0]!.primaryValue).toBe("9'876'543");
    expect(result.data.cards[0]!.secondaryValue).toBe('P — / F — / L —');
    expect(result.data.cards[0]!.levelText).toBe('');
    expect(result.data.profileInitial).toBe('?');
    expect(result.data.potentialText).toBe('—');
    expect(result.html).not.toContain('undefined');
    const size = readImageSize(result.buffer);
    expect(size.width).toBe(POSTER_WIDTH);
  }, 180_000);

  it('空列表也能出图（降级不崩），统计项显示占位', async () => {
    const result = await renderer.renderDetail({ profileName: '空列表', potential: 0, items: [] });
    expect(result.data.cards).toHaveLength(0);
    expect(result.data.sectionCount).toBe(0);
    expect(result.data.stats.map((stat) => stat.value)).toEqual(['—', '—', '0']);
    const size = readImageSize(result.buffer);
    expect(size.width).toBe(POSTER_WIDTH);
    expect(size.height).toBeGreaterThan(400);
  }, 180_000);

  it('超过字节上限时降级为 JPEG，再超则整体缩 85%（QQ 5MB 链路）', async () => {
    // 真实链路默认上限 4.5MB；50 张曲绘的 PNG 约 4.8MB，会走 JPEG q90 降级。
    const jpegRenderer = new ArcaeaRenderer({ now: FIXED_NOW, maxImageBytes: 2 * 1024 * 1024 });
    try {
      const result = await jpegRenderer.renderDetail(buildFiftyItemInput(assets));
      expect(result.format).toBe('jpeg');
      const size = readImageSize(result.buffer);
      expect(size.format).toBe('jpeg');
      expect(size.width).toBe(POSTER_WIDTH);
      expect(size.height).toBeGreaterThan(2000);
      expect(result.buffer.byteLength).toBeLessThan(2 * 1024 * 1024);
      console.log(`[arc-jpeg] ${size.width}×${size.height}px, ${(result.buffer.byteLength / 1024).toFixed(1)}KB`);
    } finally {
      await jpegRenderer.close();
    }

    // 上限压到不可能满足时，最后一档是整体 85% 的 JPEG（宽度按比例收窄）。
    const tinyRenderer = new ArcaeaRenderer({ now: FIXED_NOW, maxImageBytes: 1024 });
    try {
      const result = await tinyRenderer.renderDetail(buildFiftyItemInput(assets));
      expect(result.format).toBe('jpeg');
      const size = readImageSize(result.buffer);
      expect(size.width).toBe(Math.round(POSTER_WIDTH * 0.85));
      expect(size.width).toBeGreaterThan(2000);
    } finally {
      await tinyRenderer.close();
    }
  }, 240_000);

  it('renderArcaeaB50 直接返回 Buffer（公开 API）', async () => {
    const input = buildFiftyItemInput(assets);
    const buffer = await renderer.renderArcaeaB50({ ...input, items: input.items.slice(0, 3) });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.byteLength).toBeGreaterThan(50 * 1024);
    expect(readImageSize(buffer).width).toBe(POSTER_WIDTH);
  }, 180_000);
});

describe('arcaea 海报数据映射（纯函数）', () => {
  let assets: ArcAssets;

  beforeAll(() => {
    assets = loadArcAssets();
  });

  it('分数用半角单引号分隔，PTT/定数按设计稿精度展示', () => {
    expect(formatScore(9_950_000)).toBe("9'950'000");
    expect(formatScore(10_000_000)).toBe("10'000'000");
    expect(formatScore(null)).toBe('—');
    expect(formatPotential(12.3456)).toBe('12.3456');
    expect(formatPotential('12.35')).toBe('12.35');
    expect(formatPotential(null)).toBe('—');
    expect(arcaeaGrade(9_950_000)).toBe('EX+');
    expect(arcaeaGrade(9_850_000)).toBe('EX');
    expect(arcaeaGrade(9_600_000)).toBe('AA');
    expect(arcaeaGrade(9_300_000)).toBe('A');
    expect(arcaeaGrade(8_950_000)).toBe('B');
    expect(arcaeaGrade(8_700_000)).toBe('C');
    expect(arcaeaGrade(8_100_000)).toBe('D');
    expect(arcaeaGrade(0)).toBe('D');
    expect(arcaeaGrade(null)).toBe('—');
  });

  it('单曲 PTT 兜底公式与 best-posters 一致（CLEAR 及以上 +0.2）', () => {
    // js/ratings.js:70-75
    expect(arcaeaPtt(10, 10_000_000, 3)).toBeCloseTo(12.2, 5);
    expect(arcaeaPtt(10, 9_900_000, 1)).toBeCloseTo(10 + 1 + 0.5 + 0.2, 5);
    expect(arcaeaPtt(10, 9_600_000, 1)).toBeCloseTo(10 + 0.333 + 0.2, 3);
    expect(arcaeaPtt(10, 9_600_000, 0)).toBeCloseTo(10 + 0.333, 3);
    // 低于 9.5M 的线性段会被 Math.max(0, …) 兜住，CLEAR 仍 +0.2。
    expect(arcaeaPtt(1, 9_000_000, 1)).toBeCloseTo(0.2, 5);
  });

  it('判定大字：判定数优先，其次 clear_type，最后用评级', () => {
    // PM：near/miss 全 0
    expect(deriveGrade({ songId: 'x', score: 10_000_000, nearCount: 0, missCount: 0 }, 'EX+')).toEqual({
      mark: 'P',
      tone: 'gold',
      srText: 'PURE MEMORY',
    });
    // FR：miss 0 但 near > 0
    expect(deriveGrade({ songId: 'x', score: 9_990_000, nearCount: 6, missCount: 0 }, 'EX+')).toEqual({
      mark: 'F',
      tone: 'blue',
      srText: 'FULL RECALL',
    });
    // clear_type 兜底：3 = PM、2 = FR
    expect(deriveGrade({ songId: 'x', score: 9_990_000, clearType: 3 }, 'EX+').mark).toBe('P');
    expect(deriveGrade({ songId: 'x', score: 9_990_000, clearType: 2 }, 'EX+').mark).toBe('F');
    // 其余显示评级
    expect(deriveGrade({ songId: 'x', score: 9_600_000, clearType: 1 }, 'AA')).toEqual({
      mark: 'AA',
      tone: 'neutral',
      srText: 'AA',
    });
  });

  it('判定统计行与时长换挡', () => {
    expect(formatJudgements({ songId: 'x', score: 1, perfectCount: 1200, shinyPerfectCount: 1100, nearCount: 3, missCount: 0 }))
      .toBe('P 1200 (+1100) / F 3 / L 0');
    expect(formatJudgements({ songId: 'x', score: 1 })).toBe('P — / F — / L —');
    expect(formatPlayTime(45)).toBe('45m');
    expect(formatPlayTime(90)).toBe('1h');
    expect(formatPlayTime(60 * 24 * 2)).toBe('2d');
    expect(formatPlayTime(null)).toBeNull();
  });

  it('契约层 GameScore（native 携带 arcaea 原始字段）可直接喂给渲染器', () => {
    // 装配层从 /v1/games/arcaea/profiles/{id}/bests 拿到的就是 GameScore，
    // arcaea 的 clear_type / 判定数 / constant 都在 native 里。
    const items: GameScore[] = [
      {
        scoreId: 'score-1',
        songId: 'testify',
        songName: 'Testify',
        type: 'BYD',
        difficulty: 'BYD',
        levelIndex: 3,
        level: '12',
        achievements: null,
        score: 9_950_000,
        rating: 12.3,
        rank: 'EX+',
        dxScore: null,
        dxStar: null,
        fc: null,
        fs: null,
        playTime: null,
        native: {
          perfect_count: 1000,
          shiny_perfect_count: 950,
          near_count: 5,
          miss_count: 0,
          clear_type: 2,
          constant: 11.5,
        },
      },
    ];
    const data = buildArcTemplateData(
      { profileName: 'P', potential: 12.3, items, computedAt: FIXED_COMPUTED_AT },
      assets,
      { now: FIXED_NOW },
    );
    expect(data.cards).toHaveLength(1);
    const card = data.cards[0]!;
    expect(card.title).toBe('Testify');
    expect(card.primaryValue).toBe("9'950'000");
    expect(card.difficulty).toBe('BYD');
    expect(card.levelText).toBe('12');
    expect(card.ratingConstant).toBe('11.5');
    expect(card.ratingValue).toBe('12.3000');
    // miss=0 且 near>0 → FULL RECALL（判定数优先于 clear_type=2，两者一致）
    expect(card.gradeMark).toBe('F');
    expect(card.gradeSrText).toBe('FULL RECALL');
    expect(card.secondaryValue).toBe('P 1000 (+950) / F 5 / L 0');
    expect(data.diagnostics.coversFound).toBe(1);
  });

  it('数字难度（RankHub 口径 0/1/2/3/4）还原成 PST/PRS/FTR/BYD/ETR', () => {
    const data = buildArcTemplateData(
      {
        profileName: 'Hikari',
        potential: 12.3,
        computedAt: FIXED_COMPUTED_AT,
        items: [
          { songId: 'testify', score: 10_000_000, difficulty: '3', levelIndex: 3, constant: 11.5 },
          { songId: 'testify', score: 9_900_000, difficulty: '2', levelIndex: 2, constant: 11.0 },
          { songId: 'testify', score: 9_800_000, difficulty: '0', levelIndex: 0, constant: 5.0 },
        ],
      },
      assets,
      { now: FIXED_NOW },
    );
    expect(data.cards.map((card) => card.difficulty)).toEqual(['BYD', 'FTR', 'PST']);
    // 名称不是下标数字。
    for (const card of data.cards) expect(card.difficulty).not.toMatch(/^\d+$/);
  });

  it('INS 靠 ratingClassAlias 与 BYD 区分（对齐 App slot 规则）', () => {
    const data = buildArcTemplateData(
      {
        profileName: 'Hikari',
        potential: 12.3,
        computedAt: FIXED_COMPUTED_AT,
        items: [
          { songId: 'testify', score: 10_000_000, difficulty: '3', levelIndex: 3, ratingClassAlias: 1 },
          { songId: 'testify', score: 9_900_000, difficulty: '3', levelIndex: 3 },
          { songId: 'testify', score: 9_800_000, difficulty: '4', levelIndex: 4 },
        ],
      },
      assets,
      { now: FIXED_NOW },
    );
    expect(data.cards.map((card) => card.difficulty)).toEqual(['INS', 'BYD', 'ETR']);
  });

  it('songId 与索引键大小写/下划线不一致时仍能取到曲名（不再显示 TRACK n）', () => {
    const [key, entry] = Object.entries(assets.index.songs)[0]!;
    expect(lookupSong(assets, key.toUpperCase())?.title).toBe(entry.title);
    expect(lookupSong(assets, `${key}_x`)?.title).toBeUndefined();
    // 通过曲名兜底（uuid/异形 id 场景）。
    expect(lookupSong(assets, '0000-uuid', entry.title)?.title).toBe(entry.title);
    // 归一化：去掉空格/下划线后能匹配。
    const spaced = entry.title.replace(/\s+/g, '_').toUpperCase();
    expect(lookupSong(assets, spaced, entry.title)?.title).toBe(entry.title);
  });

  it('songId 是 uuid 时按曲名回落到曲绘，不再缺图', () => {
    // 取索引里任意一首已知曲目，用它的标题 + 假 uuid 查询。
    const entry = Object.entries(assets.index.songs)[0]!;
    const [, song] = entry;
    const byTitle = resolveCoverFile(assets, { songId: '00000000-0000-0000-0000-000000000000', title: song.title });
    expect(byTitle).not.toBeNull();
    expect(byTitle!.endsWith('.jpg')).toBe(true);
  });

  it('playTime 为毫秒时间戳时展示相对时间（3d/5h），不是原串', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    const data = buildArcTemplateData(
      {
        profileName: 'Hikari',
        potential: 12.3,
        computedAt: FIXED_COMPUTED_AT,
        items: [
          {
            songId: 'testify',
            score: 10_000_000,
            difficulty: '2',
            levelIndex: 2,
            playTime: new Date(now - 3 * 86_400_000).toISOString(),
          },
          {
            songId: 'testify',
            score: 9_900_000,
            difficulty: '2',
            levelIndex: 2,
            playTime: new Date(now - 5 * 3_600_000).toISOString(),
          },
        ],
      },
      assets,
      { now: new Date(now) },
    );
    expect(data.cards.map((card) => card.playTime)).toEqual(['3d', '5h']);
  });

  it('模板数据：名次/难度/等级/曲名回落与索引一致', () => {
    const songs = pickFixtureSongs(assets, 5);
    const data = buildArcTemplateData(
      {
        profileName: 'Hikari',
        potential: 12.3456,
        computedAt: FIXED_COMPUTED_AT,
        items: songs.map((song, index) => ({
          songId: song.songId,
          score: 10_000_000 - index * 1000,
          constant: song.constant,
          difficulty: song.difficulty,
          level: song.level,
          clearType: 3,
          nearCount: 0,
          missCount: 0,
        })),
      },
      assets,
      { now: FIXED_NOW },
    );
    expect(data.cards).toHaveLength(5);
    // 名次连续且以 B 开头（js/app.js:98 rankMarkup）。
    expect(data.cards.map((card) => card.rankLabel)).toEqual(['B01', 'B02', 'B03', 'B04', 'B05']);
    expect(data.cards[0]!.gradeMark).toBe('P');
    expect(data.cards[0]!.diffColor).toMatch(/^#[0-9a-f]{6}$/i);
    // 曲名/等级来自曲绘索引，不会漏成 songId 以外的空白。
    expect(data.cards[0]!.title.length).toBeGreaterThan(0);
    expect(data.cards[0]!.levelText.length).toBeGreaterThan(0);
    expect(data.computedAtText).toBe('2026-10-27');
    expect(data.heroEdition).toBe('VOL. 03');
    expect(data.bestCount).toBe(5);
    expect(data.sectionTitle).toBe('BEST 5');
    expect(data.gameLogoUrl).toContain('arcaea.svg');
  });
});
