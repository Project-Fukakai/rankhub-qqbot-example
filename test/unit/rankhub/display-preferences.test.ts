/**
 * 单测：`/v1/me/display-preferences` 与 `/v1/games/phigros/profiles/{id}/statistics` 客户端。
 *
 * 纪律：
 * - 只打假 RankHub（127.0.0.1），不碰真实服务；
 * - envelope 一律 `{code,message,data,requestId}`，fixture 与后端契约 §2 同形；
 * - 缺失 / 非法字段的降级口径单独覆盖（展示不该因可选偏好崩）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RankHubError } from '../../../src/contracts/index.js';
import type { RankHubClientExtended } from '../../../src/rankhub/index.js';
import {
  toDisplayPreferences,
  toPhigrosStatistics,
} from '../../../src/rankhub/wire.js';
import type { SqliteBindingStore } from '../../../src/store/index.js';
import { FakeRankHub } from '../../fakes/rankhub/index.js';

import {
  createTempDir,
  lastRequest,
  makeClient,
  makeStore,
  obtainAccessToken,
  removeTempDir,
  requestsTo,
} from './helpers.js';

const PREFERENCES_PATH = '/v1/me/display-preferences';
const STATISTICS_PATH = '/v1/games/phigros/profiles/profile-phi-1/statistics';

describe('RankHub 用户显示偏好 / phigros 统计', () => {
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

  it('getDisplayPreferences 解析 v1 envelope 的 data（默认 IN）', async () => {
    const preferences = await client.getDisplayPreferences(accessToken);

    expect(preferences).toEqual({ phigrosDifficulty: 'IN' });
    const request = lastRequest(fake, PREFERENCES_PATH);
    expect(request.method).toBe('GET');
    expect(request.hasAuthorization).toBe(true);
  });

  it('updateDisplayPreferences PATCH json body 并返回服务端归一后的值', async () => {
    const updated = await client.updateDisplayPreferences(accessToken, {
      phigrosDifficulty: 'AT',
    });

    expect(updated).toEqual({ phigrosDifficulty: 'AT' });
    const request = lastRequest(fake, PREFERENCES_PATH);
    expect(request.method).toBe('PATCH');
    expect(request.json).toEqual({ phigrosDifficulty: 'AT' });
    // 写回后 GET 读到同一个值（同一份用户偏好，不是各存一份）。
    expect(await client.getDisplayPreferences(accessToken)).toEqual({
      phigrosDifficulty: 'AT',
    });
    // PATCH 一次 + 回读 GET 一次。
    expect(requestsTo(fake, PREFERENCES_PATH)).toHaveLength(2);
  });

  it('updateDisplayPreferences 归一难度后再发（大小写 / 空格不敏感）', async () => {
    const updated = await client.updateDisplayPreferences(accessToken, {
      // 故意绕过类型：模拟调用方传入未归一的值。
      phigrosDifficulty: ' at ' as unknown as 'AT',
    });

    expect(updated).toEqual({ phigrosDifficulty: 'AT' });
    expect(lastRequest(fake, PREFERENCES_PATH).json).toEqual({ phigrosDifficulty: 'AT' });
  });

  it('updateDisplayPreferences 对非法难度本地拒绝（不发请求）', async () => {
    await expect(
      client.updateDisplayPreferences(accessToken, {
        // 故意绕过类型：模拟调用方传入脏值。
        phigrosDifficulty: 'XX' as unknown as 'IN',
      }),
    ).rejects.toBeInstanceOf(RankHubError);
    expect(requestsTo(fake, PREFERENCES_PATH)).toHaveLength(0);
  });

  it('toDisplayPreferences 对缺失/非法值回退默认 IN（不抛错）', () => {
    expect(toDisplayPreferences(undefined)).toEqual({ phigrosDifficulty: 'IN' });
    expect(toDisplayPreferences({})).toEqual({ phigrosDifficulty: 'IN' });
    expect(toDisplayPreferences({ phigrosDifficulty: 'xyz' })).toEqual({
      phigrosDifficulty: 'IN',
    });
    // 大小写 / 空格不敏感（后端回 `in` 也能用）。
    expect(toDisplayPreferences({ phigrosDifficulty: ' in ' })).toEqual({
      phigrosDifficulty: 'IN',
    });
  });

  it('getPhigrosStatistics 归一 data.statistics（camelCase + 四难度齐全）', async () => {
    const statistics = await client.getPhigrosStatistics(accessToken, 'profile-phi-1');

    expect(statistics.challengeModeRank).toBe(316);
    expect(statistics.officialRks).toBe(15.2);
    expect(statistics.calculatedRks).toBe(15);
    expect(statistics.levels.IN).toEqual({ played: 30, clear: 25, fc: 15, phi: 5 });
    expect(statistics.levels.AT).toEqual({ played: 5, clear: 3, fc: 1, phi: 0 });
    expect(statistics.ratings).toEqual({ ϕ: 3, S: 12 });
    expect(statistics.lastSyncedAt).toBeNull();
    expect(lastRequest(fake, STATISTICS_PATH).hasAuthorization).toBe(true);
  });

  it('getPhigrosStatistics 对不存在的档案抛 not_found', async () => {
    await expect(client.getPhigrosStatistics(accessToken, 'profile-missing')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('toPhigrosStatistics 缺少 data.statistics ⇒ server_error', () => {
    expect(() => toPhigrosStatistics({ game: 'phigros' })).toThrowError(RankHubError);
    expect(() => toPhigrosStatistics(null)).toThrowError(RankHubError);
    try {
      toPhigrosStatistics({ game: 'phigros' });
    } catch (error) {
      expect((error as RankHubError).code).toBe('server_error');
    }
  });

  it('toPhigrosStatistics 兼容 snake_case、缺失难度块按 0、非数字忽略', () => {
    const statistics = toPhigrosStatistics({
      game: 'phigros',
      statistics: {
        official_rks: 15.1,
        challenge_mode_rank: 205,
        ratings: { ϕ: 'oops', S: 4 },
        levels: { EZ: { played: 1, clear: 1 } },
        lastSyncedAt: '2026-10-01T00:00:00Z',
      },
    });

    expect(statistics.officialRks).toBe(15.1);
    expect(statistics.challengeModeRank).toBe(205);
    expect(statistics.levels.EZ).toEqual({ played: 1, clear: 1, fc: 0, phi: 0 });
    expect(statistics.levels.IN).toEqual({ played: 0, clear: 0, fc: 0, phi: 0 });
    expect(statistics.ratings).toEqual({ S: 4 });
    expect(statistics.lastSyncedAt).toBe('2026-10-01T00:00:00Z');
  });

  it('getMeProfile 带回 displayPreferences（新字段；缺失时的默认值由 wire 层单测覆盖）', async () => {
    const me = await client.getMeProfile(accessToken);
    expect(me.displayPreferences).toEqual({ phigrosDifficulty: 'IN' });
    expect(me.uid).toBe('100234567');
  });
});
