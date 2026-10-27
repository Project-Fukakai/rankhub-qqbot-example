/**
 * 渲染测试 fixture：固定 30 条 / 12 条 phigros 成绩。
 *
 * 曲目 id 来自曲库快照（scripts/fetch-assets-phi.mjs 拉取的 songs.json），
 * 分数/准确率都是写死的常量，保证同一份素材下渲染结果稳定可比。
 *
 * 刻意不填 `rating`：走渲染器的兜底路径（用定数 + 准确率按 phi-plugin 公式算单曲 rks），
 * 顺带覆盖 `fCompute.rks` 的移植逻辑；分数也按 Phigros 口径由准确率反推。
 */
import type { GameScore, PhigrosRksRenderInput } from '../../../src/contracts/index.js';

/** 30 首真实存在的曲目 id（曲绘缓存里均有对应文件）。 */
export const REAL_SONG_IDS = [
  'Glaciaxion.SunsetRay.0',
  'EradicationCatastrophe.NceS.0',
  'Credits.Frums.0',
  'Dlyrotz.Likey.0',
  'EnginexStartmelodymix.CrossingSound.0',
  '光.姜米條.0',
  'Wintercube.CtymaxfeatNceS.0',
  'Cipher20.TetrajectoryfeatCtymax.0',
  '混乱Confusion.OnlyMyBlackScore.0',
  'FULiAUTOSHOOTER.MYUKKE.0',
  'HumaN.SOTUI.0',
  'PRAW.Bluewind.0',
  'PixelRebelz.Normal1zer.0',
  'Cereris.SunsetRayNceS.0',
  'NonMelodicRagezMUGEdit.Normal1zer.0',
  'SultanRage.MonstDeath.0',
  'ClassMemories.AntistarfeatCtymax.0',
  'SURREALISM.Itsuki.0',
  'BonusTime.MegaloPaleWhite.0',
  'ENERGYSYNERGYMATRIX.Tanchiky.0',
  'NYA.FLuoRiTe姜米條.0',
  'JunXionBetweenLifeAndDeathVIPMix.1N6Fs.0',
  'cryout.JuE.0',
  'Reimei.影虎.0',
  '尊師TheGuru.rider.0',
  'Spasmodic.姜米條颶風元力上人.0',
  'LeaveAllBehind.rider.0',
  'ColorfulDays.P4koofeatつゆり花鈴.0',
  'microwav.dandeless.0',
  '重生.姜米條.0',
] as const;

const DIFFICULTIES = ['IN', 'AT', 'IN', 'HD'] as const;
const LEVELS = { EZ: '6.0', HD: '10.5', IN: '15.0', AT: '15.8' } as const;

interface FixtureScoreOptions {
  accuracy: number;
  type?: (typeof DIFFICULTIES)[number];
  fc?: string | null;
}

/** 按 Phigros 口径由准确率反推分数（acc 为百分比）。 */
export function scoreFromAccuracy(accuracy: number): number {
  return Math.min(1_000_000, Math.round(accuracy * 10_000));
}

function fixtureScore(
  index: number,
  songId: string,
  options: FixtureScoreOptions,
): GameScore {
  const type = options.type ?? DIFFICULTIES[index % DIFFICULTIES.length]!;
  const accuracy = Math.min(100, Math.max(0, options.accuracy));
  return {
    scoreId: `fixture-${index}`,
    songId,
    songName: null,
    type,
    difficulty: null,
    levelIndex: ['EZ', 'HD', 'IN', 'AT'].indexOf(type),
    level: LEVELS[type],
    achievements: accuracy,
    score: scoreFromAccuracy(accuracy),
    rating: null,
    rank: null,
    dxScore: null,
    dxStar: null,
    fc: options.fc ?? null,
    fs: null,
    playTime: null,
    native: null,
  };
}

/** 30 条：覆盖 IN / AT / HD，含 phi、FC 与逐条走 `phiRks` 兜底的单曲 rks。 */
export function buildThirtySongInput(): PhigrosRksRenderInput {
  const phi = [
    fixtureScore(0, REAL_SONG_IDS[0], { accuracy: 100, type: 'IN' }),
    fixtureScore(1, REAL_SONG_IDS[1], { accuracy: 100, type: 'HD' }),
    fixtureScore(2, REAL_SONG_IDS[2], { accuracy: 100, type: 'AT' }),
  ];
  const best = Array.from({ length: 30 }, (_, i) =>
    fixtureScore(i, REAL_SONG_IDS[i]!, {
      accuracy: 100 - i * 0.29,
      // 每 9 条一个 FC，覆盖 otherimg/FC.png 分支。
      fc: i % 9 === 0 ? 'FC' : null,
    }),
  );
  return {
    profileName: '测试玩家',
    rks: 15.4321,
    officialRks: 15.4321,
    phi,
    best,
    computedAt: '2026-10-27T04:00:00.000Z',
  };
}

/** 12 条：少于 30 条时不能出现 OVER FLOW 段。 */
export function buildTwelveSongInput(): PhigrosRksRenderInput {
  const phi = [fixtureScore(0, REAL_SONG_IDS[3], { accuracy: 100, type: 'IN' })];
  const best = Array.from({ length: 12 }, (_, i) =>
    fixtureScore(i, REAL_SONG_IDS[i + 3]!, { accuracy: 99.6 - i * 0.61 }),
  );
  return {
    profileName: '十二首测试',
    rks: 13.7654,
    officialRks: null,
    phi,
    best,
    computedAt: '2026-10-27T04:00:00.000Z',
  };
}

/** 曲库里查不到的 songId：走占位曲绘，仍必须渲染成功。 */
export function buildMissingCoverInput(): PhigrosRksRenderInput {
  const base = buildTwelveSongInput();
  const missing = fixtureScore(99, 'RankHub.Fixture.UnknownSong.0', {
    accuracy: 96.5,
    type: 'IN',
  });
  missing.songName = 'Unknown Song (no cover)';
  return { ...base, best: [missing, ...base.best.slice(0, 11)] };
}
