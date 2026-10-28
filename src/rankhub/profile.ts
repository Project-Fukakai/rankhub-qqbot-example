/**
 * RankHub 档案 → 「/me 玩家名片」展示模型（maimai / phigros / arcaea）。
 *
 * ## 输入从哪来（全部有据可查，逐条证据见 `docs/research/profile-model.md`）
 *
 * 1. `GET /v1/games/{game}/profiles` 的 `profile`（本模块参数 `profile`）：
 *    - `profile.player.rating` → 名片上的总分（maimai DX Rating / arcaea Potential / phigros rks）；
 *    - `profile.player.native` → 游戏原生字段，**键名是后端 adapter 实际输出的键名**；
 *    - `profile.isPublic` → 原样透传（是否公开展示由调用方决定怎么用）。
 * 2. `GET /v1/games/{game}/format` 的 `data`（本模块参数 `format`，可缺省）：
 *    - `profile.identityFields` / `profile.nativeFields` 声明「这个游戏有哪些字段」，
 *      给了就只展示被声明过的键（防止把后端内部键当名片字段画出去）；
 *    - `rating.name` 是评分体系名（`DX Rating` / `Potential` / `rks`），供调用方拼文案。
 *
 * ## 资产 URL 规则（以 App 为准，不猜）
 *
 * **优先级 0：v1 `profile.assets`（服务端权威的绝对 URL）**——冻结契约见
 * `RankHubWorkspace/docs/V1-PROFILE-ASSETS.md`：`avatarUrl` / `backgroundUrl` /
 * `characterArtworkUrl`，`null` 表示「没有这个概念」。有值时直接用，**不再本地拼**；
 * 老实例没有 `assets` 时按下面 1/2/3 的本地规则回退（行为与历史版本逐字一致）。
 *
 * 分三类，优先级从高到低：
 *
 * 1. **RankHub 相对资产路径**（形如 `/v0/assets/{id}/content`）→ `normalizeAssetUrl()`：
 *    镜像 App `RankHubApiService._normalizeAssetUrl`
 *    （`RankHub/lib/services/api/rankhub_api_service.dart:1437-1452`）：
 *    绝对 `http(s)` 直通；`/v\d+/...` 拼 API 网关前缀；其余相对路径拼主机根。
 *    基址默认取 App 的 v0 基址 `https://net.rankhub.cc/api/v0`
 *    （`RankHub/packages/rankhub_net_api_client/lib/src/net/net_defaults.dart:26-29`）。
 *    后端配置 `ASSETS_S3_PUBLIC_BASE_URL` 时会把资产直连成绝对 URL
 *    （`rankhub_net/apps/backend/src/assets/storage/s3-asset-storage.service.ts:132-145`），
 *    走「绝对直通」这支。
 * 2. **phigros 资源键**（`avatar_asset_key` / `background_song_id`）→ 镜像
 *    `PhigrosAssetUrl.avatar` / `.songImage`（`RankHub/lib/models/phigros/asset_url.dart:28-69`）：
 *    `https://static.rankhub.cc/phigros/asset/<键路径>.<后缀>`，后缀默认 `jpg`；
 *    **最后一段无条件追加后缀**（曲绘因此是 `Illustration.jpg.jpg`，App 单测与 CDN 实测一致）。
 * 3. **arcaea 资源路径**（`avatar` / `nameplate` / `character`）→ 镜像
 *    `ArcaeaPlayer.avatarUrl` / `nameplateUrl` / `partnerIconUrl`
 *    （`RankHub/lib/modules/arcaea/models/arcaea_models.dart:51-77`）：
 *    `https://static.rankhub.cc/arcaea/asset/<去掉 assets/ 前缀的路径>`；
 *    `avatar` 为空时回落到搭档图标 `…/asset/char/<character>_icon.png`。
 *
 * ❗ **v1 现实的缺口与补齐**：v1 的三个 adapter 只把 `name` / `rating` 与少量原生键放进
 * `player.native`，过去**没有** phigros 的 `avatar_asset_key` / `background_song_id`、arcaea 的
 * `avatar` / `nameplate`，`/me` 因此拿不到图。现在由 v1 `profile.assets`（绝对 URL）统一提供，
 * 本模块优先消费；老实例仍按 v0/App 的键名做**前向兼容读取**，后端没部署 assets 时行为不变。
 */

import { asRecord } from './wire.js';

import type { GameProfile } from '../contracts/index.js';

