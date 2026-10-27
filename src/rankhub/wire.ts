import type {
  DeviceAuthorization,
  GameBestBucket,
  GameBests,
  GameCapability,
  GamePlayer,
  GameProfile,
  GameScore,
  RankHubIdentity,
  RankHubTokens,
  ScorePage,
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
