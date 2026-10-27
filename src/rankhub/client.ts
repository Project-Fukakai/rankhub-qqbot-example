import type { AppConfig } from '../config/index.js';
import {
  RankHubError,
  type Binding,
  type BindingStore,
  type DeviceAuthorization,
  type DevicePollResult,
  type GameBests,
  type GameCapability,
  type GameProfile,
  type RankHubClient,
  type RankHubIdentity,
  type RankHubTokens,
  type ScorePage,
  type ScoresQuery,
} from '../contracts/index.js';
import { createLogger, silentLogger, type Logger } from '../logger/index.js';
import { createTokenCipher } from '../store/crypto.js';

import { invalidResponse, mapHttpFailure, parseErrorBody } from './errors.js';
import { HttpTransport, type HttpTransportOptions } from './http.js';
import {
  asRecord,
  readArray,
  readString,
  toDeviceAuthorization,
  toGameBests,
  toGameCapabilities,
  toProfilePage,
  toRankHubIdentity,
  toRankHubTokens,
  toScorePage,
} from './wire.js';

/** `createRankHubClient` 需要的配置子集（`loadConfig()` 的返回值天然满足）。 */
export type RankHubClientConfig = Pick<
  AppConfig,
  | 'RANKHUB_CLIENT_ID'
  | 'RANKHUB_CLIENT_SECRET'
  | 'RANKHUB_AUTH_BASE'
  | 'RANKHUB_API_BASE'
  | 'RANKHUB_SCOPES'
  | 'TOKEN_ENC_KEY'
>;

export interface RankHubClientDeps extends HttpTransportOptions {
  /** 刷新令牌要落库、invalid_grant 要标记 revoked，所以必须给 store。 */
  store: BindingStore;
  logger?: Logger;
}

/** 刷新结果（access token 明文只在内存里出现，落库的是密文）。 */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** 绝对过期时刻（epoch ms）。 */
  expiresAt: number;
  scope: string;
  idToken: string | null;
}

/** 契约 `RankHubClient` 的超集：刷新与「按 binding 取可用 access token」不在冻结契约里。 */
export interface RankHubClientExtended extends RankHubClient {
  /**
   * 用 binding 里加密保存的 refresh token 换新令牌。
   *
   * - 同一 binding 并发调用**只发一次**请求（single-flight）；
   * - **先把新 refresh token 落库成功再返回**（服务端刷新是轮换式的，丢一次就永久失效）；
   * - `invalid_grant`（含旧 rt 重放）⇒ 标记 binding revoked 并抛 `RankHubError('invalid_grant')`。
   */
  refresh(binding: Binding): Promise<RefreshedTokens>;
  /**
   * 取一个可用的 access token：未过期且未撤销就直接解密返回，否则走刷新。
   * 供 commands 层使用（契约里没有这一层）。
   */
  authorize(binding: Binding): Promise<string>;
}

/** userinfo 失败时写入的占位 subject（绑定不因此中断）。 */
export const UNKNOWN_SUBJECT = 'unknown';

/** RFC 8628 的 device_code grant type。 */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** 设备码默认轮询间隔（秒），服务端下发 interval 时以服务端为准。 */
export const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;

/** `slow_down` 时 RFC 8628 要求每次 +5 秒。 */
export const SLOW_DOWN_STEP_SECONDS = 5;

/** 设备码默认有效期（秒），仅用于响应缺字段时兜底展示。 */
const DEFAULT_DEVICE_EXPIRES_IN_SECONDS = 600;

const SORT_KEYS = new Set(['playTime', 'achievements', 'rating']);
const SORT_ORDERS = new Set(['asc', 'desc']);
/** profiles 契约没有分页，逐页取全时的硬上限（防止服务端游标异常导致死循环）。 */
const MAX_PROFILE_PAGES = 20;

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function oauthMessage(body: unknown): string | null {
  return parseErrorBody(body).message;
}

