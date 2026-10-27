import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Binding, BindingStore, RankHubTokens } from '../../../src/contracts/index.js';
import type { RankHubClientExtended } from '../../../src/rankhub/index.js';
import type { SqliteBindingStore } from '../../../src/store/index.js';
import { FakeRankHub } from '../../fakes/rankhub/index.js';

import {
  createTempDir,
  makeClient,
  makeStore,
  obtainTokens,
  removeTempDir,
  saveBinding,
} from './helpers.js';

describe('令牌刷新（single-flight / 先落库 / 重放）', () => {
  let fake: FakeRankHub;
  let store: SqliteBindingStore;
  let client: RankHubClientExtended;
  let dir: string;
  let tokens: RankHubTokens;
  let binding: Binding;

  beforeEach(async () => {
    dir = createTempDir();
    fake = await FakeRankHub.start();
    store = makeStore(dir);
    client = makeClient(fake, store);
    tokens = await obtainTokens(fake, client);
    binding = await saveBinding(store, tokens);
  });

  afterEach(async () => {
    store.close();
    await fake.close();
    removeTempDir(dir);
  });

  it('同一 binding 并发刷新只发一次请求，且结果一致', async () => {
    const results = await Promise.all([
      client.refresh(binding),
      client.refresh(binding),
      client.refresh(binding),
      client.refresh(binding),
    ]);

    expect(fake.state.refreshRequests).toBe(1);
    const accessTokens = new Set(results.map((item) => item.accessToken));
    expect(accessTokens.size).toBe(1);
    expect(results[0]?.accessToken.startsWith('at_')).toBe(true);
    expect(results[0]?.refreshToken).not.toBe(tokens.refreshToken);
    expect(results[0]?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('新 refresh token 先落库、再返回（返回后库里已能解密出新 rt）', async () => {
    let updateFinished = false;
    let updateCalls = 0;
    const delayedStore: BindingStore = {
      getByQqUser: (openid) => store.getByQqUser(openid),
      upsert: (input) => store.upsert(input),
      updateTokens: async (id, input) => {
        updateCalls += 1;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        await store.updateTokens(id, input);
        updateFinished = true;
      },
      markRevoked: (id) => store.markRevoked(id),
      deleteByQqUser: (openid) => store.deleteByQqUser(openid),
    };
    const delayedClient = makeClient(fake, delayedStore);

    const refreshed = await delayedClient.refresh(binding);
    expect(updateCalls).toBe(1);
    expect(updateFinished).toBe(true);

    const stored = await store.getById(binding.id);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error('unreachable');
    expect(store.decryptRefreshToken(stored)).toBe(refreshed.refreshToken);
    expect(store.decryptAccessToken(stored)).toBe(refreshed.accessToken);
    expect(stored.accessExpiresAt).toBe(refreshed.expiresAt);
  });

  it('落库失败时刷新抛出，不返回「看似成功」的令牌', async () => {
    const failingStore: BindingStore = {
      getByQqUser: (openid) => store.getByQqUser(openid),
      upsert: (input) => store.upsert(input),
      updateTokens: async () => {
        throw new Error('磁盘写入失败（测试注入）');
      },
      markRevoked: (id) => store.markRevoked(id),
      deleteByQqUser: (openid) => store.deleteByQqUser(openid),
    };
    const failingClient = makeClient(fake, failingStore);

    await expect(failingClient.refresh(binding)).rejects.toThrow('磁盘写入失败');
    expect(fake.state.refreshRequests).toBe(1);
  });

  it('旧 refresh token 重放：401 invalid_grant + 标记 binding revoked', async () => {
    const refreshed = await client.refresh(binding);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);

    // 拿刷新前那份 binding（仍是旧 rt 密文）再刷一次 —— 等价于旧 rt 重放。
    const replayError = await client.refresh(binding).then(
      () => null,
      (error: unknown) => error,
    );
    expect(replayError).toMatchObject({
      name: 'RankHubError',
      code: 'invalid_grant',
      status: 401,
    });
    expect(String(replayError)).not.toContain(tokens.refreshToken);
    expect(fake.state.refreshRequests).toBe(2);

    const stored = await store.getById(binding.id);
    expect(stored?.status).toBe('revoked');
  });

  it('已 revoked 的 binding 不再发刷新请求', async () => {
    await store.markRevoked(binding.id);
    const revoked = await store.getById(binding.id);
    if (revoked === null) throw new Error('unreachable');

    await expect(client.refresh(revoked)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fake.state.refreshRequests).toBe(0);
  });

  it('用库里的新 rt 顺序刷新可以继续成功（轮换链路）', async () => {
    const first = await client.refresh(binding);
    const stored = await store.getById(binding.id);
    if (stored === null) throw new Error('unreachable');

    const second = await client.refresh(stored);
    expect(fake.state.refreshRequests).toBe(2);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  it('authorize：access token 未过期不刷新；过期才刷新；revoked 直接 unauthorized', async () => {
    const freshToken = await client.authorize(binding);
    expect(freshToken).toBe(tokens.accessToken);
    expect(fake.state.refreshRequests).toBe(0);

    const expired = await store.upsert({
      qqUserOpenid: binding.qqUserOpenid,
      unionOpenid: null,
      rankhubSubject: binding.rankhubSubject,
      rankhubName: binding.rankhubName,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessExpiresAt: Date.now() - 1_000,
      scopes: binding.scopes,
    });
    const authorized = await client.authorize(expired);
    expect(fake.state.refreshRequests).toBe(1);
    expect(authorized.startsWith('at_')).toBe(true);
    expect(authorized).not.toBe(tokens.accessToken);

    const current = await store.getById(binding.id);
    if (current === null) throw new Error('unreachable');
    await store.markRevoked(current.id);
    const revoked = await store.getById(binding.id);
    if (revoked === null) throw new Error('unreachable');
    expect(revoked.status).toBe('revoked');
    await expect(client.authorize(revoked)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});
