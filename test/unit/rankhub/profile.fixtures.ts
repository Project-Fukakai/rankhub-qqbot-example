/**
 * `describeProfile` 的单测夹具。
 *
 * 分两类，故意分开，避免把「推测的形状」当成「线上形状」：
 *
 * 1. **v1 真实形状**：键名逐字取自 backend 的 v1 adapter `buildPlayer(...)` 字面量
 *    （`rankhub_net/apps/backend/src/v1-games/adapters/{maimai,phigros,arcaea}.adapter.ts`）；
 * 2. **前向兼容形状**：`player.native` 里额外带 phigros `avatar_asset_key` / `background_song_id`、
 *    arcaea `avatar` / `nameplate`，或 v0 形状的顶层 `background_song_id`
 *    —— 用来锁定「后端一旦补上这些键，本模块立刻能用」，不代表线上今天真的下发。
 *
 * 所有值都是假数据，不含真实用户信息。
 */

import type { GameProfile } from '../../../src/contracts/index.js';
import type { GameFormatLike } from '../../../src/rankhub/profile.js';

/** 造一条档案，只覆盖测试关心的部分。 */
function profileOf(input: {
  profileId: string;
  game: string;
  name: string | null;
  rating: number | null;
  native: Record<string, unknown> | null;
  isPublic: boolean;
}): GameProfile {
  return {
    profileId: input.profileId,
    game: input.game,
    player: { name: input.name, rating: input.rating, native: input.native },
    isPublic: input.isPublic,
    origin: 'user',
    syncCapable: true,
    lastSyncedAt: '2026-10-20T01:02:03.000Z',
    updatedAt: '2026-10-20T01:02:03.000Z',
  };
}

// ────────────────────────────────────────────────────────── maimai

/** v1 真实形状：`maimai.adapter.ts:182-188`。 */
export const maimaiProfile = profileOf({
  profileId: 'profile-mai-1',
  game: 'maimai',
  name: 'だんご',
  rating: 15370,
  native: {
    userId: 12345678,
    friendCode: '123456789012345',
    courseRank: 12,
    classRank: 5,
    star: 3,
  },
  isPublic: true,
});

/** 只声明 `courseRank` 的窄 format：用来验证「format 声明即过滤」。 */
export const maimaiFormatNarrow: GameFormatLike = {
  game: 'maimai',
  rating: { name: 'DX Rating' },
  profile: {
    identityFields: [],
    nativeFields: [{ name: 'courseRank' }],
  },
};

/** 线上真实 format（`game-format.registry.ts:124-186` 的 maimai 段）。 */
export const maimaiFormat: GameFormatLike = {
  game: 'maimai',
  rating: { name: 'DX Rating' },
  profile: {
    identityFields: [{ name: 'friendCode' }, { name: 'userId' }],
    nativeFields: [{ name: 'courseRank' }, { name: 'classRank' }, { name: 'star' }],
  },
};

// ────────────────────────────────────────────────────────── phigros

/** v1 真实形状：`phigros.adapter.ts:163-177`（**不含**头像/背景）。 */
export const phigrosProfileV1 = profileOf({
  profileId: 'profile-phi-1',
  game: 'phigros',
  name: 'Fake Player',
  rating: 15.43,
  native: {
    objectId: 'a1b2c3d4-0000-4000-8000-000000000000',
    shortId: 'P123456',
    challengeModeRank: 316,
    gameVersion: 25,
  },
  isPublic: false,
});

/** 前向兼容形状：`player.native` 带 v0 的 `avatar_asset_key` / `background_song_id`。 */
export const phigrosProfileWithAssets = profileOf({
  profileId: 'profile-phi-2',
  game: 'phigros',
  name: 'Fake Player',
  rating: 14.88,
  native: {
    ...phigrosProfileV1.player.native,
    avatar_asset_key: 'avatar.Introduction',
    background_song_id: 'Glaciaxion.SunsetRay.0',
  },
  isPublic: true,
});

/**
 * v0 形状的顶层 `background_song_id`（App 的 `PhigrosNetProfile` 就长这样，
 * `RankHub/lib/modules/phigros/models/phigros_net_models.dart:12-39`）。
 *
 * 契约 `GameProfile` 没有这个顶层字段，所以此处显式转型 —— 这正是「前向兼容读取」要覆盖的场景。
 */
