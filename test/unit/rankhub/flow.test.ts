import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RankHubClientExtended } from '../../../src/rankhub/index.js';
import type { SqliteBindingStore } from '../../../src/store/index.js';
import { FakeRankHub } from '../../fakes/rankhub/index.js';

import {
  createTempDir,
  makeClient,
  makeStore,
  removeTempDir,
  saveBinding,
} from './helpers.js';

describe('假服务端 E2E：device → token → store → games → refresh → revoke', () => {
  let fake: FakeRankHub;
  let store: SqliteBindingStore;
  let client: RankHubClientExtended;
  let dir: string;

  beforeEach(async () => {
    dir = createTempDir();
    fake = await FakeRankHub.start({ pendingPollsBeforeApproval: 1 });
    store = makeStore(dir);
    client = makeClient(fake, store);
  });

  afterEach(async () => {
    store.close();
    await fake.close();
    removeTempDir(dir);
  });

  it('只打假服务器走完整条链，不需要任何真实 RankHub 凭据', async () => {
    // 1) 设备码：申请 → 第一次 pending → 第二次批准
    const authorization = await client.deviceStart('openid profile offline_access game:read');
    expect(await client.devicePoll(authorization.deviceCode)).toEqual({ status: 'pending' });
    const polled = await client.devicePoll(authorization.deviceCode);
    expect(polled.status).toBe('ok');
    if (polled.status !== 'ok') throw new Error('unreachable');
    const tokens = polled.tokens;

    // 2) userinfo
    const identity = await client.userinfo(tokens.accessToken);
    expect(identity).toEqual({
      subject: 'user-fake-sub',
      name: 'Fake User',
      picture: 'https://example.test/avatar.png',
    });

    // 3) 落库（加密）
    const binding = await saveBinding(store, tokens);
    expect(binding.status).toBe('active');
    expect(store.decryptRefreshToken(binding)).toBe(tokens.refreshToken);

    // 4) games API
    const games = await client.listGames(tokens.accessToken);
    expect(games.map((item) => item.game)).toEqual(['maimai', 'phigros']);

    const profiles = await client.listProfiles(tokens.accessToken, 'maimai');
    expect(profiles[0]?.profileId).toBe('profile-mai-1');

    const bests = await client.getBests(tokens.accessToken, 'maimai', 'profile-mai-1');
    expect(bests.totals.total).toBe(15000);
    expect(bests.buckets[0]?.items.length).toBeGreaterThan(0);

    const page = await client.listScores(tokens.accessToken, 'maimai', 'profile-mai-1', {
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);

    // 5) 刷新：新 rt 落库，authorize 直接用新 access token
    const refreshed = await client.refresh(binding);
    const stored = await store.getById(binding.id);
    if (stored === null) throw new Error('unreachable');
    expect(store.decryptRefreshToken(stored)).toBe(refreshed.refreshToken);

    const authorized = await client.authorize(stored);
    expect(authorized).toBe(refreshed.accessToken);
    expect((await client.listGames(authorized)).length).toBe(2);

    // 6) 撤销后 access token 立刻失效
    await client.revoke(refreshed.refreshToken);
    await expect(client.listGames(refreshed.accessToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    // 7) 解绑
    await store.deleteByQqUser(binding.qqUserOpenid);
    expect(await store.getByQqUser(binding.qqUserOpenid)).toBeNull();
  });
});
