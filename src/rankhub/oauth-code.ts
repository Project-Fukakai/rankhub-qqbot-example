/**
 * 授权码 + App 确认（`/v1/interaction/oauth-authorizations`）——设备码确认页不可用时的替代绑定链路。
 *
 * 背景（代码事实）：`rankhub_net/services/identity-go/internal/server/v1oauth_device.go` 在写
 * `device_code` artifact 时**没有**写 `clientId` metadata，而确认页服务端
 * （`v1oauthreq_device.go:96-103`）从 `deviceArtifact.Metadata["clientId"]` 读取，导致所有
 * 设备码在确认页都报 “device authorization is missing its client id”。
 *
 * 因此绑定改走**服务端到服务端**的授权请求：
 *   1. 机器人 POST `/v1/interaction/oauth-authorizations`（带 client_id / redirect_uri / scope / state）
 *      → 服务端返回 pollToken、deepLink、二维码 PNG data URL；
 *   2. 机器人把二维码/深链发给用户，用户在 RankHub App 内确认；
 *   3. 机器人轮询 `/v1/interaction/oauth-authorizations/status`；
 *   4. `approved` 时服务端返回 `resumeUrl`（`<redirect_uri>?code=…&state=…`），机器人直接从中取 code，
 *      再用 `client_secret_post` 换令牌。
 *
 * 全程不需要浏览器，也不需要监听回环端口；`redirect_uri` 只作为 code 的载体（必须在应用上注册）。
 */
import { RankHubError, type RankHubTokens } from '../contracts/index.js';

export interface AuthorizationClientConfig {
  RANKHUB_AUTH_BASE: string;
  RANKHUB_CLIENT_ID: string;
  RANKHUB_CLIENT_SECRET: string;
}

export interface AuthorizationRequestOptions {
  redirectUri: string;
  scope: string;
  state: string;
  /** 可选：给 App 的提示（如 QQ 昵称）。 */
  target?: Record<string, unknown>;
}

export interface AuthorizationRequest {
  pollToken: string;
  deepLink: string;
  qrDataUrl: string | null;
  expiresAt: number;
}

export type AuthorizationStatusResult =
  | { status: 'pending' }
  | { status: 'approved'; resumeUrl: string }
  | { status: 'denied' | 'expired' | 'cancelled' | 'consumed' };

export interface AuthorizationClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessageOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.error_description ?? record.error;
    if (typeof message === 'string' && message !== '') return message;
  }
  return 'RankHub 返回了无法解析的错误';
}

function mapStatus(status: number, body: unknown): RankHubError {
  const record = (body ?? {}) as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  if (status === 401) return new RankHubError('unauthorized', status, errorMessageOf(body));
  if (status === 429) return new RankHubError('rate_limited', status, errorMessageOf(body), 5);
  if (status === 404) return new RankHubError('not_found', status, errorMessageOf(body));
  if (status === 403 && code.includes('firstPartyOnly')) {
    return new RankHubError('first_party_only', status, errorMessageOf(body));
  }
  if (status >= 400 && status < 500) return new RankHubError('invalid_argument', status, errorMessageOf(body));
  return new RankHubError('server_error', status, errorMessageOf(body));
}

async function postJson(
  url: string,
  body: unknown,
  deps: AuthorizationClientDeps,
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new RankHubError('network_error', 0, `请求 RankHub 失败：${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  return { status: response.status, body: parseBody(text) };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  deps: AuthorizationClientDeps,
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    throw new RankHubError('network_error', 0, `请求 RankHub 失败：${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  return { status: response.status, body: parseBody(text) };
}

function dataOf(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    const data = (body as Record<string, unknown>).data;
    if (data && typeof data === 'object') return data as Record<string, unknown>;
  }
  return (body ?? {}) as Record<string, unknown>;
}

export function codeFromResumeUrl(resumeUrl: string): string | null {
  try {
    return new URL(resumeUrl).searchParams.get('code');
  } catch {
    return null;
  }
}

/** 建一条授权请求（App 确认）。 */
export async function createAuthorizationRequest(
  config: AuthorizationClientConfig,
  options: AuthorizationRequestOptions,
  deps: AuthorizationClientDeps = {},
): Promise<AuthorizationRequest> {
  const url = `${trimBase(config.RANKHUB_AUTH_BASE)}/v1/interaction/oauth-authorizations`;
  const { status, body } = await postJson(
    url,
    {
      clientId: config.RANKHUB_CLIENT_ID,
      redirectUri: options.redirectUri,
      responseType: 'code',
      scope: options.scope,
      state: options.state,
      ...(options.target === undefined ? {} : { target: options.target }),
    },
    deps,
  );
  if (status < 200 || status >= 300) throw mapStatus(status, body);
  const data = dataOf(body);
  const pollToken = data.pollToken;
  const deepLink = data.deepLink;
  if (typeof pollToken !== 'string' || pollToken === '' || typeof deepLink !== 'string') {
    throw new RankHubError('server_error', status, '授权请求响应缺少 pollToken/deepLink');
  }
  const expiresAtRaw = data.expiresAt;
  const expiresAt =
    typeof expiresAtRaw === 'string' && Number.isFinite(Date.parse(expiresAtRaw))
      ? Date.parse(expiresAtRaw)
      : Date.now() + 600_000;
  return {
    pollToken,
    deepLink,
    qrDataUrl: typeof data.deepLinkQrCodeDataUrl === 'string' ? data.deepLinkQrCodeDataUrl : null,
    expiresAt,
  };
}

/** 查授权状态；`approved` 时带 `resumeUrl`（含一次性 code）。 */
export async function pollAuthorizationStatus(
  config: AuthorizationClientConfig,
  pollToken: string,
  deps: AuthorizationClientDeps = {},
): Promise<AuthorizationStatusResult> {
  const url = `${trimBase(config.RANKHUB_AUTH_BASE)}/v1/interaction/oauth-authorizations/status`;
  const { status, body } = await postJson(url, { pollToken }, deps);
  if (status < 200 || status >= 300) throw mapStatus(status, body);
  const data = dataOf(body);
  const raw = typeof data.status === 'string' ? data.status : '';
  if (raw === 'approved') {
    const resumeUrl = data.resumeUrl;
    if (typeof resumeUrl !== 'string' || resumeUrl === '') {
      throw new RankHubError('server_error', status, '授权已通过但缺少 resumeUrl');
    }
    return { status: 'approved', resumeUrl };
  }
  if (raw === 'denied' || raw === 'expired' || raw === 'cancelled' || raw === 'consumed') {
    return { status: raw };
  }
  return { status: 'pending' };
}

/** 用授权码换令牌（机密客户端：`client_secret_post`）。 */
export async function exchangeAuthorizationCode(
  config: AuthorizationClientConfig,
  input: { code: string; redirectUri: string },
  deps: AuthorizationClientDeps = {},
): Promise<RankHubTokens> {
  const url = `${trimBase(config.RANKHUB_AUTH_BASE)}/v1/oauth/token`;
  const { status, body } = await postForm(
    url,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: config.RANKHUB_CLIENT_ID,
      client_secret: config.RANKHUB_CLIENT_SECRET,
    },
    deps,
  );
  if (status < 200 || status >= 300) throw mapStatus(status, body);
  const data = dataOf(body);
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new RankHubError('server_error', status, '令牌响应缺少 access_token/refresh_token');
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: Number(data.expires_in ?? 600),
    scope: typeof data.scope === 'string' ? data.scope : '',
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
  };
}
