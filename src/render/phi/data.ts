/**
 * `PhigrosRksRenderInput` → phi-plugin b19.art 模板数据。
 *
 * 字段语义严格对齐 phi-plugin 的 `Save.getB19()` / `LevelRecordInfo`：
 * - `b19_list[].rank` 是**难度**（EZ/HD/IN/AT），不是评级；模板用它拼 `rank-*` / `info-*` 类名。
 * - `b19_list[].Rating` 是**评级图标名**（phi/FC/V/S/A/B/C/F），模板拼 `otherimg/<Rating>.png`。
 * - `difficulty` 是定数（模板 `toFixed(1)`），`rks` 是单曲等效 rks（模板 `toFixed(2)`），
 *   `acc` 是准确率（模板 `toFixed(2)` + `%`）。
 *
 * RankHub 输入缺少的字段（推分建议、同 rks 平均 acc、旧定数对比、B30 分析、逐难度通关统计、
 * ChallengeMode）一律留空或注入 CSS 隐藏，不做任何猜测性填值。
 */
import { pathToFileURL } from 'node:url';

import type { GameScore, PhigrosRksRenderInput } from '../../contracts/index.js';
import {
  PHI_PLUGIN_DISPLAY_NAME,
  PHI_PLUGIN_VERSION,
  placeholderCoverPath,
  resolveCoverFile,
  type PhiAssets,
  type PhiLevels,
} from './assets.js';

export const LEVEL_KEYS = ['EZ', 'HD', 'IN', 'AT'] as const;
export type PhiLevelKey = (typeof LEVEL_KEYS)[number];

/** 模板里 b19 卡片区最多 27 条，之后进 OVER FLOW。 */
export const BEST_VISIBLE = 27;
/** phi 卡片最多 3 条（phi-plugin `getB19` 的默认上限）。 */
export const PHI_VISIBLE = 3;

export interface PhiTemplateSong {
  song: string;
  illustration: string;
  /** 难度：EZ / HD / IN / AT（决定模板的 rank-*、info-* 与颜色）。 */
  rank: PhiLevelKey;
  difficulty: number;
  rks: number;
  score: number;
  acc: number;
  /** 评级图标名：phi / FC / V / S / A / B / C / F。 */
  Rating: string;
  num?: number;
  suggest?: string;
}

export interface PhiTemplateGameUser {
  PlayerId: string;
  rks: number;
  avatar: string;
  /** 无挑战模式数据：固定 '0'，并由 overrides CSS 隐藏该块。 */
  ChallengeMode: string;
  ChallengeModeRank: number;
  data: string;
}

export interface PhiTemplateData {
  _res_path: string;
  defaultLayout: string;
  theme: string;
  background?: string;
  gameuser: PhiTemplateGameUser;
  Date: string;
  phi: PhiTemplateSong[];
  b19_list: PhiTemplateSong[];
  stats: unknown[];
  spInfo: string[];
  b30Analysis: null;
  Version: { ver: string; phigros: string; phigrosVerNum: number };
  _plugin: string;
  sys: { scale: string; copyright: string };
  renderNoJs: boolean;
  quality: number;
}