/** 一张名片字段（`value` 一律是可直接展示的字符串）。 */
export interface ProfileField {
  label: string;
  value: string;
}

/** `describeProfile()` 的返回值（「/me 玩家名片」每游戏一节）。 */
export interface ProfileView {
  /** 游戏键（`maimai` / `phigros` / `arcaea`；未知游戏原样回填）。 */
  game: string;
  /** 头像绝对 URL；没有这个概念或服务端不下发时为 `null`。 */
  avatarUrl: string | null;
  /** 背景/名片板/曲绘/背景板绝对 URL；没有这个概念或服务端不下发时为 `null`。 */
  backgroundUrl: string | null;
  /** 立绘绝对 URL（目前只有 arcaea 搭档立绘）；没有这个概念时为 `null`。 */
  characterArtworkUrl: string | null;
  /** 总分（量纲随游戏，渲染层自己格式化）；缺失为 `null`。 */
  rating: number | null;
  /** 游戏特定展示字段（已按贵贱排序，调用方可自行截断）。 */
  fields: ProfileField[];
  /** 档案是否公开（v1 `profile.isPublic` 透传）。 */
  isPublic: boolean;
}

/** 资产 URL 拼接的可选覆盖（默认值全部来自 App 代码，见文件头）。 */
export interface ProfileOptions {
  /** RankHub v0 基址（含版本段），默认 `DEFAULT_ASSET_BASE_URL`。 */
  assetBaseUrl?: string;
  /** 游戏静态资源 origin（不含游戏段），默认 `DEFAULT_GAME_ASSET_ORIGIN`。 */
  gameAssetOrigin?: string;
}

/**
 * `GET /v1/games/{game}/format` 里本模块用到的最小结构。
 *
 * 服务端权威类型：`rankhub_net/apps/backend/src/v1-games/formats/game-format.types.ts:99-106`
 * （`GameFormatProfileDto`）与 `:157-172`（`GameFormatDto`）。这里只声明本模块读取的字段，
 * 其余字段（`score` / `buckets` / `notes`…）与本模块无关，避免契约耦合。
 */
export interface GameFormatLike {
  game?: string;
  rating?: { name?: string } | null;
  profile?: {
    identityFields?: ReadonlyArray<{ name?: string; description?: string }> | null;
    nativeFields?: ReadonlyArray<{ name?: string; description?: string }> | null;
  } | null;
}

/** App 的 v0 基址默认值（`net_defaults.dart:26-29`）：相对资产路径按它拼绝对 URL。 */
export const DEFAULT_ASSET_BASE_URL = 'https://net.rankhub.cc/api/v0';

/** App 的游戏静态资源 origin（`RankHub/lib/config/game_assets_config.dart:5`）。 */
export const DEFAULT_GAME_ASSET_ORIGIN = 'https://static.rankhub.cc';

/** phigros 资源默认图片后缀（`RankHub/lib/models/phigros/asset_url.dart:8`）。 */
const PHIGROS_IMAGE_SUFFIX = 'jpg';
/** phigros 文本资源后缀（`asset_url.dart:9`）。 */
const PHIGROS_TEXT_SUFFIX = 'txt';
/** phigros 音频资源后缀（`asset_url.dart:10`）。 */
const PHIGROS_MUSIC_SUFFIX = 'ogg';

/** phigros 课题模式段位名称：段位等级 1~5（`RankHub/lib/models/phigros/player_summary.dart:46-63`）。 */
const PHIGROS_CHALLENGE_LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: '绿',
  2: '蓝',
  3: '红',
  4: '金',
  5: '彩',
};

// ────────────────────────────────────────────────────────── 文本读取

/**
 * 读一个「可展示字符串」。
 *
 * 与 App `_readNullableString`（`rankhub_api_service.dart:1614-1620`）同口径：
 * 数字转字符串、`trim()`、空串与字面量 `'null'` 视为缺失。对象/数组返回 `null`
 * （名片画不了嵌套结构，宁可不显示也不猜）。
 */
function readText(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === 'null') return null;
  return text;
}

/** 按候选键顺序读第一个非空字符串（camelCase 在前、snake_case 兜底）。 */
function readFirstText(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (source === null) return null;
  for (const key of keys) {
    const text = readText(source[key]);
    if (text !== null) return text;
  }
  return null;
}

// ────────────────────────────────────────────────────────── URL 归一

/**
 * 从基址推导 `scheme://host[:port]`。
 *
 * 镜像 App `RankHubNetBaseUrl.originOf`（`net_defaults.dart:66-70`）：端口只在显式声明时保留。
 */
