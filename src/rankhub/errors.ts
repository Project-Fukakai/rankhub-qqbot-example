import { RankHubError, type RankHubErrorCode } from '../contracts/index.js';

/**
 * RankHub v1 的错误映射。
 *
 * 两套形状：
 * - **协议端点**（device_authorization / token / userinfo / revoke）走 RFC 6749 / 8628
 *   的裸 JSON：`{error, error_description}`（成功才是 token 结构）；
 * - **业务端点**（`/v1/games/**`）走 v1 envelope：`{code, message, data, requestId}`。
 *
 * 这里只做「HTTP 状态 + body → RankHubError」的映射，不做重试（重试在 http/games 层）。
 */

/** v1 envelope 的成功码（`data` 可用的判据）。 */
export const V1_SUCCESS_CODES: ReadonlySet<string> = new Set([
  'common.ok',
  'common.created',
  'common.accepted',
  'common.deleted',
]);

export interface ParsedErrorBody {
  /** 业务码（v1 envelope 的 `code`）。 */
  code: string | null;
  /** 协议错误码（`error`，RFC 6749 §5.2）。 */
  error: string | null;
  message: string | null;
  requestId: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 从任意响应体里尽力提取错误信息；不是对象时返回全 null。 */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { code: null, error: null, message: null, requestId: null };
  }
  const record = body as Record<string, unknown>;
  return {
    code: asString(record.code),
    error: asString(record.error),
    message: asString(record.message) ?? asString(record.error_description),
    requestId: asString(record.requestId),
  };
}

/**
 * `Retry-After`（RFC 7231 §7.1.3）：秒数或 HTTP-date。
 * 解析不了返回 null（调用方按默认 1s 退避）。
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - now) / 1000));
}

/** 业务码 → 契约错误码（不认识返回 null，交给状态码兜底）。 */
export function businessCodeToErrorCode(code: string): RankHubErrorCode | null {
  switch (code) {
    case 'game.firstPartyOnly':
      return 'first_party_only';
    case 'auth.unauthenticated':
    case 'auth.tokenInvalid':
      return 'unauthorized';
    case 'common.notFound':
      return 'not_found';
    case 'common.invalidArgument':
    case 'common.unprocessable':
      return 'invalid_argument';
    case 'common.rateLimited':
      return 'rate_limited';
    case 'common.internalError':
    case 'common.serviceUnavailable':
      return 'server_error';
    default:
      return null;
  }
}

function fallbackMessage(status: number, parsed: ParsedErrorBody): string {
  const detail = parsed.message ?? parsed.error ?? parsed.code ?? 'unknown';
  return `RankHub 请求失败（HTTP ${status}，${detail}）`;
}

/**
 * HTTP 失败 → `RankHubError`。
 *
 * 映射口径（task-2 / 契约 `RankHubErrorCode`）：
 * `401 → unauthorized`、`429 → rate_limited`、`403 + game.firstPartyOnly → first_party_only`、
 * `404 → not_found`、`400/422 → invalid_argument`、`5xx → server_error`；
 * 其余状态按 body 业务码兜底，再兜不住归 `invalid_argument`（不是网络错误）。
 */
export function mapHttpFailure(
  status: number,
  body: unknown,
  retryAfterHeader: string | null = null,
): RankHubError {
  const parsed = parseErrorBody(body);
  const retryAfter = parseRetryAfter(retryAfterHeader);
  const message = parsed.message ?? fallbackMessage(status, parsed);

  if (parsed.code === 'game.firstPartyOnly') {
    return new RankHubError('first_party_only', status, message, retryAfter);
  }
  switch (status) {
    case 400:
    case 422:
      return new RankHubError('invalid_argument', status, message, retryAfter);
    case 401:
      return new RankHubError('unauthorized', status, message, retryAfter);
    case 403:
      // 403 无更细业务码时按「无权访问」处理（契约没有 forbidden，用 unauthorized 承载）。
      return new RankHubError('unauthorized', status, message, retryAfter);
    case 404:
      return new RankHubError('not_found', status, message, retryAfter);
    case 429:
      return new RankHubError('rate_limited', status, message, retryAfter);
    default:
      break;
  }
  if (status >= 500) {
    return new RankHubError('server_error', status, message, retryAfter);
  }
  const fromBody = parsed.code === null ? null : businessCodeToErrorCode(parsed.code);
  return new RankHubError(fromBody ?? 'invalid_argument', status, message, retryAfter);
}

/** 请求根本没发出去 / 连接断了：`network_error`（status=0，便于和 HTTP 错误区分）。 */
export function mapNetworkFailure(error: unknown): RankHubError {
  const detail = error instanceof Error ? error.message : String(error);
  return new RankHubError('network_error', 0, `RankHub 网络请求失败：${detail}`);
}

/** 2xx 但没有可用的 envelope / data：服务端不守契约。 */
export function invalidResponse(message: string, status = 200): RankHubError {
  return new RankHubError('server_error', status, message);
}
