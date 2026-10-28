import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UNKNOWN_SUBJECT, type RankHubClientExtended } from '../../../src/rankhub/index.js';
import type { SqliteBindingStore } from '../../../src/store/index.js';
import { FakeRankHub } from '../../fakes/rankhub/index.js';

import {
  createTempDir,
  lastRequest,
  makeClient,
  makeStore,
  obtainAccessToken,
  obtainTokens,
  removeTempDir,
  requestsTo,
} from './helpers.js';

const GAMES_PATH = '/v1/games';
const MAIMAI_PROFILES_PATH = '/v1/games/maimai/profiles';
const PHI_SCORES_PATH = '/v1/games/phigros/profiles/profile-phi-1/scores';

describe('RankHub /v1/games 客户端', () => {
  let fake: FakeRankHub;
  let store: SqliteBindingStore;
  let client: RankHubClientExtended;
  let dir: string;
  let accessToken: string;

  beforeEach(async () => {
    dir = createTempDir();
    fake = await FakeRankHub.start();
    store = makeStore(dir);
    client = makeClient(fake, store);
    accessToken = await obtainAccessToken(fake, client);
  });

  afterEach(async () => {
    store.close();
    await fake.close();
    removeTempDir(dir);
  });

  it('listGames 解析 v1 envelope 并映射能力矩阵', async () => {
    const games = await client.listGames(accessToken);
    expect(games).toEqual([
      {
        game: 'maimai',
        read: true,
        pushProfile: true,
        pushScores: true,
        deletionRequest: true,
      },
      {
        game: 'phigros',
        read: true,
        pushProfile: true,
        pushScores: true,
        deletionRequest: true,
      },
    ]);
    expect(lastRequest(fake, GAMES_PATH).hasAuthorization).toBe(true);
  });

  it('listProfiles 映射档案；忽略未知字段，null 保持 null', async () => {
    const profiles = await client.listProfiles(accessToken, 'maimai');
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      profileId: 'profile-mai-1',
      game: 'maimai',
      player: { name: 'Fake Player', rating: 15000, native: { course_rank: 10 } },
      isPublic: true,
      origin: 'user',
      syncCapable: true,
      lastSyncedAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    });
    expect(lastRequest(fake, MAIMAI_PROFILES_PATH).query.limit).toBe('100');

    const phi = await client.listProfiles(accessToken, 'phigros');
    expect(phi[0]).toMatchObject({
      origin: 'app',
      isPublic: false,
      syncCapable: false,
      // `lastSyncedAt` 缺失保持 null（不编造时间）。
      lastSyncedAt: null,
      // v1 adapter 的真实 native 形状（camelCase 展示字段；测试夹具见 fakes/rankhub/server.ts）。
      player: { native: { challengeModeRank: 316, gameVersion: '3.7.0' } },
    });
  });

  it('getBests 映射 totals / buckets / 成绩字段', async () => {
    const bests = await client.getBests(accessToken, 'maimai', 'profile-mai-1');

    expect(bests.game).toBe('maimai');
    expect(bests.computedAt).toBe('2026-10-20T00:00:00Z');
    expect(bests.totals).toEqual({ total: 15000, latest: 12000 });
    expect(bests.buckets).toHaveLength(2);
    expect(bests.buckets[0]).toMatchObject({ key: 'latest', label: '当期', total: 12000 });
    expect(bests.buckets[1]).toMatchObject({ key: 'archive', label: '往期', total: null, items: [] });

    const score = bests.buckets[0]?.items[0];
    expect(score).toMatchObject({
      scoreId: 'score-1',
      songId: '10001',
      songName: 'Fake Song',
      type: 'dx',
      difficulty: '3',
      levelIndex: 3,
      level: '13+',
      achievements: 100.5,
      score: null,
      rating: 320,
      rank: 'sss',
      dxScore: 1234,
      dxStar: 5,
      fc: 'ap',
      fs: 'fsd',
      playTime: '2026-10-01T12:00:00Z',
      native: { note: '原生字段' },
    });
    // 未知字段不进契约对象
    expect(score === undefined ? null : Object.keys(score)).not.toContain('unknownFutureField');
  });

  it('listScores 透传 limit/cursor/sortBy/order/difficulty，并原样带回 nextCursor', async () => {
    fake.state.scoresPages = {
      '': {
        items: [
          { scoreId: 'score-a', songId: 's1' },
          { scoreId: 'score-b', songId: 's2' },
        ],
        nextCursor: 'cursor-2',
        hasMore: true,
      },
      'cursor-2': {
        items: [{ scoreId: 'score-c', songId: 's3' }],
        nextCursor: null,
        hasMore: false,
      },
    };

    const page1 = await client.listScores(accessToken, 'phigros', 'profile-phi-1', {
      limit: 2,
      sortBy: 'rating',
      order: 'asc',
      difficulty: 'IN',
    });
    expect(page1.items.map((item) => item.scoreId)).toEqual(['score-a', 'score-b']);
    expect(page1.nextCursor).toBe('cursor-2');
    expect(page1.hasMore).toBe(true);

    const firstRequest = lastRequest(fake, PHI_SCORES_PATH);
    expect(firstRequest.query).toEqual({
      limit: '2',
      sortBy: 'rating',
      order: 'asc',
      difficulty: 'IN',
    });

    const page2 = await client.listScores(accessToken, 'phigros', 'profile-phi-1', {
      limit: 2,
      cursor: page1.nextCursor ?? '',
    });
    expect(page2.items.map((item) => item.scoreId)).toEqual(['score-c']);
    expect(page2.nextCursor).toBeNull();
    expect(page2.hasMore).toBe(false);
    expect(lastRequest(fake, PHI_SCORES_PATH).query.cursor).toBe('cursor-2');
  });

  it('limit 超过 100 会被夹到 100（服务端上限）', async () => {
    fake.state.scoresPages = { '': { items: [], nextCursor: null, hasMore: false } };
    await client.listScores(accessToken, 'phigros', 'profile-phi-1', { limit: 500 });
    expect(lastRequest(fake, PHI_SCORES_PATH).query.limit).toBe('100');
  });

  it('401 → unauthorized', async () => {
    await expect(client.listGames('at_bogus')).rejects.toMatchObject({
      name: 'RankHubError',
      code: 'unauthorized',
      status: 401,
    });
  });

  it('403 + game.firstPartyOnly → first_party_only', async () => {
    fake.state.firstPartyOnly.add('maimai');
    await expect(client.listProfiles(accessToken, 'maimai')).rejects.toMatchObject({
      code: 'first_party_only',
      status: 403,
    });
  });

  it('404 → not_found', async () => {
    // 用一个 fake 里没有档案的游戏验证 404（arcaea 现在有默认档案，不能再当 404 样本）。
    await expect(client.listProfiles(accessToken, 'chunithm')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('400 → invalid_argument', async () => {
    fake.state.gameErrors.set('phigros', { status: 400, code: 'common.invalidArgument' });
    await expect(
      client.listScores(accessToken, 'phigros', 'profile-phi-1'),
    ).rejects.toMatchObject({ code: 'invalid_argument', status: 400 });
  });

  it('5xx → server_error', async () => {
    fake.state.gameErrors.set('phigros', { status: 503, code: 'common.serviceUnavailable' });
    await expect(client.getBests(accessToken, 'phigros', 'profile-phi-1')).rejects.toMatchObject({
      code: 'server_error',
      status: 503,
    });
  });

  it('429 → 按 Retry-After 退避重试一次后成功', async () => {
    const sleeps: number[] = [];
    const retryingClient = makeClient(fake, store, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    fake.state.rateLimit = { remaining: 1, retryAfterSeconds: 1 };

    const profiles = await retryingClient.listProfiles(accessToken, 'maimai');
    expect(profiles).toHaveLength(1);
    expect(sleeps).toEqual([1000]);
    expect(requestsTo(fake, MAIMAI_PROFILES_PATH)).toHaveLength(2);
  });

  it('429 连续两次 → rate_limited（带 retryAfterSeconds，不再重试）', async () => {
    const sleeps: number[] = [];
    const retryingClient = makeClient(fake, store, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    fake.state.rateLimit = { remaining: 2, retryAfterSeconds: 1 };

    await expect(retryingClient.listProfiles(accessToken, 'maimai')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterSeconds: 1,
    });
    expect(sleeps).toEqual([1000]);
    expect(requestsTo(fake, MAIMAI_PROFILES_PATH)).toHaveLength(2);
  });

  it('fetch 失败 → network_error（status=0）', async () => {
    const dead = await FakeRankHub.start();
    const deadClient = makeClient(dead, store);
    await dead.close();

    await expect(deadClient.listGames('at_whatever')).rejects.toMatchObject({
      code: 'network_error',
      status: 0,
    });
  });

  it('userinfo 失败不阻断：返回 subject 未知 + name null', async () => {
    const tokens = await obtainTokens(fake, client);
    // 先撤销 access token，让 userinfo 401。
    await client.revoke(tokens.accessToken);

    const identity = await client.userinfo(tokens.accessToken);
    expect(identity).toEqual({ subject: UNKNOWN_SUBJECT, name: null, picture: null });
  });

  it('revoke 幂等（未知 token 也 200）；撤销后 access token 失效', async () => {
    const tokens = await obtainTokens(fake, client);
    await client.revoke(tokens.accessToken);
    await client.revoke(tokens.accessToken);
    await client.revoke('not-a-real-token');

    await expect(client.listGames(tokens.accessToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});
