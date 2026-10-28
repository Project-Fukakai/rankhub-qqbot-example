import {
  DEFAULT_DISPLAY_PREFERENCES,
  type DeviceAuthorization,
  type DisplayPreferences,
  type GameBestBucket,
  type GameBests,
  type GameCapability,
  type GamePlayer,
  type GameProfile,
  type GameProfileAssets,
  type GameScore,
  type PhigrosDifficulty,
  type RankHubIdentity,
  type RankHubTokens,
  type ScorePage,
} from '../contracts/index.js';

import { invalidResponse } from './errors.js';

/**
 * RankHub v1 的 wire 形状与「wire → 契约类型」映射。
 *
 * 原则：
 * - wire 字段一律当 `unknown` 读（服务端加字段不该让客户端崩）；
 * - 契约要求非空的字段缺失时，跳过该条目（列表）或抛 `server_error`（单对象），
 *   不编造默认值；
 * - `null` 表示「该游戏没有这个概念」，保持 `null`，不要变 0 / 空串。
 */

export interface RawEnvelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
  requestId?: unknown;
}

export interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  token_type?: unknown;
}

export interface RawDeviceAuthorization {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

export function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readBoolean(source: Record<string, unknown> | null, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : null;
}

export function readArray(source: Record<string, unknown> | null, key: string): unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}