export function originOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/**
 * 从基址推导 API 网关前缀（版本段之前的部分，不含结尾 `/`）。
 *
 * 镜像 App `RankHubNetBaseUrl.gatewayPathOf`（`net_defaults.dart:80-92`）：
 * - `https://net.rankhub.cc/api/v0` → `/api`
 * - `http://127.0.0.1:9528/v0` → `''`
 * - 无版本段 → 整条 path（这里去掉结尾 `/`，避免拼出 `//`）
 */
export function gatewayPathOf(baseUrl: string): string {
  let path: string;
  try {
    path = new URL(baseUrl).pathname;
  } catch {
    return '';
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1] ?? '';
  if (/^v\d+$/.test(last)) {
    const prefix = segments.slice(0, -1).join('/');
    return prefix === '' ? '' : `/${prefix}`;
  }
  return path.replace(/\/+$/, '');
}

/**
 * 把服务端返回的相对/绝对资产地址解析成可访问的绝对 URL。
 *
 * 逐行镜像 App `RankHubApiService._normalizeAssetUrl`
 * （`RankHub/lib/services/api/rankhub_api_service.dart:1437-1452`）：
 *
 * 1. `http(s)://…` → 原样返回（`ASSETS_S3_PUBLIC_BASE_URL` 生效时后端就下发这种）；
 * 2. 形如 `/v0/…`（正则 `^/v\d+(?:/|$)`，`:1476-1478`）→ `hostOrigin + 网关前缀 + 原路径`，
 *    例：`/v0/assets/x` → `https://net.rankhub.cc/api/v0/assets/x`；
 * 3. 其余以 `/` 开头 → `hostOrigin + 原路径`；
 * 4. 其余相对路径 → `hostOrigin + '/' + 原路径`。
 */
export function normalizeAssetUrl(value: unknown, options: ProfileOptions = {}): string | null {
  const raw = readText(value);
  if (raw === null) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const baseUrl = options.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL;
  const hostOrigin = originOf(baseUrl);
  if (hostOrigin === '') return raw; // 基址不可解析：原样返回，至少不制造脏 URL

  if (/^\/v\d+(?:\/|$)/.test(raw)) return `${hostOrigin}${gatewayPathOf(baseUrl)}${raw}`;
  if (raw.startsWith('/')) return `${hostOrigin}${raw}`;
  return `${hostOrigin}/${raw}`;
}

/**
 * phigros 资源键 → 绝对 URL。
 *
 * 镜像 `PhigrosAssetUrl.asset`（`RankHub/lib/models/phigros/asset_url.dart:28-38`）：
 * 逐段做百分号编码（App 单测断言 `#` → `%23`，见
 * `RankHub/test/modules/phigros/phigros_asset_models_test.dart:25-28`），
 * 最后一段**无条件**追加后缀（`:36`）。
 */
function phigrosAssetKeyUrl(key: string, origin: string): string | null {
  const text = key.trim();
  if (text === '' || text === 'null') return null;
  const segments = ['asset', ...text.split('/').filter((segment) => segment !== '')];
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  segments[segments.length - 1] = `${last}.${phigrosSuffixFor(text)}`;
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `${origin}/phigros/${encoded}`;
}

/** 后缀选择（`asset_url.dart:73-78`）：图表/文本 → txt，音频 → ogg，其余 → jpg。 */
function phigrosSuffixFor(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.txt')) return PHIGROS_TEXT_SUFFIX;
  if (lower.endsWith('.wav') || lower.endsWith('.ogg')) return PHIGROS_MUSIC_SUFFIX;
  return PHIGROS_IMAGE_SUFFIX;
}

/**
 * arcaea 资源路径 → 绝对 URL。
 *
 * 镜像 `ArcaeaPlayer.avatarUrl` / `nameplateUrl`
 * （`RankHub/lib/modules/arcaea/models/arcaea_models.dart:61-77`）：
 * 去掉开头的 `assets/` 前缀，再交给 `GameAssetsConfig.resolve('arcaea', '/asset/…')`
 * （`RankHub/lib/config/game_assets_config.dart:9-17`，绝对地址直通、相对路径拼 `{origin}/{game}`）。
 */
function arcaeaAssetUrl(value: string | null, origin: string): string | null {
  if (value === null) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const normalized = value.startsWith('assets/') ? value.slice('assets/'.length) : value;
  const trimmed = normalized.replace(/^\/+/, '');
  if (trimmed === '') return null;
  return `${origin}/arcaea/asset/${trimmed}`;
}

