import { RankHubError } from '../contracts/index.js';

import {
  businessCodeToErrorCode,
  invalidResponse,
  mapHttpFailure,
  mapNetworkFailure,
  parseErrorBody,
  V1_SUCCESS_CODES,
} from './errors.js';
import { asRecord, readString } from './wire.js';

/** 一次 HTTP 往返的原始结果（body 已尽力 JSON.parse；不是 JSON 时为 null）。 */
export interface RawHttpResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export interface HttpTransportOptions {
  /** 测试注入；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 注入的 sleep（429 退避），默认真等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 单请求超时（毫秒），默认 15s。 */
  timeoutMs?: number;
  /** 429 退避上限（毫秒），默认 60s；防止服务端给个离谱的 Retry-After 把进程挂住。 */
  maxRetryDelayMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * RankHub 的最小 HTTP 层。
 *
 * - 所有网络失败统一成 `RankHubError('network_error')`（status=0）；
 * - 429 只在这一层按 `Retry-After` 退避重试**一次**（契约要求），只用于 v1 envelope 端点；
 * - 协议端点（token 等）不在这里做语义判断 —— 它们的 200 + `{error}` 语义必须由调用方
 *   显式检查 body（RFC 8628），不能被「HTTP 200 = 成功」的表象吞掉。
 */
export class HttpTransport {
  private readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: HttpTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
  }

  async send(url: string, init: RequestInit): Promise<RawHttpResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw mapNetworkFailure(error);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw mapNetworkFailure(error);
    }
    let body: unknown = null;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, headers: response.headers, body, text };
  }

  /** `application/x-www-form-urlencoded` POST（OAuth 端点全是这个）。 */
  async postForm(url: string, fields: Record<string, string>): Promise<RawHttpResponse> {
    return this.send(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /**
   * GET 一个 v1 envelope 端点并返回 `data`。
   * 429 → 按 Retry-After 退避后重试一次；第二次仍失败则抛 `rate_limited`。
   */
  async getV1(url: string, accessToken: string): Promise<unknown> {
    return this.exchangeV1(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    });
  }

  /**
   * PATCH 一个 v1 envelope 端点（JSON body）并返回 `data`。
   *
   * 与 `getV1` 共用同一套 envelope 判定 / 429 单次重试；除 429（服务端明确没处理请求）外
   * 写请求不做盲目重试。
   */
  async patchV1(url: string, accessToken: string, body: unknown): Promise<unknown> {
    return this.exchangeV1(url, {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  /** v1 envelope 往返（含 429 单次退避）。 */
  private async exchangeV1(url: string, init: RequestInit): Promise<unknown> {
    const first = await this.send(url, init);
    const firstError = envelopeError(first);
    if (firstError === null) return envelopeData(first);
    if (firstError.code === 'rate_limited') {
      const seconds = Math.max(firstError.retryAfterSeconds ?? 1, 0);
      await this.sleep(Math.min(seconds * 1000, this.maxRetryDelayMs));
      const second = await this.send(url, init);
      const secondError = envelopeError(second);
      if (secondError !== null) throw secondError;
      return envelopeData(second);
    }
    throw firstError;
  }
}

/** 2xx 且业务码成功 ⇒ null；否则给出应抛的错误。 */
function envelopeError(response: RawHttpResponse): RankHubError | null {
  const { status } = response;
  if (status < 200 || status >= 300) {
    return mapHttpFailure(status, response.body, response.headers.get('retry-after'));
  }
  const record = asRecord(response.body);
  const code = readString(record, 'code');
  if (record === null || code === null) {
    return invalidResponse('RankHub 响应不是 v1 envelope（缺少 code）', status);
  }
  if (V1_SUCCESS_CODES.has(code)) return null;
  const parsed = parseErrorBody(response.body);
  const mapped = businessCodeToErrorCode(code) ?? 'server_error';
  const message = parsed.message ?? `RankHub 返回业务错误码 ${code}`;
  return new RankHubError(mapped, status, message);
}

function envelopeData(response: RawHttpResponse): unknown {
  const record = asRecord(response.body);
  const data = record?.['data'];
  if (data === undefined) {
    throw invalidResponse('RankHub v1 envelope 缺少 data 字段', response.status);
  }
  return data;
}