/** 设备授权响应（六键）。`interval` / `expires_in` 缺失时用调用方给的默认值。 */
export function toDeviceAuthorization(
  body: RawDeviceAuthorization | Record<string, unknown>,
  defaults: { interval: number; expiresIn: number },
): DeviceAuthorization {
  const record = body as Record<string, unknown>;
  const deviceCode = readString(record, 'device_code');
  const userCode = readString(record, 'user_code');
  const verificationUri = readString(record, 'verification_uri');
  if (deviceCode === null || userCode === null || verificationUri === null) {
    throw invalidResponse('device_authorization 响应缺少 device_code / user_code / verification_uri');
  }
  const expiresIn = readNumber(record, 'expires_in') ?? defaults.expiresIn;
  const interval = readNumber(record, 'interval') ?? defaults.interval;
  const complete =
    readString(record, 'verification_uri_complete') ??
    `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: complete,
    expiresIn,
    interval,
  };
}

/** token 响应 → 契约 tokens。refresh token 缺失时用调用方给的兜底（刷新流程会保留旧 rt）。 */
export function toRankHubTokens(
  body: RawTokenResponse | Record<string, unknown>,
  fallback: { refreshToken?: string; scope?: string } = {},
): RankHubTokens {
  const record = body as Record<string, unknown>;
  const accessToken = readString(record, 'access_token');
  if (accessToken === null) {
    throw invalidResponse('token 响应缺少 access_token');
  }
  const refreshToken = readString(record, 'refresh_token') ?? fallback.refreshToken ?? '';
  const expiresIn = readNumber(record, 'expires_in') ?? 0;
  const scope = readString(record, 'scope') ?? fallback.scope ?? '';
  return {
    accessToken,
    refreshToken,
    expiresIn,
    scope,
    idToken: readString(record, 'id_token'),
  };
}

/** OIDC userinfo → 契约 identity；`sub` 缺失视为坏响应（由 client 决定是否吞错）。 */
export function toRankHubIdentity(body: Record<string, unknown>): RankHubIdentity {
  const preferred = readString(body, 'preferred_username');
  const subject = readString(body, 'sub') ?? preferred;
  if (subject === null) {
    throw invalidResponse('userinfo 响应缺少 sub');
  }
  return {
    subject,
    name: readString(body, 'name') ?? preferred ?? null,
    picture: readString(body, 'picture') ?? null,
  };
}

function toGameCapability(entry: unknown): GameCapability | null {
  const record = asRecord(entry);
  const game = readString(record, 'game');
  if (record === null || game === null) return null;
  return {
    game,
    read: readBoolean(record, 'read') ?? false,
    pushProfile: readBoolean(record, 'pushProfile') ?? false,
    pushScores: readBoolean(record, 'pushScores') ?? false,
    deletionRequest: readBoolean(record, 'deletionRequest') ?? false,
  };
}

export function toGameCapabilities(entries: unknown[]): GameCapability[] {
  const result: GameCapability[] = [];
  for (const entry of entries) {
    const mapped = toGameCapability(entry);
    if (mapped !== null) result.push(mapped);
  }
  return result;
}

function toGamePlayer(entry: unknown): GamePlayer {
  const record = asRecord(entry);
  if (record === null) return { name: null, rating: null, native: null };
  return {
    name: readString(record, 'name'),
    rating: readNumber(record, 'rating'),
    native: asRecord(record['native']),
  };
}

/**
 * v1 profile 的 `assets` → 契约 `GameProfileAssets`。
 *
 * 老实例没有 `assets`（或字段缺失 / 类型不对）⇒ 三字段全 `null`，**不抛错**：
 * 调用方（`describeProfile`）据此回退本地 URL 规则，机器人行为不回归。
 */
/** 读一个资产 URL：空串 / 纯空白按缺失处理（`null`），其余原样。 */
function readAssetUrl(record: Record<string, unknown> | null, key: string): string | null {
  const value = readString(record, key);
  return value !== null && value.trim() !== '' ? value : null;
}

export function toProfileAssets(entry: unknown): GameProfileAssets {
  const record = asRecord(entry);
  return {
    avatarUrl: readAssetUrl(record, 'avatarUrl'),
    backgroundUrl: readAssetUrl(record, 'backgroundUrl'),
    characterArtworkUrl: readAssetUrl(record, 'characterArtworkUrl'),
  };
}

function toGameProfile(entry: unknown): GameProfile | null {
  const record = asRecord(entry);
  if (record === null) return null;
  const profileId = readString(record, 'profileId');
  const game = readString(record, 'game');
  if (profileId === null || game === null) return null;
  const origin = readString(record, 'origin');
  return {
    profileId,
    game,
    player: toGamePlayer(record['player']),
    isPublic: readBoolean(record, 'isPublic') ?? false,
    origin: origin === 'app' ? 'app' : 'user',
    syncCapable: readBoolean(record, 'syncCapable') ?? false,
    lastSyncedAt: readString(record, 'lastSyncedAt'),
    updatedAt: readString(record, 'updatedAt') ?? '',
    assets: toProfileAssets(record['assets']),
  };
}

export function toGameProfiles(entries: unknown[]): GameProfile[] {
  const result: GameProfile[] = [];
  for (const entry of entries) {
    const mapped = toGameProfile(entry);
    if (mapped !== null) result.push(mapped);
  }
  return result;
}

export function toGameScore(entry: unknown): GameScore | null {
  const record = asRecord(entry);
  if (record === null) return null;
  const scoreId = readString(record, 'scoreId');
  if (scoreId === null) return null;
  return {
    scoreId,
    songId: readString(record, 'songId') ?? '',
    songName: readString(record, 'songName'),
    type: readString(record, 'type'),
    difficulty: readString(record, 'difficulty'),
    levelIndex: readNumber(record, 'levelIndex'),
    level: readString(record, 'level'),
    achievements: readNumber(record, 'achievements'),
    score: readNumber(record, 'score'),
    rating: readNumber(record, 'rating'),
    rank: readString(record, 'rank'),
    dxScore: readNumber(record, 'dxScore'),
    dxStar: readNumber(record, 'dxStar'),
    fc: readString(record, 'fc'),
    fs: readString(record, 'fs'),
    playTime: readString(record, 'playTime'),
    native: asRecord(record['native']),
  };
}

function toGameScores(entries: unknown[]): GameScore[] {
  const result: GameScore[] = [];
  for (const entry of entries) {
    const mapped = toGameScore(entry);
    if (mapped !== null) result.push(mapped);
  }
  return result;
}

function toTotals(entry: unknown): Record<string, number | null> {
  const record = asRecord(entry);
  const totals: Record<string, number | null> = {};
  if (record === null) return totals;
  for (const [key, value] of Object.entries(record)) {
    totals[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return totals;
}

function toBestBucket(entry: unknown): GameBestBucket | null {
  const record = asRecord(entry);
  if (record === null) return null;
  const key = readString(record, 'key');
  if (key === null) return null;
  return {
    key,
    label: readString(record, 'label') ?? key,
    total: readNumber(record, 'total'),
    items: toGameScores(readArray(record, 'items')),
  };
}

export function toGameBests(data: unknown): GameBests {
  const record = asRecord(data);
  if (record === null) throw invalidResponse('bests 响应的 data 不是对象');
  const buckets: GameBestBucket[] = [];
  for (const entry of readArray(record, 'buckets')) {
    const mapped = toBestBucket(entry);
    if (mapped !== null) buckets.push(mapped);
  }
  return {
    game: readString(record, 'game') ?? '',
    computedAt: readString(record, 'computedAt') ?? '',
    totals: toTotals(record['totals']),
    buckets,
  };
}

export function toScorePage(data: unknown): ScorePage {
  const record = asRecord(data);
  if (record === null) throw invalidResponse('scores 响应的 data 不是对象');
  const items = toGameScores(readArray(record, 'items'));
  const nextCursor = readString(record, 'nextCursor');
  return {
    items,
    nextCursor,
    hasMore: readBoolean(record, 'hasMore') ?? nextCursor !== null,
  };
}

export function toProfilePage(data: unknown): { items: GameProfile[]; nextCursor: string | null } {
  const record = asRecord(data);
  if (record === null) throw invalidResponse('profiles 响应的 data 不是对象');
  return {
    items: toGameProfiles(readArray(record, 'items')),
    nextCursor: readString(record, 'nextCursor'),
  };
}

// ──────────────────────────── /v1/me/display-preferences ────────────────────────────

/** Phigros 难度全量（与 App `PhigrosDifficulty` / 后端偏好枚举逐字一致）。 */
export const PHIGROS_DIFFICULTIES: readonly PhigrosDifficulty[] = ['EZ', 'HD', 'IN', 'AT'];

const PHIGROS_DIFFICULTY_SET: ReadonlySet<string> = new Set<string>(PHIGROS_DIFFICULTIES);

/**
 * 归一 Phigros 难度（大小写 / 前后空格不敏感）；非法或缺失返回 `null`。
 *
 * 指令层（`/me diff`）与 wire 层共用这一条判据，避免两处枚举漂移。
 */
export function normalizePhigrosDifficulty(value: unknown): PhigrosDifficulty | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return PHIGROS_DIFFICULTY_SET.has(upper) ? (upper as PhigrosDifficulty) : null;
}

export function isPhigrosDifficulty(value: unknown): value is PhigrosDifficulty {
  return normalizePhigrosDifficulty(value) !== null;
}

/**
 * `GET/PATCH /v1/me/display-preferences` 的 `data` → `DisplayPreferences`。
 *
 * 契约（`docs/QQBOT-CARD-V2.md` §2.1）声明 `data` 为 `{phigrosDifficulty}`，未设置返回 `IN`。
 * 这里对**字段级**缺失/非法一律回退默认值（机器人展示不该因一个可选偏好崩掉）；
 * HTTP / envelope 级失败仍由 client 抛 `RankHubError`，由调用方决定降级口径。
 */
export function toDisplayPreferences(data: unknown): DisplayPreferences {
  const record = asRecord(data);
  return {
    phigrosDifficulty:
      normalizePhigrosDifficulty(record?.['phigrosDifficulty']) ??
      DEFAULT_DISPLAY_PREFERENCES.phigrosDifficulty,
  };
}

// ─────────────────── /v1/games/phigros/profiles/{id}/statistics ───────────────────

/** 单难度下的全谱面达成统计（App `statistics.levels[difficulty]`）。 */
export interface PhigrosLevelStatistics {
  played: number;
  clear: number;
  fc: number;
  phi: number;
}

/**
 * Phigros 逐难度统计（`GET /v1/games/phigros/profiles/{id}/statistics` 的 `data.statistics`）。
 *
 * 类型放在 `wire.ts` 而不是冻结契约 `src/contracts/index.ts`：它是本任务新增的后端能力，
 * 渲染契约（PlayerCard 判别联合）不受影响。
 */
export interface PhigrosStatistics {
  officialRks: number | null;
  calculatedRks: number | null;
  b19AverageRks: number | null;
  /** 课题模式三位数（百位段位 + 后两位难度）；0 = 未参与。 */
  challengeModeRank: number | null;
  challengeRankLevel: number | null;
  challengeDifficulty: number | null;
  totalScores: number | null;
  fcCount: number | null;
  phiCount: number | null;
  /** 各评级曲目数（键是 `ϕ` / `S` 等，值一律数字）。 */
  ratings: Record<string, number>;
  /** 四个难度都有键（缺失的块按 0 归一），调用方无需再判空。 */
  levels: Record<PhigrosDifficulty, PhigrosLevelStatistics>;
  lastSyncedAt: string | null;
}

/** 按候选键顺序读第一个有限数字（camelCase 在前、snake_case 兜底）。 */
function readFirstNumber(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  if (source === null) return null;
  for (const key of keys) {
    const value = readNumber(source, key);
    if (value !== null) return value;
  }
  return null;
}

function toNumberRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  if (record === null) return out;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
  }
  return out;
}

/** 单难度统计块：非数字 / 缺失一律 0（卡片画 0/0 而不是崩）。 */
function toLevelStatistics(value: unknown): PhigrosLevelStatistics {
  const record = asRecord(value);
  return {
    played: readNumber(record, 'played') ?? 0,
    clear: readNumber(record, 'clear') ?? 0,
    fc: readNumber(record, 'fc') ?? 0,
    phi: readNumber(record, 'phi') ?? 0,
  };
}

function toPhigrosLevels(value: unknown): Record<PhigrosDifficulty, PhigrosLevelStatistics> {
  const record = asRecord(value);
  const levels = {} as Record<PhigrosDifficulty, PhigrosLevelStatistics>;
  for (const difficulty of PHIGROS_DIFFICULTIES) {
    levels[difficulty] = toLevelStatistics(record?.[difficulty]);
  }
  return levels;
}

/**
 * `statistics` 端点的 `data`（`{game, statistics}`）→ 归一后的 `PhigrosStatistics`。
 *
 * 缺失 `data.statistics` / 非对象 ⇒ `server_error`（服务端不守契约，不能编造统计）。
 */
export function toPhigrosStatistics(data: unknown): PhigrosStatistics {
  const record = asRecord(data);
  const statistics = asRecord(record?.['statistics']);
  if (record === null || statistics === null) {
    throw invalidResponse('phigros statistics 响应缺少 data.statistics 对象');
  }
  return {
    officialRks: readFirstNumber(statistics, ['officialRks', 'official_rks']),
    calculatedRks: readFirstNumber(statistics, ['calculatedRks', 'calculated_rks']),
    b19AverageRks: readFirstNumber(statistics, ['b19AverageRks', 'b19_average_rks']),
    challengeModeRank: readFirstNumber(statistics, [
      'challengeModeRank',
      'challenge_mode_rank',
    ]),
    challengeRankLevel: readFirstNumber(statistics, [
      'challengeRankLevel',
      'challenge_rank_level',
    ]),
    challengeDifficulty: readFirstNumber(statistics, [
      'challengeDifficulty',
      'challenge_difficulty',
    ]),
    totalScores: readFirstNumber(statistics, ['totalScores', 'total_scores']),
    fcCount: readFirstNumber(statistics, ['fcCount', 'fc_count']),
    phiCount: readFirstNumber(statistics, ['phiCount', 'phi_count']),
    ratings: toNumberRecord(statistics['ratings']),
    levels: toPhigrosLevels(statistics['levels']),
    lastSyncedAt: readString(statistics, 'lastSyncedAt'),
  };
}