/** phi-plugin `fCompute.formatDate` 的默认格式。 */
export function formatDate(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return [
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 把任意难度写法归一成 EZ/HD/IN/AT；无法识别返回 null。 */
export function normalizeLevelKey(value: unknown): PhiLevelKey | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (key === 'EZ' || key === 'EASY') return 'EZ';
  if (key === 'HD' || key === 'HARD') return 'HD';
  if (key === 'IN' || key === 'INSANE') return 'IN';
  if (key === 'AT' || key === 'ANOTHER') return 'AT';
  return null;
}

function levelKeyOf(score: GameScore): PhiLevelKey {
  for (const candidate of [score.type, score.difficulty]) {
    const key = normalizeLevelKey(candidate);
    if (key) return key;
  }
  const index = score.levelIndex;
  if (typeof index === 'number' && index >= 0 && index < LEVEL_KEYS.length) {
    return LEVEL_KEYS[index]!;
  }
  const fromLevel = normalizeLevelKey(score.level);
  if (fromLevel) return fromLevel;
  const fromRank = normalizeLevelKey(score.rank);
  if (fromRank) return fromRank;
  return 'IN';
}

interface SongsLookup {
  /** songId / 曲名（小写）→ 索引 key。 */
  byName: Map<string, string>;
}

function buildLookup(assets: PhiAssets): SongsLookup {
  const byName = new Map<string, string>();
  for (const [id, entry] of Object.entries(assets.songs.songs)) {
    byName.set(id.toLowerCase(), id);
    if (entry.name) byName.set(entry.name.toLowerCase(), id);
  }
  return { byName };
}

function lookupSong(assets: PhiAssets, lookup: SongsLookup, score: GameScore): string | null {
  const byId = assets.songs.songs[score.songId];
  if (byId) return score.songId;
  const lowered = score.songId?.toLowerCase();
  if (lowered && lookup.byName.has(lowered)) return lookup.byName.get(lowered)!;
  const name = score.songName?.toLowerCase();
  if (name && lookup.byName.has(name)) return lookup.byName.get(name)!;
  return null;
}

/** 曲绘 `file://` URL：优先本地缓存，缺失时用占位图（保证 <img> 永远可解码）。 */
function illustrationUrl(assets: PhiAssets, songId: string | null): string {
  const entry = songId ? assets.songs.songs[songId] : undefined;
  const cover = resolveCoverFile(assets.coversDir, entry);
  const file = cover ?? placeholderCoverPath(assets.coversDir, assets.songs);
  return pathToFileURL(file).href;
}

function levelsOf(entry: { levels?: PhiLevels } | undefined): PhiLevels {
  return entry?.levels ?? {};
}

/**
 * 准确率（0~100）。RankHub 的 `achievements` 口径未在契约中固定：
 * 小于等于 100 视为百分比，否则按 0~1000000 的分数口径换算。
 */
export function resolveAcc(score: GameScore): number {
  const achievements = toFiniteNumber(score.achievements);
  if (achievements != null) {
    if (achievements > 100) return Math.min(100, achievements / 10000);
    return Math.min(100, Math.max(0, achievements));
  }
  const raw = toFiniteNumber(score.score);
  if (raw != null) return Math.min(100, Math.max(0, raw / 10000));
  return 0;
}

/** 分数 0~1000000。缺失时由准确率反推（四舍五入到整数）。 */
export function resolveScore(score: GameScore): number {
  const raw = toFiniteNumber(score.score);
  if (raw != null) return Math.round(Math.min(1000000, Math.max(0, raw)));
  const acc = resolveAcc(score);
  return Math.min(1000000, Math.round(acc * 10000));
}

function hasFullCombo(score: GameScore): boolean {
  const fc = score.fc;
  if (typeof fc !== 'string') return false;
  const normalized = fc.trim().toLowerCase();
  return normalized !== '' && normalized !== 'none' && normalized !== 'false' && normalized !== '0' && normalized !== 'no';
}

/** 与 phi-plugin `LevelRecordInfo` 的 `Rating(score, fc)` 完全一致。 */
export function phiRating(scoreValue: number, fc: boolean): string {
  if (scoreValue >= 1000000) return 'phi';
  if (fc) return 'FC';
  if (!scoreValue) return 'NEW';
  if (scoreValue < 700000) return 'F';
  if (scoreValue < 820000) return 'C';
  if (scoreValue < 880000) return 'B';
  if (scoreValue < 920000) return 'A';
  if (scoreValue < 960000) return 'S';
  return 'V';
}

/** phi-plugin `fCompute.rks(acc, difficulty)`。 */
export function phiRks(acc: number, difficulty: number): number {
  if (!Number.isFinite(difficulty) || difficulty <= 0) return 0;
  if (!Number.isFinite(acc)) return 0;
  if (acc >= 100) return difficulty;
  if (acc < 70) return 0;
  const ratio = (acc - 55) / 45;
  return difficulty * ratio * ratio;
}

function resolveDifficulty(score: GameScore, entry: { levels?: PhiLevels } | undefined): number {
  const levels = levelsOf(entry);
  const key = levelKeyOf(score);
  const fromIndex = toFiniteNumber(levels[key]);
  if (fromIndex != null) return fromIndex;
  const fromLevel = toFiniteNumber(score.level);
  if (fromLevel != null) return fromLevel;
  const fromDifficulty = toFiniteNumber(score.difficulty);
  if (fromDifficulty != null) return fromDifficulty;
  return 0;
}

export interface BuildDataOptions {
  /** 渲染时间（Date 字段，格式 YYYY/MM/DD hh:mm:ss）。 */
  now?: Date;
  /** b19 模板主题，phi-plugin 默认 star。 */
  theme?: string;
}

function mapSong(
  score: GameScore,
  assets: PhiAssets,
  lookup: SongsLookup,
  extra: { num?: number } = {},
): PhiTemplateSong {
  const songId = lookupSong(assets, lookup, score);
  const entry = songId ? assets.songs.songs[songId] : undefined;
  const difficulty = resolveDifficulty(score, entry);
  const acc = resolveAcc(score);
  const scoreValue = resolveScore(score);
  const rating = phiRating(scoreValue, hasFullCombo(score));
  const rks = toFiniteNumber(score.rating);
  const mapped: PhiTemplateSong = {
    song: score.songName?.trim() || entry?.name || score.songId,
    illustration: illustrationUrl(assets, songId),
    rank: levelKeyOf(score),
    difficulty,
    rks: rks != null && rks > 0 ? rks : phiRks(acc, difficulty),
    score: scoreValue,
    acc,
    Rating: rating,
  };
  if (extra.num != null) mapped.num = extra.num;
  return mapped;
}

/**
 * 组装 b19.art 的完整模板数据。
 *
 * 注：`Date` 按要求使用渲染时刻，而不是 `input.computedAt`（上游数据时间）。
 */
export function buildPhiTemplateData(
  input: PhigrosRksRenderInput,
  assets: PhiAssets,
  options: BuildDataOptions = {},
): PhiTemplateData {
  const now = options.now ?? new Date();
  const lookup = buildLookup(assets);
  const theme = options.theme ?? 'star';

  const phiSource = (input.phi ?? []).filter(Boolean).slice(0, PHI_VISIBLE);
  const phi = phiSource.map((score) => mapSong(score, assets, lookup));

  // phi-plugin 按 rating 降序取 bestN；这里同样排序，避免上游顺序抖动导致编号错位。
  const best = [...(input.best ?? [])].filter(Boolean).sort((a, b) => {
    const ratingA = toFiniteNumber(a.rating) ?? 0;
    const ratingB = toFiniteNumber(b.rating) ?? 0;
    if (ratingB !== ratingA) return ratingB - ratingA;
    const scoreA = toFiniteNumber(a.score) ?? 0;
    const scoreB = toFiniteNumber(b.score) ?? 0;
    return scoreB - scoreA;
  });
  const b19List = best.slice(0, BEST_VISIBLE + 3).map((score, index) =>
    mapSong(score, assets, lookup, { num: index + 1 }),
  );

  const rksValue = toFiniteNumber(input.rks) ?? 0;
  const topSong = b19List[0] ?? phi[0];

  return {
    _res_path: assets.resUrlPrefix,
    defaultLayout: assets.defaultLayout,
    theme,
    // phi-plugin 用随机曲绘做模糊背景；这里固定用最高 rating 的曲绘，保证渲染可复现。
    ...(topSong ? { background: topSong.illustration } : {}),
    gameuser: {
      PlayerId: input.profileName?.trim() || 'Phigros Player',
      rks: rksValue,
      avatar: assets.avatar,
      ChallengeMode: '0',
      ChallengeModeRank: 0,
      data: '—',
    },
    Date: formatDate(now),
    // 即使为空数组也要传（模板用 `phi ? 27 : 30` 决定 OVER FLOW 分界）。
    phi,
    b19_list: b19List,
    // RankHub 输入没有逐难度通关统计，传空并隐藏 recordInfo。
    stats: [],
    spInfo: [],
    b30Analysis: null,
    Version: { ver: PHI_PLUGIN_VERSION, phigros: '4.0.1.1', phigrosVerNum: 159 },
    _plugin: PHI_PLUGIN_DISPLAY_NAME,
    sys: {
      scale: 'style="transform:scale(1)"',
      copyright: `Created By RankHub QQBot & ${PHI_PLUGIN_DISPLAY_NAME} ${PHI_PLUGIN_VERSION}`,
    },
    renderNoJs: false,
    quality: 90,
  };
}