// ────────────────────────────────────────────────────────── 字段规格

/**
 * 一个展示字段的规格。
 *
 * `canonical` 是 `/format` 声明的统一字段名（`identityFields` / `nativeFields` 的 `name`）；
 * `nativeKeys` 是 `player.native` 里可能出现的键名，**v1 adapter 输出的 camelCase 在前**
 * （证据：三个 adapter 的 `buildPlayer` 字面量），v0/display 的 snake_case 兜底
 * （证据：`native-input/index.ts:176-190` 的可写键表）。
 */
interface FieldSpec {
  canonical: string;
  nativeKeys: readonly string[];
  label: string;
  /** 数字值的展示转换；缺省 `String(n)`。 */
  decode?: (value: number) => string;
}

/** phigros 课题模式段位文本（App：`player_summary.dart:35-70`）。 */
function decodePhigrosChallengeRank(rank: number): string {
  if (rank === 0) return '未参与';
  const level = Math.trunc(rank / 100);
  const difficulty = rank % 100;
  const name = PHIGROS_CHALLENGE_LEVEL_NAMES[level] ?? '未知';
  return `${name} ${difficulty}`;
}

/** maimai DX：原生键见 `maimai.adapter.ts:182-188`。 */
const MAIMAI_FIELDS: readonly FieldSpec[] = [
  { canonical: 'courseRank', nativeKeys: ['courseRank', 'course_rank'], label: '段位' },
  { canonical: 'classRank', nativeKeys: ['classRank', 'class_rank'], label: 'CLASS' },
  { canonical: 'star', nativeKeys: ['star'], label: '星级' },
  { canonical: 'userId', nativeKeys: ['userId', 'user_id'], label: '机台 userId' },
  { canonical: 'friendCode', nativeKeys: ['friendCode', 'friend_code'], label: '好友码' },
];

/** phigros：原生键见 `phigros.adapter.ts:163-177`。 */
const PHIGROS_FIELDS: readonly FieldSpec[] = [
  {
    canonical: 'challengeModeRank',
    nativeKeys: ['challengeModeRank', 'challenge_mode_rank'],
    label: '课题模式',
    decode: decodePhigrosChallengeRank,
  },
  { canonical: 'gameVersion', nativeKeys: ['gameVersion', 'game_version'], label: '游戏版本' },
  { canonical: 'objectId', nativeKeys: ['objectId', 'object_id'], label: 'Object ID' },
  { canonical: 'shortId', nativeKeys: ['shortId', 'short_id'], label: 'Short ID' },
];

/** arcaea：原生键见 `arcaea.adapter.ts:153-167`。 */
const ARCAEA_FIELDS: readonly FieldSpec[] = [
  { canonical: 'character', nativeKeys: ['character'], label: '搭档' },
  { canonical: 'course', nativeKeys: ['course'], label: 'Course' },
  { canonical: 'b30Avg', nativeKeys: ['b30Avg', 'b30_avg'], label: 'Best 30 均值' },
  { canonical: 'b50Avg', nativeKeys: ['b50Avg', 'b50_avg'], label: 'Best 50 均值' },
  { canonical: 'arcaeaId', nativeKeys: ['arcaeaId', 'arcaea_id'], label: 'Arcaea ID' },
  { canonical: 'friendCode', nativeKeys: ['friendCode', 'friend_code'], label: '好友码' },
];

/** 按游戏取字段规格；未知游戏返回空数组（不崩、不猜）。 */
function fieldSpecsOf(game: string): readonly FieldSpec[] {
  switch (game) {
    case 'maimai':
      return MAIMAI_FIELDS;
    case 'phigros':
      return PHIGROS_FIELDS;
    case 'arcaea':
      return ARCAEA_FIELDS;
    default:
      return [];
  }
}

/**
 * 从 `/format` 收集「被声明过的字段名」。
 *
 * 返回 `null` 表示「没有 format 或它没声明任何 profile 字段」⇒ 不做过滤，
 * 用本模块内置规格（等于信任 adapter 输出的键名）。
 */
function declaredNamesOf(format: GameFormatLike | null | undefined): Set<string> | null {
  const profile = format?.profile;
  const names = new Set<string>();
  for (const list of [profile?.nativeFields, profile?.identityFields]) {
    for (const field of list ?? []) {
      const name = field?.name;
      if (typeof name === 'string' && name !== '') names.add(name);
    }
  }
  return names.size > 0 ? names : null;
}

