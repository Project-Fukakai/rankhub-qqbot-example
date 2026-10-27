import { describe, expect, it } from 'vitest';

import { RankHubError } from '../../../src/contracts/index.js';
import {
  codeFromResumeUrl,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  pollAuthorizationStatus,
} from '../../../src/rankhub/oauth-code.js';

const config = {
  RANKHUB_AUTH_BASE: 'https://auth.test',
  RANKHUB_CLIENT_ID: 'rankhub-qqbot',
  RANKHUB_CLIENT_SECRET: 's3cret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('oauth-code 授权请求', () => {
  it('创建授权请求：解析 pollToken/deepLink/二维码/过期时间', async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      jsonResponse({
        code: 'common.ok',
        data: {
          pollToken: 'oauth_poll_1',
          deepLink: 'rankhub://oauth/authorize?token=oauth_poll_1',
          deepLinkQrCodeDataUrl: 'data:image/png;base64,AAAA',
          expiresAt: '2026-10-27T05:12:52.217Z',
          permissions: [],
        },
      }),
    );
    const request = await createAuthorizationRequest(
      config,
      {
        redirectUri: 'http://127.0.0.1:17830/callback',
        scope: 'openid profile',
        state: 'st-1',
      },
      { fetchImpl },
    );
    expect(request.pollToken).toBe('oauth_poll_1');
    expect(request.deepLink).toContain('rankhub://');
    expect(request.qrDataUrl).toBe('data:image/png;base64,AAAA');
    expect(request.expiresAt).toBe(Date.parse('2026-10-27T05:12:52.217Z'));

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe('https://auth.test/v1/interaction/oauth-authorizations');
    expect(body).toMatchObject({
      clientId: 'rankhub-qqbot',
      redirectUri: 'http://127.0.0.1:17830/callback',
      responseType: 'code',
      scope: 'openid profile',
      state: 'st-1',
    });
  });

  it('创建失败：401 ⇒ unauthorized，缺 pollToken ⇒ server_error', async () => {
    const unauthorized = captureFetch(() =>
      jsonResponse({ code: 'auth.invalidClient', message: 'Unknown OAuth client' }, 401),
    );
    await expect(
      createAuthorizationRequest(
        config,
        { redirectUri: 'http://127.0.0.1:17830/callback', scope: 'openid', state: 's' },
        { fetchImpl: unauthorized.fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const malformed = captureFetch(() => jsonResponse({ data: {} }));
    await expect(
      createAuthorizationRequest(
        config,
        { redirectUri: 'http://127.0.0.1:17830/callback', scope: 'openid', state: 's' },
        { fetchImpl: malformed.fetchImpl },
      ),
    ).rejects.toBeInstanceOf(RankHubError);
  });

  it('状态轮询：pending / approved(resumeUrl) / denied', async () => {
    const pending = captureFetch(() => jsonResponse({ data: { status: 'pending', resumeUrl: null } }));
    await expect(
      pollAuthorizationStatus(config, 'p1', { fetchImpl: pending.fetchImpl }),
    ).resolves.toEqual({ status: 'pending' });

    const approved = captureFetch(() =>
      jsonResponse({
        data: {
          status: 'approved',
          resumeUrl: 'http://127.0.0.1:17830/callback?code=code_x&state=st',
        },
      }),
    );
    await expect(
      pollAuthorizationStatus(config, 'p1', { fetchImpl: approved.fetchImpl }),
    ).resolves.toEqual({
      status: 'approved',
      resumeUrl: 'http://127.0.0.1:17830/callback?code=code_x&state=st',
    });

    const denied = captureFetch(() => jsonResponse({ data: { status: 'denied' } }));
    await expect(
      pollAuthorizationStatus(config, 'p1', { fetchImpl: denied.fetchImpl }),
    ).resolves.toEqual({ status: 'denied' });
  });

  it('状态轮询：approved 缺 resumeUrl ⇒ server_error', async () => {
    const broken = captureFetch(() => jsonResponse({ data: { status: 'approved' } }));
    await expect(
      pollAuthorizationStatus(config, 'p1', { fetchImpl: broken.fetchImpl }),
    ).rejects.toMatchObject({ code: 'server_error' });
  });
});

describe('oauth-code 换令牌', () => {
  it('authorization_code + client_secret_post：解析令牌', async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      jsonResponse({
        access_token: 'at_1',
        refresh_token: 'rt_1',
        expires_in: 600,
        scope: 'openid profile',
      }),
    );
    const tokens = await exchangeAuthorizationCode(
      config,
      { code: 'code_x', redirectUri: 'http://127.0.0.1:17830/callback' },
      { fetchImpl },
    );
    expect(tokens).toEqual({
      accessToken: 'at_1',
      refreshToken: 'rt_1',
      expiresIn: 600,
      scope: 'openid profile',
      idToken: null,
    });
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code_x');
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:17830/callback');
    expect(form.get('client_id')).toBe('rankhub-qqbot');
    expect(form.get('client_secret')).toBe('s3cret');
  });

  it('令牌错误：400 invalid_grant ⇒ invalid_argument；缺 refresh_token ⇒ server_error', async () => {
    const invalid = captureFetch(() =>
      jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, 400),
    );
    await expect(
      exchangeAuthorizationCode(
        config,
        { code: 'c', redirectUri: 'http://127.0.0.1:17830/callback' },
        { fetchImpl: invalid.fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'invalid_argument' });

    const malformed = captureFetch(() => jsonResponse({ access_token: 'at_1' }));
    await expect(
      exchangeAuthorizationCode(
        config,
        { code: 'c', redirectUri: 'http://127.0.0.1:17830/callback' },
        { fetchImpl: malformed.fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'server_error' });
  });

  it('codeFromResumeUrl：取 code，非法 URL 返回 null', () => {
    expect(codeFromResumeUrl('http://127.0.0.1:17830/callback?code=c1&state=s1')).toBe('c1');
    expect(codeFromResumeUrl('not-a-url')).toBeNull();
    expect(codeFromResumeUrl('http://127.0.0.1:17830/callback')).toBeNull();
  });
});
