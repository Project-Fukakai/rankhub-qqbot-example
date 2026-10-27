/**
 * RankHub Arcaea 成绩 → best-posters 海报模板数据。
 *
 * 版式完全照 best-posters 的 arcaea 分支（`js/app.js:95-126` + `css/games.css:37-124`），
 * 本文件只做「字段映射 + 缺字段兜底 + 文案」，不碰像素。
 *
 * 关键映射依据：
 * - 单曲 PTT 公式  `js/ratings.js:70-75`（与 backend arcaea-profile.service.ts 同源）
 * - 评级分档      `js/ratings.js:77-85`
 * - B50/B10 聚合  `js/ratings.js:87-96`
 * - PM / FR 判定  `js/demo-data.js:154-157`（clear_type 2=FR / 3=PM，缺判定数时用）
 * - 判定统计行    `js/demo-data.js:151`
 * - 时长换挡      `js/demo-data.js:38-45`
 * - 难度名/颜色   `js/demo-data.js:17-19`（0 PST / 1 PRS / 2 FTR / 3 BYD / 4 ETR / 5 INS）
 */
import type { GameScore } from '../../contracts/index.js';
import type { ArcAssets } from './assets.js';
import { lookupSong, resolveCoverFile, toFileUrl } from './assets.js';
import type { ArcaeaB50RenderInput, ArcaeaRenderItem, ArcaeaScore } from './types.js';

/** 难度槽位 → 展示名（best-posters 用 INS 表示第 6 槽，App 用 CHT；这里跟随 design 稿）。 */
export const DIFFICULTY_NAMES = ['PST', 'PRS', 'FTR', 'BYD', 'ETR', 'INS'] as const;

/** 难度槽位 → 主题色（`js/demo-data.js:19`）。 */
export const DIFFICULTY_COLORS = [
  '#70b9d8',
  '#8dbf81',
  '#b18acd',
  '#d36f94',
  '#aaa1ed',
  '#4f46e5',
] as const;

/** 兜底色：难度既没有名字也没有槽位时用（`js/app.js:101`）。 */
export const DEFAULT_DIFFICULTY_COLOR = '#c3c9d2';

/** B50 上限（`js/app.js:6` counts.arcaea = 50）。 */
export const BEST_VISIBLE = 50;

/** 卡片评级标识的颜色语义：PM 金 / FR 蓝 / 其余中性（`css/games.css:107-109`）。 */
export type ArcGradeTone = 'gold' | 'blue' | 'neutral';

/** 模板里一张卡片需要的全部字段（已是展示字符串，模板只负责转义与拼装）。 */
export interface ArcTemplateCard {
  /** 序号标签：`B01` / `#01`。 */
  rankLabel: string;
  rankPrefix: string;
  rankNumber: string;
  /** `<article data-chart-id>`：`songId:难度`。 */
  chartId: string;
  title: string;
  /** 难度名（`FTR`）；空串表示不画梯形标签。 */
  difficulty: string;
  /** 等级文本（`10+`）；空串表示不画梯形标签。 */
  levelText: string;
  /** 难度色（CSS `--diff`）。 */
  diffColor: string;
  coverUrl: string;
  coverMissing: boolean;
  primaryLabel: string;
  /** 分数（已按 `9'950'000` 分隔）。 */
  primaryValue: string;
  /** 判定统计行 `P 1200 (+1100) / F 3 / L 0`。 */
  secondaryValue: string;
  /** 卡片右侧大字：P / F / EX+。 */
  gradeMark: string;
  gradeTone: ArcGradeTone;
  /** 读屏用的完整判定语义（PURE MEMORY / FULL RECALL / 评级）。 */
  gradeSrText: string;
  /** 游玩时长（`12h`）；null 不显示。 */
  playTime: string | null;
  ratingValue: string;
  ratingConstant: string;
  ratingLabel: string;
  ariaLabel: string;
}

/** hero 里的一个统计块。 */
export interface ArcTemplateStat {
  label: string;
  value: string;
  caption?: string;
}

/** 模板完整数据。 */
export interface ArcTemplateData {
  profileName: string;
  profileInitial: string;
  playerCode: string;
  potentialText: string;
  metricLabel: string;
  metricCaption: string;
  subtitle: string;
  /** hero 右侧大数字（BEST n）。 */
  bestCount: number;
  heroEdition: string;
  editionYear: string;
  computedAtText: string;
  heroArtUrl: string | null;
  gameLogoUrl: string | null;
  rankhubMarkUrl: string | null;
  stats: ArcTemplateStat[];
  sectionTitle: string;
  sectionSubtitle: string;
  sectionCountLabel: string;
  sectionCount: number;
  cards: ArcTemplateCard[];
  formulaNote: string;
  /** @font-face 声明（只包含实际存在的字体文件）。 */
  fontFaceCss: string;
  diagnostics: {
    /** 有曲绘的成绩条数。 */
    coversFound: number;
    /** 回落到占位图的条数。 */
    coversMissing: number;
    /** 输入条数（未截断前）。 */
    inputCount: number;
  };
}

