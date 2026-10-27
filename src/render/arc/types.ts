/**
 * Arcaea B50 海报渲染的输入类型。
 *
 * 两种条目都能直接喂进来（`ArcaeaRenderItem`）：
 * 1. 本模块的 `ArcaeaScore`——扁平、camelCase，适合 fixture / 手工构造；
 * 2. 契约层 `src/contracts/index.ts` 的 `GameScore`——装配层从
 *    `GET /v1/games/arcaea/profiles/{id}/bests` 拿到的东西，arcaea 原始字段在
 *    `native` 里（song_id / score / potential / clear_type / perfect_count /
 *    near_count / miss_count / rank / constant …），由 `fromGameScore` 摊平。
 *
 * 两者一律允许缺字段——渲染层用占位而不是抛异常。
 */
import type { GameScore } from '../../contracts/index.js';

/** 难度槽位（与 Arcaea 的 ratingClass 一致；5 表示 INS / 额外槽位）。 */
export type ArcaeaDifficultySlot = 0 | 1 | 2 | 3 | 4 | 5;

/** 单条成绩（B50 卡片最小字段集合 + 可选补充字段）。 */
export interface ArcaeaScore {
  /** 曲目 id（Arcaea 的 song id，例如 `testify`）。 */
  songId: string;
  /** 曲名；缺省时回落到曲绘索引里的曲名，再回落到 songId。 */
  title?: string | null;
  /** 原始分（0 ~ 10'000'000+）。 */
  score: number | null;
  /** 单曲 Potential（PTT）；缺省显示 `—`。 */
  rating?: number | null;
  /** 等级文本（`10+` / `9` 之类）；缺省用 constant 补齐。 */
  level?: string | null;
  /** 难度槽位：0 PST / 1 PRS / 2 FTR / 3 BYD / 4 ETR / 5 INS。 */
  levelIndex?: number | null;
  /**
   * INS 难度的区分字段（对齐 App `ArcaeaDifficulty.slot`：
   * `ratingClassAlias == null ? ratingClass : 5`）。
   * v1 暂不下发，缺失时 INS 会按 BYD 显示。
   */
  ratingClassAlias?: number | null;
  /** 难度名（`FTR` / `BYD` …）；优先于 levelIndex。 */
  difficulty?: string | null;
  /** 谱面定数；缺省用曲绘索引里的 constant 补齐。 */
  constant?: number | null;
  /** 通关类型：0 Track Lost / 1 Clear / 2 Full Recall / 3 Pure Memory。 */
  clearType?: number | null;
  /** 评级文本（`EX+` / `EX` / `AA` …）；缺省按分数推算。 */
  scoreRank?: string | null;
  /** 判定统计（有则优先生成 P/F/L 行与 PM/FR 判定）。 */
  perfectCount?: number | null;
  shinyPerfectCount?: number | null;
  nearCount?: number | null;
  missCount?: number | null;
  /** 单曲累计游玩时长（分钟）；缺省不显示 TIME 栏。 */
  playMinutes?: number | null;
  /** 已格式化好的游玩时长（`12h`）；优先于 playMinutes。 */
  playTime?: string | null;
  /** 直接指定曲绘文件名（相对 `vendor/arc/covers`）；缺省按 songId 查索引。 */
  coverFile?: string | null;
  /**
   * 已就绪的曲绘 URL（`data:` / `file:` / `http(s):`）。
   * 装配层可按 App 的 `songJacketUrl` 规则从 RankHub 资源 CDN 预取后以 data URL 传入；
   * 给了就优先于 `coverFile` / 本地索引。
   */
  coverUrl?: string | null;
}

/**
 * 渲染器接受的条目：本模块的 `ArcaeaScore`，或契约层的 `GameScore`（自动摊平 `native`）。
 *
 * 用并集而不是只收 `GameScore`，是因为 fixture / 单测不想构造 `native`；
 * 用并集而不是只收 `ArcaeaScore`，是为了让装配层把 `GameScore[]` 直接传进来
 * （`GameScore[]` 可赋值给 `ArcaeaRenderItem[]`）。
 */
export type ArcaeaRenderItem = ArcaeaScore | GameScore;

/** `renderArcaeaB50` 的输入（结构上兼容契约层同名类型）。 */
export interface ArcaeaB50RenderInput {
  /** 玩家名（hero 左侧）。 */
  profileName: string;
  /** 玩家 Potential；字符串原样展示（便于透传 RankHub 的精度）。 */
  potential: number | string | null;
  /** 成绩条目（超过 50 条时按单曲 PTT 取前 50）。 */
  items: ArcaeaRenderItem[];
  /** 数据生成时间（ISO 字符串或 Date）；缺省用渲染时刻。 */
  computedAt?: string | Date | null;
}
