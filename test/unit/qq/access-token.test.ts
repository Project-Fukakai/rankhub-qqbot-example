import { describe, expect, it, vi } from 'vitest';

import { AccessTokenManager, QQApiError } from '../../../src/qq/index.js';
import { jsonResponse, testLogger } from './helpers.js';

const TOKEN_URL = 'http://127.0.0.1:1/app/getAppAccessToken';
const APP_SECRET = 'super-secret-value';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (call: FetchCall) => Promise<Response> | Response): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function manager(
  fetchImpl: typeof fetch,
  overrides: { now?: () => number; appId?: string; appSecret?: string } = {},
): AccessTokenManager {
  return new AccessTokenManager({
    tokenUrl: TOKEN_URL,
    appId: overrides.appId ?? 'app-id',
    appSecret: overrides.appSecret ?? APP_SECRET,
    logger: testLogger,
    fetchImpl,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

describe('AccessTokenManager', () => {
  it('成功响应：解析字符串 expires_in、request body 用 appId/clientSecret', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ access_token: 'at_123', expires_in: '7200' }),
    );
    const tokens = manager(fetchImpl);

    await expect(tokens.get()).resolves.toBe('at_123');
    await expect(tokens.get()).resolves.toBe('at_123'); // 命中缓存

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      appId: 'app-id',
      clientSecret: APP_SECRET,
    });
    expect(tokens.expiresAt).toBeTypeOf('number');
  });

  it('提前 60s 续期', async () => {
    let now = 1_000_000;
    let counter = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      counter += 1;
      return jsonResponse({ access_token: `at_${counter}`, expires_in: 3600 });
    });
    const tokens = manager(fetchImpl, { now: () => now });

    await expect(tokens.get()).resolves.toBe('at_1');
    const expiresAt = tokens.expiresAt as number;
    expect(expiresAt).toBe(now + 3_600_000);

    now = expiresAt - 61_000;
    await expect(tokens.get()).resolves.toBe('at_1');
    expect(calls).toHaveLength(1);

    now = expiresAt - 59_000;
    await expect(tokens.get()).resolves.toBe('at_2');
    expect(calls).toHaveLength(2);
  });

  it('并发取 token 走 single-flight', async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ access_token: 'at_shared', expires_in: 7200 })), 20);
        }),
    );
    const tokens = manager(fetchImpl);

    const [first, second, third] = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect([first, second, third]).toEqual(['at_shared', 'at_shared', 'at_shared']);
    expect(calls).toHaveLength(1);
  });

  it('HTTP 200 + body.code 视为业务错误', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ code: 100016, message: 'appid or secret is invalid' }),
    );
    const tokens = manager(fetchImpl);

    const error = await tokens.get().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QQApiError);
    const apiError = error as QQApiError;
    expect(apiError.code).toBe(100016);
    expect(apiError.status).toBe(200);
    expect(apiError.message).toContain('100016');
    // 错误信息与错误体里都不能出现 app secret。
    expect(apiError.message).not.toContain(APP_SECRET);
    expect(JSON.stringify(apiError.body)).not.toContain(APP_SECRET);
  });

  it('HTTP 5xx 抛出带 status 的错误', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ code: 500, message: 'boom' }, 500));
    const tokens = manager(fetchImpl);

    const error = await tokens.get().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QQApiError);
    expect((error as QQApiError).status).toBe(500);
  });

  it('成功响应缺 access_token 视为失败', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ expires_in: '7200' }));
    const tokens = manager(fetchImpl);
    await expect(tokens.get()).rejects.toThrow(/access_token/);
  });

  it('invalidate 后重新取 token', async () => {
    let counter = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      counter += 1;
      return jsonResponse({ access_token: `at_${counter}`, expires_in: 7200 });
    });
    const tokens = manager(fetchImpl);

    await expect(tokens.get()).resolves.toBe('at_1');
    tokens.invalidate();
    await expect(tokens.get()).resolves.toBe('at_2');
    expect(calls).toHaveLength(2);
  });

  it('凭据为空时直接报错，不发请求', async () => {
    const spy = vi.fn();
    const fetchImpl = spy as unknown as typeof fetch;
    const tokens = manager(fetchImpl, { appId: '' });

    await expect(tokens.get()).rejects.toThrow(/未配置/);
    expect(spy).not.toHaveBeenCalled();
  });
});
