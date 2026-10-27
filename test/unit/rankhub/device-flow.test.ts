import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRankHubClient, type RankHubClientExtended } from '../../../src/rankhub/index.js';
import type { SqliteBindingStore } from '../../../src/store/index.js';
import { FakeRankHub } from '../../fakes/rankhub/index.js';

import {
  createTempDir,
  makeClient,
  makeStore,
  removeTempDir,
  TEST_ENC_KEY,
} from './helpers.js';

describe('设备码授权（RFC 8628 轮询状态机）', () => {
  let fake: FakeRankHub;
  let store: SqliteBindingStore;
  let client: RankHubClientExtended;
  let dir: string;

  beforeEach(async () => {
    dir = createTempDir();
    fake = await FakeRankHub.start();
    store = makeStore(dir);
    client = makeClient(fake, store);
  });

  afterEach(async () => {
    store.close();
    await fake.close();
    removeTempDir(dir);
  });

  it('deviceStart 返回六键，verification_uri_complete 预填 user_code', async () => {
    const authorization = await client.deviceStart('openid profile offline_access game:read');

    expect(authorization.deviceCode.startsWith('dc_')).toBe(true);
    expect(authorization.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(authorization.verificationUri).toBe(`${fake.authBase}/oauth/device`);
    expect(authorization.verificationUriComplete).toContain(
      `user_code=${encodeURIComponent(authorization.userCode)}`,
    );
    expect(authorization.expiresIn).toBe(600);
    expect(authorization.interval).toBe(5);

    const request = fake.state.requests.at(-1);
    expect(request?.path).toBe('/v1/oauth/device_authorization');
    expect(request?.form).toMatchObject({
      client_id: fake.state.clientId,
      scope: 'openid profile offline_access game:read',
    });
  });

  it('authorization_pending 是 HTTP 200 + body.error：客户端必须显式判定而不是当成功', async () => {
    fake.state.pendingPollsBeforeApproval = 2;
    const authorization = await client.deviceStart('openid profile');

    expect(await client.devicePoll(authorization.deviceCode)).toEqual({ status: 'pending' });
    expect(await client.devicePoll(authorization.deviceCode)).toEqual({ status: 'pending' });
    const result = await client.devicePoll(authorization.deviceCode);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.tokens.accessToken.startsWith('at_')).toBe(true);
    expect(result.tokens.refreshToken.startsWith('rt_')).toBe(true);
    expect(result.tokens.expiresIn).toBe(3600);
    expect(result.tokens.scope).toContain('offline_access');
    // 三次轮询 = 三次 POST /v1/oauth/token
    expect(fake.state.tokenRequests).toBe(3);
  });

  it('slow_down 也是 200 + body.error：间隔按 RFC +5 秒', async () => {
    const authorization = await client.deviceStart('openid profile');
    fake.state.devices.get(authorization.deviceCode)!.slowDownPolls = 1;

    const slowed = await client.devicePoll(authorization.deviceCode);
    expect(slowed).toEqual({ status: 'slow_down', interval: 10 });

    const result = await client.devicePoll(authorization.deviceCode);
    expect(result.status).toBe('ok');
  });

  it('access_denied（400）返回 denied', async () => {
    const authorization = await client.deviceStart('openid profile');
    fake.setDeviceStatus(authorization.deviceCode, 'denied');

    expect(await client.devicePoll(authorization.deviceCode)).toEqual({ status: 'denied' });
  });

  it('expired_token（400）返回 expired', async () => {
    const authorization = await client.deviceStart('openid profile');
    fake.setDeviceStatus(authorization.deviceCode, 'expired');

    expect(await client.devicePoll(authorization.deviceCode)).toEqual({ status: 'expired' });
  });

  it('未知 device_code 映射成 invalid_argument', async () => {
    await expect(client.devicePoll('dc_does_not_exist')).rejects.toMatchObject({
      name: 'RankHubError',
      code: 'invalid_argument',
      status: 400,
    });
  });

  it('设备码申请被服务端拒绝（client 不匹配）时映射 unauthorized', async () => {
    const mismatched = createRankHubClient(
      {
        RANKHUB_CLIENT_ID: 'other-client',
        RANKHUB_CLIENT_SECRET: fake.state.clientSecret,
        RANKHUB_AUTH_BASE: fake.authBase,
        RANKHUB_API_BASE: fake.apiBase,
        RANKHUB_SCOPES: 'openid',
        TOKEN_ENC_KEY: TEST_ENC_KEY,
      },
      { store },
    );
    await expect(mismatched.deviceStart('openid')).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });
});
