import type { Logger } from '../logger/index.js';
import { QQApiError, errorMessage } from './errors.js';
import { assertBusinessOk, httpRequest, type HttpResponse } from './http.js';

/** 提前多少毫秒续期。 */
export const DEFAULT_REFRESH_AHEAD_MS = 60_000;
export const DEFAULT_TOKEN_TTL_SECONDS = 7200;

export interface AccessTokenManagerOptions {
  tokenUrl: string;
  appId: string;
  appSecret: string;
  logger: Logger;
  refreshAheadMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  defaultTtlSeconds?: number;
}

/**
 * QQ AccessToken 管理：缓存 + 提前 60s 续期 + 并发 single-flight。
 *
 * 官方行为（lead 2026-10-27 实测）：
 * - 成功：HTTP 200，body {access_token, expires_in:"7200"}（字符串！），无 code；
 * - 失败：HTTP 200 + body.code（如 100016），必须当错误处理。
 */
export class AccessTokenManager {
  private current: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  private readonly refreshAheadMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly defaultTtlSeconds: number;

  constructor(private readonly options: AccessTokenManagerOptions) {
    this.refreshAheadMs = options.refreshAheadMs ?? DEFAULT_REFRESH_AHEAD_MS;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  }

  /** 当前缓存的过期时间（毫秒时间戳），没有则 null。测试/诊断用。 */
  get expiresAt(): number | null {
    return this.current?.expiresAt ?? null;
  }

  async get(): Promise<string> {
    const now = this.now();
    if (this.current !== null && now < this.current.expiresAt - this.refreshAheadMs) {
      return this.current.value;
    }
    return this.refresh();
  }

  /** 收到 401 时调用，丢弃缓存；下一次 get() 会重新取。 */
  invalidate(): void {
    this.current = null;
  }

  private refresh(): Promise<string> {
    if (this.inflight !== null) return this.inflight;

    const pending = this.doRefresh().finally(() => {
      if (this.inflight === pending) this.inflight = null;
    });
    this.inflight = pending;
    return pending;
  }

  private async doRefresh(): Promise<string> {
    const { tokenUrl, appId, appSecret, logger } = this.options;
    if (appId === '' || appSecret === '') {
      throw new QQApiError('获取 QQ AccessToken 失败：QQ_APP_ID / QQ_APP_SECRET 未配置');
    }

    const response = await httpRequest({
      url: tokenUrl,
      method: 'POST',
      json: { appId, clientSecret: appSecret },
      timeoutMs: this.timeoutMs,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });

    let body: unknown;
    try {
      body = assertBusinessOk(response, '获取 QQ AccessToken');
    } catch (error) {
      throw this.sanitizeError(error, response);
    }

    const record = isRecord(body) ? body : {};
    const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
    if (accessToken === '') {
      // 理论上不会发生；不把整个 body 塞进 message，避免把凭证带进日志。
      throw new QQApiError('获取 QQ AccessToken 失败：响应缺少 access_token', {
        status: response.status,
        body: sanitizeBody(body, appSecret),
      });
    }

    const expiresIn = readPositiveNumber(record.expires_in) ?? this.defaultTtlSeconds;
    this.current = { value: accessToken, expiresAt: this.now() + expiresIn * 1000 };
    logger.info('QQ AccessToken 已刷新', { expiresInSeconds: expiresIn });
    return accessToken;
  }

  private sanitizeError(error: unknown, response: HttpResponse): QQApiError {
    const { appSecret } = this.options;
    if (!(error instanceof QQApiError)) {
      return new QQApiError(`获取 QQ AccessToken 失败：${errorMessage(error)}`, {
        status: response.status,
        body: sanitizeBody(response.json, appSecret),
      });
    }
    return new QQApiError(redactSecrets(error.message, appSecret), {
      code: error.code,
      status: error.status,
      body: sanitizeBody(error.body, appSecret),
    });
  }
}

/** expires_in 可能是数字也可能是字符串（官方实测是 "7200"）。 */
export function readPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactSecrets(message: string, secret: string): string {
  if (secret === '') return message;
  return message.split(secret).join('[REDACTED]');
}

/** 错误体也只保留 code/message，避免把可能的凭证回显带出去。 */
function sanitizeBody(body: unknown, secret: string): unknown {
  if (!isRecord(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'access_token' || key === 'appSecret' || key === 'clientSecret') {
      out[key] = '[REDACTED]';
    } else {
      out[key] = typeof value === 'string' ? redactSecrets(value, secret) : value;
    }
  }
  return out;
}
