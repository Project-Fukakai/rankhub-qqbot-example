/**
 * maimaiDX b50 绘制常量（严格照抄上游 Python 的坐标与配色）。
 *
 * 上游来源：maimaiDX commit 1154ad676238ab45a76a70c23648f7a6d881e53c
 *   - core/image/best50.py  （头部：logo/名牌/头像/rating牌/段位/Class/称号条/页脚）
 *   - core/image/base.py    （成绩卡网格与文字坐标）
 *   - core/image/assets.py  （难度配色、文字配色）
 *   - constants.py          （RANK_MAP / COMBO_MAP / SYNC_MAP）
 *
 * 所有数字都是上游的原始像素值，改这里等于偏离参考图，需同步更新
 * evidence/qqbot/render/maimai-spike.md 里的差异基线。
 */

/** 主题枚举（Theme.PRISM_PLUS / Theme.CIRCLE）。 */
export type MaiTheme = 'prism_plus' | 'circle';

/** 主题主色：页脚文字颜色。 */
export const THEME_COLOR: Record<MaiTheme, string> = {
  prism_plus: 'rgb(124,129,255)',
  circle: 'rgb(249,62,172)',
};

/** 难度索引 → pic/b50_score_<name>.png */
export const DIFF_NAMES = ['basic', 'advanced', 'expert', 'master', 'remaster'] as const;

/** 成绩文字配色（assets.AssetsImage._diff_text_color） */
export const DIFF_TEXT_COLORS = [
  'rgb(255,255,255)',
  'rgb(255,255,255)',
  'rgb(255,255,255)',
  'rgb(255,255,255)',
  'rgb(138,0,226)',
] as const;

/** 曲目 ID 文字配色（assets.AssetsImage._id_text_color） */
export const ID_TEXT_COLORS = [
  'rgb(129,217,85)',
  'rgb(245,189,21)',
  'rgb(255,129,141)',
  'rgb(159,81,220)',
  'rgb(138,0,226)',
] as const;

/** constants.RANK_MAP：小写评价 → UI_TTR_Rank_<X>.png */
export const RANK_MAP: Record<string, string> = {
  d: 'D',
  c: 'C',
  b: 'B',
  bb: 'BB',
  bbb: 'BBB',
  a: 'A',
  aa: 'AA',
  aaa: 'AAA',
  s: 'S',
  sp: 'Sp',
  ss: 'SS',
  ssp: 'SSp',
  sss: 'SSS',
  sssp: 'SSSp',
};

/** constants.COMBO_MAP：fc 类型 → UI_MSS_MBase_Icon_<X>.png */
export const COMBO_MAP: Record<string, string> = {
  fc: 'FC',
  fcp: 'FCp',
  ap: 'AP',
  app: 'APp',
};

/** constants.SYNC_MAP：fs 类型 → UI_MSS_MBase_Icon_<X>.png */
export const SYNC_MAP: Record<string, string> = {
  fs: 'FS',
  fsp: 'FSp',
  fsd: 'FSD',
  fdx: 'FSD',
  fsdp: 'FSDp',
  fdxp: 'FSDp',
  sync: 'Sync',
};

/** 成绩卡网格（base.ScoreBaseImage.whiledraw）。 */
export const GRID = {
  gap: 114,
  dxStep: 276,
  startX: 16,
  sdInitialY: 235,
  dxInitialY: 1085,
} as const;

/** 成绩卡内部元素相对偏移（base.py 中 x+/y+ 的常量）。 */
export const CARD = {
  cover: { dx: 12, dy: 12, size: 75 },
  type: { dx: 51, dy: 91, w: 37, h: 14 },
  rate: { dx: 92, dy: 78, w: 63, h: 28 },
  fc: { dx: 154, dy: 77, size: 34 },
  fs: { dx: 185, dy: 77, size: 34 },
  dxStar: { dx: 217, dy: 80, w: 47, h: 26 },
  songId: { dx: 26, dy: 98, size: 13 },
  title: { dx: 93, dy: 14, size: 14, maxColumns: 18, clipColumns: 17 },
  achievements: { dx: 93, dy: 38, size: 30 },
  dxScore: { dx: 219, dy: 65, size: 15 },
  levelValue: { dx: 93, dy: 65, size: 15 },
} as const;

/** 头部元素坐标（best50.PlayerBest50.draw）。 */
export const HEADER = {
  logo: { x: 14, y: 60, w: 249, h: 120 },
  plate: { x: 300, y: 60, w: 800, h: 130 },
  icon: { x: 305, y: 65, w: 120, h: 120 },
  dxRatingPlate: { x: 435, y: 72, w: 186, h: 35 },
  dxRatingStarCircle: { x: 590, y: 72, w: 21, h: 35 },
  ratingNum: { x: 520, y: 80, gap: 15, w: 17, h: 20 },
  ratingNumCircle: { x: 515, y: 82, gap: 13, w: 14, h: 17 },
  dxRatingPlateCircle: { x: 435, y: 72, w: 170, h: 35 },
  nameText: { x: 445, y: 135, size: 20 },
  nameImage: { x: 435, y: 115 },
  daniPlate: { x: 625, y: 120, w: 80, h: 32 },
  classPlate: { x: 620, y: 60, w: 90, h: 54 },
  trophyBar: { x: 435, y: 160, w: 270, h: 27 },
  trophyText: { x: 570, y: 172, size: 14 },
  footer: { x: 700, y: 1570, size: 22, stroke: 5 },
} as const;

/** 评级牌底图档位（best50._find_ra_pic 的 thresholds）。 */
export const RA_PIC_THRESHOLDS: readonly (readonly [number, string])[] = [
  [1000, '01'],
  [2000, '02'],
  [4000, '03'],
  [7000, '04'],
  [10000, '05'],
  [12000, '06'],
  [13000, '07'],
  [14000, '08'],
  [14500, '09'],
  [15000, '10'],
];

/** CIRCLE 主题 14000+ 的星星档位（best50._ra_pic_star）。 */
export const RA_STAR_THRESHOLDS = [
  14000, 14250, 14500, 14750, 15000, 15250, 15500, 15750, 16000, 16250, 16500, 16750,
] as const;
export const RA_STAR_NUMS = [1, 2, 1, 2, 1, 2, 3, 4, 1, 2, 3, 4] as const;

/** 评级牌图片名（PRISM PLUS 主题 / CIRCLE 主题共用同一批 UI_CMN_DXRating_XX.png）。 */
export function findRaPic(rating: number): string {
  for (const [limit, num] of RA_PIC_THRESHOLDS) {
    if (rating < limit) return `UI_CMN_DXRating_${num}.png`;
  }
  return 'UI_CMN_DXRating_11.png';
}

/** CIRCLE 主题的 rating 星星图（bisect_right - 1）。 */
export function findRaStarPic(rating: number): string {
  let idx = -1;
  for (let i = 0; i < RA_STAR_THRESHOLDS.length; i += 1) {
    if (RA_STAR_THRESHOLDS[i]! <= rating) idx = i;
  }
  if (idx < 0) idx = 0;
  const num = RA_STAR_NUMS[idx]!;
  return `UI_CMN_DXRating_Star_0${num}.png`;
}

/** 段位牌编号：course_rank <= 10 用原值，否则 +1（跳过 11 号）。 */
export function daniPlateNum(courseRank: number): string {
  const num = courseRank <= 10 ? courseRank : courseRank + 1;
  return String(num).padStart(2, '0');
}