/** 把一个原生值格式化成展示字符串；无法展示时返回 `null`。 */
function formatFieldValue(value: unknown, spec: FieldSpec): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return spec.decode ? spec.decode(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return readText(value);
}

/** 按内置规格 + format 声明构造字段列表（保持规格顺序，跳过缺失值）。 */
function buildFields(
  specs: readonly FieldSpec[],
  native: Record<string, unknown> | null,
  declared: Set<string> | null,
): ProfileField[] {
  const fields: ProfileField[] = [];
  for (const spec of specs) {
    if (declared !== null) {
      const isDeclared =
        declared.has(spec.canonical) || spec.nativeKeys.some((key) => declared.has(key));
      if (!isDeclared) continue;
    }
    let value: unknown;
    for (const key of spec.nativeKeys) {
      const candidate = native?.[key];
      if (candidate !== undefined && candidate !== null) {
        value = candidate;
        break;
      }
    }
    const text = formatFieldValue(value, spec);
    if (text !== null) fields.push({ label: spec.label, value: text });
  }
  return fields;
}

// ────────────────────────────────────────────────────────── 资产解析

/**
 * v1 `profile.assets`（冻结契约 `RankHubWorkspace/docs/V1-PROFILE-ASSETS.md` §2）。
 *
 * 老实例没有该字段 / 字段缺失 / 类型不对 ⇒ 对应字段 `null`（不抛错）；不做 URL 归一，
 * 契约保证是绝对 URL，空串与字面量 `'null'` 按缺失处理（与本模块其它字段同口径）。
 */
function readProfileAssets(profile: Record<string, unknown> | null): {
  avatarUrl: string | null;
  backgroundUrl: string | null;
  characterArtworkUrl: string | null;
} {
  const assets = asRecord(profile?.['assets']);
  return {
    avatarUrl: readText(assets?.['avatarUrl']),
    backgroundUrl: readText(assets?.['backgroundUrl']),
    characterArtworkUrl: readText(assets?.['characterArtworkUrl']),
  };
}

/**
 * arcaea 搭档 1080px 立绘 URL：`{origin}/arcaea/asset/char/1080/{character}.png`。
 *
 * 镜像 App `_characterArtworkUrl`（`arcaea_views.dart:1259-1263`）。v1 `assets` 有值时优先用
 * `assets.characterArtworkUrl`，本函数只是**老实例**（无 assets）的回退。
 */
export function arcaeaCharacterArtworkUrl(
  character: string | null,
  origin: string = DEFAULT_GAME_ASSET_ORIGIN,
): string | null {
  const text = readText(character);
  if (text === null) return null;
  return `${origin}/arcaea/asset/char/1080/${encodeURIComponent(text)}.png`;
}