/** 评级分档（`js/ratings.js:77-85`）。 */
export function arcaeaGrade(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return '—';
  if (score >= 9_900_000) return 'EX+';
  if (score >= 9_800_000) return 'EX';
  if (score >= 9_500_000) return 'AA';
  if (score >= 9_200_000) return 'A';
  if (score >= 8_900_000) return 'B';
  if (score >= 8_600_000) return 'C';
  return 'D';
}

/**
 * 单曲 PTT 公式（`js/ratings.js:70-75`，与 backend
 * `apps/backend/src/games/arcaea-profile.service.ts` 同源；CLEAR 及以上 +0.2）。
 *
 * 只在输入缺 `rating` 且定数可见时兜底用；RankHub 已给出的 PTT 永远优先。
 */
export function arcaeaPtt(constant: number, score: number, clearType?: number | null): number {
  const base =
    score >= 10_000_000
      ? constant + 2
      : score >= 9_800_000
        ? constant + 1 + (score - 9_800_000) / 200_000
        : Math.max(0, constant + (score - 9_500_000) / 300_000);
  const value = base + (clearType === 0 ? 0 : 0.2);
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/** 分数千分位用半角单引号分隔（`js/demo-data.js:148`）。 */
export function formatScore(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return '—';
  return String(Math.round(score)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/** 游玩时长换挡（`js/demo-data.js:38-45`）。 */
export function formatPlayTime(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  if (total < 1440) return `${Math.floor(total / 60)}h`;
  return `${Math.floor(total / 1440)}d`;
}

/** 定数展示：一位小数；缺省 `—`（`js/app.js:84`）。 */
export function formatConstant(constant: number | null | undefined): string {
  return constant != null && Number.isFinite(constant) ? constant.toFixed(1) : '—';
}

/** 单曲 PTT 展示：4 位小数（`js/demo-data.js:147` ratingDigits=4）；缺省 `—`。 */
export function formatRating(rating: number | null | undefined): string {
  return rating != null && Number.isFinite(rating) ? rating.toFixed(4) : '—';
}

/**
 * Potential 展示：数字按 4 位小数，字符串原样透传（便于外部传 `12.3456`）。
 */
export function formatPotential(potential: number | string | null | undefined): string {
  if (potential == null) return '—';
  if (typeof potential === 'string') {
    const trimmed = potential.trim();
    return trimmed.length > 0 ? trimmed : '—';
  }
  return Number.isFinite(potential) ? potential.toFixed(4) : '—';
}

/** `computedAt` → `YYYY-MM-DD`（优先保留 ISO 里的日期部分，避免时区漂移）。 */
export function formatDate(value: string | Date | null | undefined, fallback: Date): string {
  const raw = value instanceof Date ? value.toISOString() : value?.trim();
  if (raw) {
    const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
    if (isoDate) return isoDate[1]!;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return localDate(parsed);
  }
  return localDate(fallback);
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 取首个字符（按码点，避免 emoji/代理对被劈开）。 */
function firstCharacter(value: string, fallback: string): string {
  const chars = Array.from(value.trim());
  return chars.length > 0 ? chars[0]! : fallback;
}

/** 从 `GameScore.native` 里按顺序取第一个数字字段。 */
function nativeNumber(native: Record<string, unknown> | null | undefined, ...keys: string[]): number | null {
  if (!native) return null;
  for (const key of keys) {
    const value = native[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** 从 `GameScore.native` 里按顺序取第一个字符串字段。 */
function nativeString(native: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!native) return null;
  for (const key of keys) {
    const value = native[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** 判断条目是否来自契约层 `GameScore`（有 `scoreId`/`native`，本模块的扁平类型都没有）。 */
export function isGameScore(item: ArcaeaRenderItem): item is GameScore {
  return 'scoreId' in item || 'native' in item;
}

/**
 * 契约层 `GameScore` → 扁平 `ArcaeaScore`。
 *
 * 映射口径（arcaea 的原始字段名来自 App 模型 `arcaea_models.dart:168-187` 的 `fromJson`）：
 * - `score` ← `score ?? native.score ?? achievements`（arcaea 的 score 就是 0..10'000'000 的原始分）
 * - `rating` ← `rating ?? native.potential`
 * - `rank` ← `rank ?? native.rank`
 * - `clearType` / 判定数 / `constant` ← 同名的 snake_case native 字段
 * - `playTime` 只用契约里已格式化的字符串；`native.time_played` 单位未知，**不猜**（见 docs/research/arc-b50.md §6.6）
 */
export function fromGameScore(item: GameScore): ArcaeaScore {
  const native = item.native;
  return {
    songId: item.songId,
    title: item.songName ?? nativeString(native, 'title'),
    score: item.score ?? nativeNumber(native, 'score') ?? item.achievements,
    rating: item.rating ?? nativeNumber(native, 'potential', 'rating'),
    level: item.level,
    levelIndex: item.levelIndex,
    difficulty: item.difficulty ?? item.type,
    constant: nativeNumber(native, 'constant'),
    clearType: nativeNumber(native, 'clear_type', 'clearType'),
    scoreRank: item.rank ?? nativeString(native, 'rank'),
    perfectCount: nativeNumber(native, 'perfect_count', 'perfectCount'),
    shinyPerfectCount: nativeNumber(native, 'shiny_perfect_count', 'shinyPerfectCount'),
    nearCount: nativeNumber(native, 'near_count', 'nearCount'),
    missCount: nativeNumber(native, 'miss_count', 'missCount'),
    playTime: item.playTime,
  };
}

/** 条目归一：`GameScore` 摊平，`ArcaeaScore` 原样返回。 */
export function normalizeScore(item: ArcaeaRenderItem): ArcaeaScore {
  return isGameScore(item) ? fromGameScore(item) : item;
}

interface ResolvedDifficulty {
  name: string;
  levelText: string;
  constant: number | null;
  slot: number | null;
  color: string;
}

/**
 * 解析一条成绩的难度信息。
 *
 * 优先级：item.difficulty / item.levelIndex → 曲绘索引里该曲唯一的难度 → 空。
 * 等级文本优先 item.level，其次索引里的 level，最后用定数补齐（`js/app.js:89`）。
 */
export function resolveDifficulty(item: ArcaeaScore, assets: ArcAssets): ResolvedDifficulty {
  const entry = lookupSong(assets, item.songId);
  const entryLevels = entry ? Object.values(entry.levels) : [];

  let slot: number | null = null;
  if (typeof item.levelIndex === 'number' && Number.isInteger(item.levelIndex) && item.levelIndex >= 0) {
    slot = item.levelIndex % DIFFICULTY_NAMES.length;
  }

  let name = item.difficulty?.trim().toUpperCase() ?? '';
  if (!name && slot != null) name = DIFFICULTY_NAMES[slot] ?? '';
  if (!name) {
    // 索引里该曲只有一档难度时直接借用（best-posters 每首歌正好一条谱面）。
    const only = entryLevels.length === 1 ? entryLevels[0] : undefined;
    if (only) {
      name = only.difficulty.trim().toUpperCase();
      if (slot == null && only.difficultyIndex != null) slot = only.difficultyIndex % DIFFICULTY_NAMES.length;
    }
  }
  if (slot == null && name) {
    const index = DIFFICULTY_NAMES.indexOf(name as (typeof DIFFICULTY_NAMES)[number]);
    if (index >= 0) slot = index;
  }

  const matched = name ? entry?.levels[name] : undefined;
  const constant = item.constant ?? matched?.constant ?? null;
  const levelText = (item.level?.trim() || matched?.level?.trim() || (constant != null ? String(constant) : '')) ?? '';
  const color =
    slot != null ? (DIFFICULTY_COLORS[slot] ?? DEFAULT_DIFFICULTY_COLOR) : DEFAULT_DIFFICULTY_COLOR;

  return { name, levelText, constant, slot, color };
}

/**
 * 判定 / 评级大字（`js/app.js:71-81` + `js/demo-data.js:154-157`）。
 *
 * 判定数齐全时以判定为准（与 App `arcaea_b50_poster.dart` 的 status 推导一致），
 * 否则退回 clear_type：2 = FR、≥3 = PM。评级用 scoreRank，缺省按分数推算。
 */
export function deriveGrade(
  item: ArcaeaScore,
  scoreRank: string,
): { mark: string; tone: ArcGradeTone; srText: string } {
  const near = item.nearCount;
  const miss = item.missCount;
  const hasCounts = typeof near === 'number' && typeof miss === 'number';
  const clearType = item.clearType;

  const pureMemory = hasCounts ? near === 0 && miss === 0 : typeof clearType === 'number' && clearType >= 3;
  const fullRecall = !pureMemory
    ? hasCounts
      ? miss === 0
      : clearType === 2
    : false;

  if (pureMemory) return { mark: 'P', tone: 'gold', srText: 'PURE MEMORY' };
  if (fullRecall) return { mark: 'F', tone: 'blue', srText: 'FULL RECALL' };
  return { mark: scoreRank, tone: 'neutral', srText: scoreRank };
}

/** 判定统计行（`js/demo-data.js:151`）；缺判定数时用 `—` 占位。 */
export function formatJudgements(item: ArcaeaScore): string {
  const part = (value: number | null | undefined): string =>
    typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '—';
  const shiny = typeof item.shinyPerfectCount === 'number' && Number.isFinite(item.shinyPerfectCount)
    ? ` (+${Math.round(item.shinyPerfectCount)})`
    : '';
  return `P ${part(item.perfectCount)}${shiny} / F ${part(item.nearCount)} / L ${part(item.missCount)}`;
}

/**
 * 排序：单曲 PTT 降序（`js/ratings.js:87-89`）。
 *
 * RankHub 的 B50 本来就是按 PTT 排好的，这里再排一次只是为了保证
 * "渲染层自己决定顺序"——输入顺序变化不会让海报顺序乱掉。
 */
export function sortArcaeaScores(items: readonly ArcaeaScore[]): ArcaeaScore[] {
  const weight = (value: number | null | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : -Infinity;
  return [...items].sort(
    (left, right) =>
      weight(right.rating) - weight(left.rating) ||
      weight(right.score) - weight(left.score) ||
      right.songId.localeCompare(left.songId) ||
      (right.levelIndex ?? -1) - (left.levelIndex ?? -1),
  );
}

function buildFontFaceCss(assets: ArcAssets): string {
  return assets.fonts
    .map((font) => {
      // pathToFileURL 已经百分号编码了中文文件名，这里只兜掉会破坏 CSS url() 的字符。
      const url = toFileUrl(`${assets.fontsDir}/${font.file}`).replace(/["'\\\n\r]/g, '%22');
      return `@font-face{font-family:${font.family};src:url("${url}") format("truetype");font-weight:${font.weight};font-display:block}`;
    })
    .join('\n');
}

/** 一条成绩解析后的中间结果（排序与出图共用，避免二次解析）。 */
interface ResolvedItem {
  item: ArcaeaScore;
  difficulty: ResolvedDifficulty;
  title: string;
  scoreRank: string;
  /** 有效 PTT：RankHub 给值优先，缺失时按定数+分数兜底。 */
  rating: number | null;
}

/** 解析一条成绩：难度 / 曲名 / 评级 / 有效 PTT。 */
function resolveItem(item: ArcaeaScore, assets: ArcAssets, fallbackTitle: string): ResolvedItem {
  const difficulty = resolveDifficulty(item, assets);
  const entry = lookupSong(assets, item.songId);
  const title = (item.title?.trim() || entry?.title || fallbackTitle).trim();
  const scoreRank = (item.scoreRank?.trim().toUpperCase() || arcaeaGrade(item.score)).trim();
  // RankHub 给出的 PTT 优先；缺失时用「定数 + 分数」按同一公式兜底，而不是直接显示 —。
  const rating =
    typeof item.rating === 'number' && Number.isFinite(item.rating)
      ? item.rating
      : difficulty.constant != null && typeof item.score === 'number' && Number.isFinite(item.score)
        ? arcaeaPtt(difficulty.constant, item.score, item.clearType ?? null)
        : null;
  return { item, difficulty, title, scoreRank, rating };
}

/** 一张卡片的数据（`js/app.js:117-125` 的 arcaea 分支）。 */
function buildCard(resolved: ResolvedItem, rank: number, assets: ArcAssets): ArcTemplateCard {
  const { item, difficulty, title, scoreRank, rating } = resolved;
  const coverPath = resolveCoverFile(assets, { songId: item.songId, coverFile: item.coverFile ?? null });
  const coverMissing = coverPath === null;
  const grade = deriveGrade(item, scoreRank);
  const rankLabel = `B${String(rank).padStart(2, '0')}`;
  const playTime = item.playTime?.trim() || formatPlayTime(item.playMinutes);

  return {
    rankLabel,
    rankPrefix: 'B',
    rankNumber: String(rank).padStart(2, '0'),
    chartId: `${item.songId}:${difficulty.name || 'UNKNOWN'}`,
    title,
    difficulty: difficulty.name,
    levelText: difficulty.levelText,
    diffColor: difficulty.color,
    coverUrl: coverMissing ? assets.placeholderUrl : toFileUrl(coverPath),
    coverMissing,
    primaryLabel: 'SCORE',
    primaryValue: formatScore(item.score),
    secondaryValue: formatJudgements(item),
    gradeMark: grade.mark,
    gradeTone: grade.tone,
    gradeSrText: grade.srText,
    playTime,
    ratingValue: formatRating(rating),
    ratingConstant: formatConstant(difficulty.constant),
    ratingLabel: 'PTT',
    ariaLabel: `${rankLabel} ${title} ${difficulty.name} ${difficulty.levelText} SCORE ${formatScore(item.score)}`,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** 海报底部的公式/口径说明。 */
export const FORMULA_NOTE =
  '单曲 PTT 与总 Potential 均来自 RankHub；B50 按单曲 PTT 降序取前 50，前 10 首额外计入 B10。';

/**
 * 构造模板数据。
 *
 * @param input 渲染输入
 * @param assets 素材集合
 * @param options.now 渲染时刻（测试固定用）
 */
export function buildArcTemplateData(
  input: ArcaeaB50RenderInput,
  assets: ArcAssets,
  options: { now?: Date } = {},
): ArcTemplateData {
  const now = options.now ?? new Date();
  // 契约层 GameScore 摊平成扁平 ArcaeaScore；两种形状混着传也可以。
  const allItems = Array.isArray(input.items)
    ? input.items
        .filter((item) => item && typeof item.songId === 'string')
        .map((item) => normalizeScore(item))
    : [];
  // 用「有效 PTT」排序（含兜底算出来的），保证名次与卡片右下角的数字自洽。
  const resolved = allItems
    .map((item, index) => resolveItem(item, assets, `TRACK ${index + 1}`))
    .sort(
      (left, right) =>
        (right.rating ?? -Infinity) - (left.rating ?? -Infinity) ||
        (right.item.score ?? -Infinity) - (left.item.score ?? -Infinity) ||
        right.item.songId.localeCompare(left.item.songId) ||
        (right.item.levelIndex ?? -1) - (left.item.levelIndex ?? -1),
    )
    .slice(0, BEST_VISIBLE);
  const cards = resolved.map((entry, index) => buildCard(entry, index + 1, assets));

  const ratings = resolved
    .map((entry) => entry.rating)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const b50Average = ratings.length > 0 ? average(ratings) : null;
  const b10Average = ratings.length > 0 ? average(ratings.slice(0, 10)) : null;
  const exPlusCount = resolved.filter(
    (entry) =>
      typeof entry.item.score === 'number' && Number.isFinite(entry.item.score) && entry.item.score >= 9_900_000,
  ).length;

  const firstCover = cards.find((card) => !card.coverMissing)?.coverUrl ?? null;
  const computedAtText = formatDate(input.computedAt, now);
  const editionYear = computedAtText.slice(0, 4);

  const stats: ArcTemplateStat[] = [
    { label: 'B50 AVG', value: b50Average == null ? '—' : b50Average.toFixed(2), caption: '单曲 PTT 均值' },
    { label: 'B10 AVG', value: b10Average == null ? '—' : b10Average.toFixed(2), caption: '前 10 首均值' },
    { label: 'EX+', value: String(exPlusCount), caption: `Best ${cards.length}` },
  ];

  return {
    profileName: input.profileName?.trim() || 'PLAYER',
    profileInitial: firstCharacter(input.profileName ?? '', '?'),
    playerCode: 'RANKHUB',
    potentialText: formatPotential(input.potential),
    metricLabel: 'POTENTIAL',
    metricCaption: 'B50 + B10 · RANKHUB 数据',
    subtitle: 'BEYOND THE MEMORY · POTENTIAL ARCHIVE',
    bestCount: cards.length,
    // Arcaea 在 best-posters 的七款游戏里排第 3（`js/app.js:4,153`）。
    heroEdition: 'VOL. 03',
    editionYear,
    computedAtText,
    heroArtUrl: firstCover,
    gameLogoUrl: assets.gameLogoUrl,
    rankhubMarkUrl: assets.rankhubMarkUrl,
    stats,
    sectionTitle: `BEST ${cards.length}`,
    sectionSubtitle: '单曲 Potential 降序 · 前 10 首权重 ×2',
    sectionCountLabel: 'COUNTED RECORDS',
    sectionCount: cards.length,
    cards,
    formulaNote: FORMULA_NOTE,
    fontFaceCss: buildFontFaceCss(assets),
    diagnostics: {
      coversFound: cards.filter((card) => !card.coverMissing).length,
      coversMissing: cards.filter((card) => card.coverMissing).length,
      inputCount: allItems.length,
    },
  };
}