function oauthErrorCode(body: unknown): string | null {
  return parseErrorBody(body).error;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function clampLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isFinite(limit)) {
    throw new RankHubError('invalid_argument', 0, `limit 不是有限数字：${String(limit)}`);
  }
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

/**
 * 建立 RankHub 客户端（设备码 OAuth + `/v1/games/**` 只读 + 令牌刷新）。
 *
 * 所有网络出口可注入（`fetchImpl` / `sleep`），测试一律打本地假服务器，不碰真实 RankHub。
 */
export function createRankHubClient(
  config: RankHubClientConfig,
  deps: RankHubClientDeps,
): RankHubClientExtended {
  const authBase = trimBase(config.RANKHUB_AUTH_BASE);
  const apiBase = trimBase(config.RANKHUB_API_BASE);
  const store = deps.store;
  const logger = deps.logger ?? silentLogger;
  const http = new HttpTransport(deps);
  const cipher = createTokenCipher(config.TOKEN_ENC_KEY);

  /** 每条 device_code 当前的轮询间隔（slow_down 后 +5，按 RFC 8628 §3.5）。 */
  const pollIntervals = new Map<string, number>();
  /** single-flight：bindingId → 正在进行的刷新 Promise。 */
  const inflightRefresh = new Map<string, Promise<RefreshedTokens>>();

  const log = logger.child({ module: 'rankhub' });

  function authUrl(path: string): string {
    return `${authBase}${path}`;
  }

  function apiUrl(path: string, params?: URLSearchParams): string {
    const query = params !== undefined && params.size > 0 ? `?${params.toString()}` : '';
    return `${apiBase}${path}${query}`;
  }

  function tokensFromBody(body: unknown): RankHubTokens {
    return toRankHubTokens(asRecord(body) ?? {}, { scope: config.RANKHUB_SCOPES });
  }

  async function deviceStart(scope: string): Promise<DeviceAuthorization> {
    const response = await http.postForm(authUrl('/v1/oauth/device_authorization'), {
      client_id: config.RANKHUB_CLIENT_ID,
      scope,
    });
    if (!isSuccess(response.status)) {
      throw mapHttpFailure(response.status, response.body, response.headers.get('retry-after'));
    }
    const authorization = toDeviceAuthorization(asRecord(response.body) ?? {}, {
      interval: DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
      expiresIn: DEFAULT_DEVICE_EXPIRES_IN_SECONDS,
    });
    pollIntervals.set(authorization.deviceCode, authorization.interval);
    log.debug('设备码申请成功', {
      userCode: authorization.userCode,
      interval: authorization.interval,
      expiresIn: authorization.expiresIn,
    });
    return authorization;
  }

  async function devicePoll(deviceCode: string): Promise<DevicePollResult> {
    const response = await http.postForm(authUrl('/v1/oauth/token'), {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: config.RANKHUB_CLIENT_ID,
      client_secret: config.RANKHUB_CLIENT_SECRET,
    });
    const body = asRecord(response.body);
    const error = oauthErrorCode(response.body);
    const interval = pollIntervals.get(deviceCode) ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS;

    if (isSuccess(response.status)) {
      // ❗ RFC 8628 §3.5：authorization_pending / slow_down 是 **HTTP 200 + body.error**。
      // 只看状态码会把「还没批准」当成功解析成空 token。
      if (error === 'authorization_pending') return { status: 'pending' };
      if (error === 'slow_down') {
        const next = interval + SLOW_DOWN_STEP_SECONDS;
        pollIntervals.set(deviceCode, next);
        return { status: 'slow_down', interval: next };
      }
      if (error === 'access_denied') {
        pollIntervals.delete(deviceCode);
        return { status: 'denied' };
      }
      if (error === 'expired_token') {
        pollIntervals.delete(deviceCode);
        return { status: 'expired' };
      }
      if (readString(body, 'access_token') !== null) {
        pollIntervals.delete(deviceCode);
        return { status: 'ok', tokens: tokensFromBody(response.body) };
      }
      throw invalidResponse(
        `设备码轮询返回了既无 access_token 也无已知 error 的响应（error=${String(error)}）`,
        response.status,
      );
    }

    if (error === 'access_denied') {
      pollIntervals.delete(deviceCode);
      return { status: 'denied' };
    }
    if (error === 'expired_token') {
      pollIntervals.delete(deviceCode);
      return { status: 'expired' };
    }
    throw mapHttpFailure(response.status, response.body, response.headers.get('retry-after'));
  }

  async function userinfo(accessToken: string): Promise<RankHubIdentity> {
    try {
      const response = await http.send(authUrl('/v1/oidc/userinfo'), {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      });
      if (!isSuccess(response.status)) {
        throw mapHttpFailure(response.status, response.body, response.headers.get('retry-after'));
      }
      const body = asRecord(response.body);
      if (body === null) throw invalidResponse('userinfo 响应不是 JSON 对象', response.status);
      return toRankHubIdentity(body);
    } catch (error) {
      // 任务口径：userinfo 失败不阻断绑定 —— 返回「subject 未知 + name null」。
      const code = error instanceof RankHubError ? error.code : 'network_error';
      log.warn('RankHub userinfo 获取失败，绑定继续（subject 未知）', { code });
      return { subject: UNKNOWN_SUBJECT, name: null, picture: null };
    }
  }

  async function listGames(accessToken: string): Promise<GameCapability[]> {
    const data = await http.getV1(apiUrl('/v1/games'), accessToken);
    const record = asRecord(data);
    const entries = record?.['games'];
    if (record === null || !Array.isArray(entries)) {
      throw invalidResponse('/v1/games 响应缺少 data.games 数组');
    }
    return toGameCapabilities(readArray(record, 'games'));
  }

  async function listProfiles(accessToken: string, game: string): Promise<GameProfile[]> {
    const profiles: GameProfile[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PROFILE_PAGES; page += 1) {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (cursor !== null) params.set('cursor', cursor);
      const data = await http.getV1(
        apiUrl(`/v1/games/${encodeURIComponent(game)}/profiles`, params),
        accessToken,
      );
      const mapped = toProfilePage(data);
      profiles.push(...mapped.items);
      if (mapped.nextCursor === null) break;
      cursor = mapped.nextCursor;
    }
    return profiles;
  }

  async function getBests(
    accessToken: string,
    game: string,
    profileId: string,
  ): Promise<GameBests> {
    const data = await http.getV1(
      apiUrl(
        `/v1/games/${encodeURIComponent(game)}/profiles/${encodeURIComponent(profileId)}/bests`,
      ),
      accessToken,
    );
    return toGameBests(data);
  }

  async function listScores(
    accessToken: string,
    game: string,
    profileId: string,
    query: ScoresQuery = {},
  ): Promise<ScorePage> {
    const params = new URLSearchParams();
    const limit = clampLimit(query.limit);
    if (limit !== null) params.set('limit', String(limit));
    if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
    if (query.sortBy !== undefined) {
      if (!SORT_KEYS.has(query.sortBy)) {
        throw new RankHubError('invalid_argument', 0, `不支持的 sortBy：${String(query.sortBy)}`);
      }
      params.set('sortBy', query.sortBy);
    }
    if (query.order !== undefined) {
      if (!SORT_ORDERS.has(query.order)) {
        throw new RankHubError('invalid_argument', 0, `不支持的 order：${String(query.order)}`);
      }
      params.set('order', query.order);
    }
    if (query.difficulty !== undefined && query.difficulty !== '') {
      params.set('difficulty', query.difficulty);
    }
    const data = await http.getV1(
      apiUrl(
        `/v1/games/${encodeURIComponent(game)}/profiles/${encodeURIComponent(profileId)}/scores`,
        params,
      ),
      accessToken,
    );
    return toScorePage(data);
  }

  async function revoke(token: string): Promise<void> {
    const response = await http.postForm(authUrl('/v1/oauth/revoke'), { token });
    // RFC 7009：撤销成功恒 200（body `{}`）；未知 token 也是 200。
    if (!isSuccess(response.status)) {
      throw mapHttpFailure(response.status, response.body, response.headers.get('retry-after'));
    }
  }

  async function markRevokedQuietly(bindingId: string): Promise<void> {
    try {
      await store.markRevoked(bindingId);
    } catch (error) {
      log.warn('标记 binding 撤销失败（继续抛 invalid_grant）', {
        bindingId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function performRefresh(binding: Binding): Promise<RefreshedTokens> {
    if (binding.status === 'revoked') {
      // 已撤销的 binding 没必要再去换令牌（服务端只会回 invalid_grant）。
      throw new RankHubError('unauthorized', 401, '该 RankHub 绑定已撤销，请重新 /bind');
    }
    const refreshToken = cipher.decrypt(binding.id, 'refresh_token', binding.refreshTokenEnc);
    const response = await http.postForm(authUrl('/v1/oauth/token'), {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.RANKHUB_CLIENT_ID,
      client_secret: config.RANKHUB_CLIENT_SECRET,
    });

    const errorCode = oauthErrorCode(response.body);
    if (errorCode === 'invalid_grant' || response.status === 401) {
      await markRevokedQuietly(binding.id);
      throw new RankHubError(
        'invalid_grant',
        response.status,
        oauthMessage(response.body) ?? 'refresh token 已失效（可能被重放或已撤销）',
      );
    }
    if (!isSuccess(response.status)) {
      throw mapHttpFailure(response.status, response.body, response.headers.get('retry-after'));
    }

    const tokens = toRankHubTokens(asRecord(response.body) ?? {}, {
      refreshToken,
      scope: binding.scopes !== '' ? binding.scopes : config.RANKHUB_SCOPES,
    });
    const expiresIn = tokens.expiresIn;
    const expiresAt = Date.now() + expiresIn * 1000;
    const nextRefreshToken = tokens.refreshToken !== '' ? tokens.refreshToken : refreshToken;

    // ❗ 先落库、后返回：刷新是轮换式的，服务端已经作废旧 rt；不落库就等于丢了。
    await store.updateTokens(binding.id, {
      accessToken: tokens.accessToken,
      refreshToken: nextRefreshToken,
      accessExpiresAt: expiresAt,
      scopes: tokens.scope,
    });
    log.debug('RankHub 令牌刷新成功并已落库', { bindingId: binding.id, expiresIn });

    return {
      accessToken: tokens.accessToken,
      refreshToken: nextRefreshToken,
      expiresIn,
      expiresAt,
      scope: tokens.scope,
      idToken: tokens.idToken,
    };
  }

  function refresh(binding: Binding): Promise<RefreshedTokens> {
    const existing = inflightRefresh.get(binding.id);
    if (existing !== undefined) return existing;
    const pending = performRefresh(binding);
    inflightRefresh.set(binding.id, pending);
    return pending.finally(() => {
      if (inflightRefresh.get(binding.id) === pending) inflightRefresh.delete(binding.id);
    });
  }

  async function authorize(binding: Binding): Promise<string> {
    if (binding.status === 'revoked') {
      throw new RankHubError('unauthorized', 401, '该 RankHub 绑定已撤销，请重新 /bind');
    }
    const fresh =
      binding.accessTokenEnc !== null &&
      binding.accessExpiresAt !== null &&
      binding.accessExpiresAt - Date.now() > 30_000;
    if (fresh) {
      return cipher.decrypt(binding.id, 'access_token', binding.accessTokenEnc as string);
    }
    const refreshed = await refresh(binding);
    return refreshed.accessToken;
  }

  return {
    deviceStart,
    devicePoll,
    userinfo,
    listGames,
    listProfiles,
    getBests,
    listScores,
    revoke,
    refresh,
    authorize,
  };
}

/** 默认 logger 便利函数（bot 装配时可直接用）。 */
export function createRankHubLogger(level: 'debug' | 'info' | 'warn' | 'error'): Logger {
  return createLogger(level).child({ module: 'rankhub' });
}