export const phigrosProfileV0Shape = {
  ...phigrosProfileV1,
  background_song_id: 'Glaciaxion.SunsetRay.0',
} as unknown as GameProfile;

/** `avatar` 是绝对 URL 时的档案（App 的 `publicAvatarUrl` 对该情况返回 null）。 */
export const phigrosProfileAbsoluteAvatar = profileOf({
  profileId: 'profile-phi-3',
  game: 'phigros',
  name: 'Fake Player',
  rating: 12.0,
  native: { ...phigrosProfileV1.player.native, avatar: 'https://example.com/avatar.png' },
  isPublic: true,
});

/** snake_case 兜底（v0/display 键，`native-input/index.ts:187-190`）。 */
export const phigrosProfileSnakeCase = profileOf({
  profileId: 'profile-phi-4',
  game: 'phigros',
  name: 'Fake Player',
  rating: 11.11,
  native: { object_id: 'a1b2c3d4-0000-4000-8000-000000000000', challenge_mode_rank: 102, game_version: 24 },
  isPublic: true,
});

/** 线上真实 format（`game-format.registry.ts:259-315` 的 phigros 段）。 */
export const phigrosFormat: GameFormatLike = {
  game: 'phigros',
  rating: { name: 'rks' },
  profile: {
    identityFields: [{ name: 'objectId' }, { name: 'shortId' }],
    nativeFields: [{ name: 'challengeModeRank' }, { name: 'gameVersion' }],
  },
};

// ────────────────────────────────────────────────────────── arcaea

/** v1 真实形状：`arcaea.adapter.ts:153-167`（**不含** avatar / nameplate）。 */
export const arcaeaProfileV1 = profileOf({
  profileId: 'profile-arc-1',
  game: 'arcaea',
  name: 'Hikari',
  rating: 12.34,
  native: {
    arcaeaId: 123456789,
    course: 6,
    character: '0',
    friendCode: '123456789',
    b30Avg: 12.5,
    b50Avg: 12.11,
  },
  isPublic: true,
});

/** 前向兼容形状：`player.native` 带 `avatar` / `nameplate`（v0 `ArcaeaPlayer` 形状）。 */
export const arcaeaProfileWithAssets = profileOf({
  profileId: 'profile-arc-2',
  game: 'arcaea',
  name: 'Hikari',
  rating: 12.34,
  native: {
    ...arcaeaProfileV1.player.native,
    avatar: 'assets/char/0_icon.png',
    nameplate: 'assets/img/nameplate/sample.png',
  },
  isPublic: false,
});

/** 头像/搭档都缺失：不应崩，头像为 null。 */
export const arcaeaProfileEmptyAssets = profileOf({
  profileId: 'profile-arc-3',
  game: 'arcaea',
  name: 'Hikari',
  rating: null,
  native: { arcaeaId: 1, course: 0, character: '', friendCode: null, b30Avg: null, b50Avg: null },
  isPublic: true,
});

/** 线上真实 format（`game-format.registry.ts:189-256` 的 arcaea 段）。 */
export const arcaeaFormat: GameFormatLike = {
  game: 'arcaea',
  rating: { name: 'Potential' },
  profile: {
    identityFields: [{ name: 'arcaeaId' }, { name: 'character' }, { name: 'friendCode' }],
    nativeFields: [
      { name: 'course' },
      { name: 'avatar' },
      { name: 'nameplate' },
      { name: 'b30Avg' },
      { name: 'b50Avg' },
    ],
  },
};

// ────────────────────────────────────────────────────────── 边界夹具

/** 字段全缺：`native: null`、`rating: null`。 */
export const bareProfile = profileOf({
  profileId: 'profile-bare-1',
  game: 'phigros',
  name: null,
  rating: null,
  native: null,
  isPublic: false,
});

/** 未知游戏（backend 支持的 10 个之外的键）：不该崩，也不该猜字段。 */
export const unknownGameProfile = profileOf({
  profileId: 'profile-unknown-1',
  game: 'chunithm',
  name: 'Unknown Player',
  rating: 16.5,
  native: { courseRank: 1, avatar_asset_key: 'whatever', background_song_id: 'x' },
  isPublic: true,
});