/** phigros 头像：`avatar_asset_key` 优先，回落非绝对 URL 的 `avatar`（`phigros_net_models.dart:98-106`）。 */
function phigrosAvatar(
  native: Record<string, unknown> | null,
  top: Record<string, unknown> | null,
  origin: string,
): string | null {
  const assetKey =
    readFirstText(native, ['avatar_asset_key', 'avatarAssetKey']) ??
    readFirstText(top, ['avatar_asset_key', 'avatarAssetKey']);
  if (assetKey !== null) return phigrosAssetKeyUrl(assetKey, origin);

  const rawAvatar = readFirstText(native, ['avatar']) ?? readFirstText(top, ['avatar']);
  if (rawAvatar === null) return null;
  // App 的 `publicAvatarUrl` 对绝对 URL 返回 null（它只信资产键）——保持一致。
  if (/^https?:\/\//i.test(rawAvatar)) return null;
  return phigrosAssetKeyUrl(rawAvatar, origin);
}

/** phigros 背景：`background_song_id` 曲绘（`phigros_player_card.dart:153-156` 的 `songImage`）。 */
function phigrosBackground(
  native: Record<string, unknown> | null,
  top: Record<string, unknown> | null,
  origin: string,
): string | null {
  const songId =
    readFirstText(native, ['background_song_id', 'backgroundSongId']) ??
    readFirstText(top, ['background_song_id', 'backgroundSongId']);
  if (songId === null) return null;
  return phigrosAssetKeyUrl(`Assets/Tracks/${songId}/Illustration.jpg`, origin);
}

/** arcaea 头像：`avatar` 优先，回落搭档图标（`arcaea_models.dart:51-68`）。 */
function arcaeaAvatar(native: Record<string, unknown> | null, origin: string): string | null {
  const avatar = arcaeaAssetUrl(readFirstText(native, ['avatar']), origin);
  if (avatar !== null) return avatar;
  const character = readFirstText(native, ['character']);
  if (character === null) return null;
  return `${origin}/arcaea/asset/char/${encodeURIComponent(character)}_icon.png`;
}

/** arcaea 背景：`nameplate`（`arcaea_models.dart:70-77`）。 */
function arcaeaBackground(native: Record<string, unknown> | null, origin: string): string | null {
  return arcaeaAssetUrl(readFirstText(native, ['nameplate']), origin);
}

/** maimai 头像：`avatar_url`（MaiscoreHub 头像 URL，`maimai-dx.types.ts:154-155`）。 */
function maimaiAvatar(
  native: Record<string, unknown> | null,
  options: ProfileOptions,
): string | null {
  const raw = readFirstText(native, ['avatar_url', 'avatarUrl']);
  if (raw === null) return null;
  return normalizeAssetUrl(raw, options);
}

// ────────────────────────────────────────────────────────── 主入口

/**
 * 把一份 v1 档案归一成名片展示模型。
 *
 * **资源优先级**：v1 `profile.assets`（绝对 URL，服务端权威）> 本地 URL 规则（老实例回退）。
 * 老实例没有 `assets` 时行为与历史版本逐字一致（`profile.test.ts` 锁定）。
 *
 * @param game    游戏键（`maimai` / `phigros` / `arcaea`）；未知游戏返回空字段、不崩。
 * @param profile `GET /v1/games/{game}/profiles` 里的一条档案。
 * @param format  可选，`GET /v1/games/{game}/format` 的 `data`；给了就只展示它声明过的字段。
 * @param options 可选，资产基址覆盖（默认值来自 App 代码）。
 */
export function describeProfile(
  game: string,
  profile: GameProfile,
  format?: GameFormatLike | null,
  options: ProfileOptions = {},
): ProfileView {
  // 一律按 unknown 读：wire → 契约的映射在 `wire.ts`，这里不再假设字段一定存在。
  const record = asRecord(profile);
  const player = asRecord(record?.['player']);
  const native = asRecord(player?.['native']);
  const assets = readProfileAssets(record);

  const ratingRaw = player?.['rating'];
  const rating =
    typeof ratingRaw === 'number' && Number.isFinite(ratingRaw) ? ratingRaw : null;

  const gameAssetOrigin = options.gameAssetOrigin ?? DEFAULT_GAME_ASSET_ORIGIN;
  let avatarUrl: string | null = null;
  let backgroundUrl: string | null = null;
  let characterArtworkUrl: string | null = null;
  switch (game) {
    case 'phigros':
      // v1 assets 优先；老实例按 avatarAssetKey / backgroundSongId 本地拼（不回归）。
      avatarUrl = assets.avatarUrl ?? phigrosAvatar(native, record, gameAssetOrigin);
      backgroundUrl = assets.backgroundUrl ?? phigrosBackground(native, record, gameAssetOrigin);
      break;
    case 'arcaea':
      avatarUrl = assets.avatarUrl ?? arcaeaAvatar(native, gameAssetOrigin);
      backgroundUrl = assets.backgroundUrl ?? arcaeaBackground(native, gameAssetOrigin);
      characterArtworkUrl =
        assets.characterArtworkUrl ??
        arcaeaCharacterArtworkUrl(readFirstText(native, ['character']), gameAssetOrigin);
      break;
    case 'maimai':
      avatarUrl = assets.avatarUrl ?? maimaiAvatar(native, options);
      // v1 assets.backgroundUrl = 用户背景板（frame）URL；老实例没有 frame 概念 ⇒ null。
      backgroundUrl = assets.backgroundUrl;
      break;
    default:
      // 未知游戏：没有本地规则可依据；服务端给了 assets 就照用，否则保持空（不猜）。
      avatarUrl = assets.avatarUrl;
      backgroundUrl = assets.backgroundUrl;
      characterArtworkUrl = assets.characterArtworkUrl;
      break;
  }

  return {
    game,
    avatarUrl,
    backgroundUrl,
    characterArtworkUrl,
    rating,
    fields: buildFields(fieldSpecsOf(game), native, declaredNamesOf(format)),
    isPublic: record?.['isPublic'] === true,
  };
}
