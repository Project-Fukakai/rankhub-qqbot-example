/**
 * 单测：v1 profile `assets`（头像 / 背景板 / 曲绘 / 立绘）。
 *
 * 契约：`RankHubWorkspace/docs/V1-PROFILE-ASSETS.md` §2。
 * 覆盖：
 * - `listProfiles` 映射三字段（假服务夹具，URL 由假服务 origin 解析）；
 * - 老实例（响应里没有 `assets`）⇒ 三字段全 null，不抛错；
 * - `assets` 为 null / 字段类型不对 ⇒ 对应字段 null；
 * - `/v1/me/profile` 的 `games[]` 解析 `characterArtworkUrl`（含老实例缺字段）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RankHubClientExtended } from '../../../src/rankhub/index.js';
import { toProfileAssets } from '../../../src/rankhub/wire.js';
import type { SqliteBindingStore } from '../../../src/store/index.js';
import { FakeRankHub } from '../../fakes/rankhub/index.js';

import {
  createTempDir,
  makeClient,
  makeStore,
  obtainAccessToken,
  removeTempDir,
} from './helpers.js';

const NO_ASSETS = {
  avatarUrl: null,
  backgroundUrl: null,
  characterArtworkUrl: null,
};

describe('v1 profile assets 客户端映射', () => {
  let fake: FakeRankHub;
  let store: SqliteBindingStore;
  let client: RankHubClientExtended;
  let dir: string;
  let accessToken: string;
  /** 本次用例是否启动了假服务（纯函数用例不启动）。 */
  let started = false;

  beforeEach(() => {
    dir = createTempDir();
    started = false;
  });

  afterEach(async () => {
    if (started) {
      store.close();
      await fake.close();
      started = false;
    }
    removeTempDir(dir);
  });

  async function start(options: Parameters<typeof FakeRankHub.start>[0] = {}): Promise<void> {
    fake = await FakeRankHub.start(options);
    store = makeStore(dir);
    client = makeClient(fake, store);
    accessToken = await obtainAccessToken(fake, client);
    started = true;
  }

  it('listProfiles 映射 assets 三字段（绝对 URL 指向假服务）', async () => {
    await start();

    const maimai = (await client.listProfiles(accessToken, 'maimai'))[0]!;
    expect(maimai.assets).toEqual({
      avatarUrl: `${fake.origin}/fake/image.png?game=maimai&asset=avatar`,
      backgroundUrl: `${fake.origin}/fake/image.png?game=maimai&asset=frame`,
      characterArtworkUrl: null,
    });

    const arcaea = (await client.listProfiles(accessToken, 'arcaea'))[0]!;
    expect(arcaea.assets.characterArtworkUrl).toBe(
      `${fake.origin}/fake/image.png?game=arcaea&asset=artwork`,
    );

    const phigros = (await client.listProfiles(accessToken, 'phigros'))[0]!;
    expect(phigros.assets.backgroundUrl).toBe(
      `${fake.origin}/fake/image.png?game=phigros&asset=background`,
    );
  });

  it('老实例没有 assets ⇒ 三字段全 null（不抛错）', async () => {
    await start({ includeAssets: false });

    for (const game of ['maimai', 'phigros', 'arcaea']) {
      const [profile] = await client.listProfiles(accessToken, game);
      expect(profile?.assets).toEqual(NO_ASSETS);
    }
  });

  it('assets 为 null / 字段类型不对 ⇒ 对应字段 null', async () => {
    await start({
      profiles: {
        maimai: [
          {
            profileId: 'profile-mai-1',
            game: 'maimai',
            player: { name: 'Fake Player', rating: 15000, native: null },
            isPublic: true,
            origin: 'user',
            syncCapable: true,
            lastSyncedAt: null,
            updatedAt: '2026-10-01T00:00:00Z',
            // 字段级脏数据：数字 / 空串 / 缺键
            assets: { avatarUrl: 123, backgroundUrl: '', characterArtworkUrl: null },
          },
        ],
        // assets: null（后端显式给 null）
        phigros: [
          {
            profileId: 'profile-phi-1',
            game: 'phigros',
            player: { name: 'Fake Player', rating: 15.2, native: null },
            isPublic: false,
            origin: 'app',
            syncCapable: false,
            lastSyncedAt: null,
            updatedAt: '2026-10-02T00:00:00Z',
            assets: null,
          },
        ],
        arcaea: [
          {
            profileId: 'profile-arc-1',
            game: 'arcaea',
            player: { name: 'Fake Arc Player', rating: 12.34, native: null },
            isPublic: true,
            origin: 'user',
            syncCapable: true,
            lastSyncedAt: null,
            updatedAt: '2026-10-01T00:00:00Z',
            // 完全没有 assets 键
          },
        ],
      },
    });

    expect((await client.listProfiles(accessToken, 'maimai'))[0]?.assets).toEqual(NO_ASSETS);
    expect((await client.listProfiles(accessToken, 'phigros'))[0]?.assets).toEqual(NO_ASSETS);
    expect((await client.listProfiles(accessToken, 'arcaea'))[0]?.assets).toEqual(NO_ASSETS);
  });

  it('getMeProfile 解析 games[].characterArtworkUrl（maimai backgroundUrl 是 frame）', async () => {
    await start();

    const me = await client.getMeProfile(accessToken);
    const maimai = me.games.find((game) => game.game === 'maimai');
    expect(maimai?.backgroundUrl).toBe(`${fake.origin}/fake/image.png?game=maimai&asset=frame`);
    expect(maimai?.characterArtworkUrl).toBeNull();

    const arcaea = me.games.find((game) => game.game === 'arcaea');
    expect(arcaea?.characterArtworkUrl).toBe(
      `${fake.origin}/fake/image.png?game=arcaea&asset=artwork`,
    );
  });

  it('老实例的 /v1/me/profile games[] 缺 characterArtworkUrl ⇒ null', async () => {
    await start({ includeAssets: false });

    const me = await client.getMeProfile(accessToken);
    expect(me.games).toHaveLength(3);
    for (const game of me.games) {
      expect(game.avatarUrl).toBeNull();
      expect(game.backgroundUrl).toBeNull();
      expect(game.characterArtworkUrl).toBeNull();
    }
  });

  it('toProfileAssets 对缺失/非法输入一律全 null（不抛错）', () => {
    expect(toProfileAssets(undefined)).toEqual(NO_ASSETS);
    expect(toProfileAssets(null)).toEqual(NO_ASSETS);
    expect(toProfileAssets('oops')).toEqual(NO_ASSETS);
    expect(toProfileAssets({ avatarUrl: 'https://cdn.test/a.png' })).toEqual({
      avatarUrl: 'https://cdn.test/a.png',
      backgroundUrl: null,
      characterArtworkUrl: null,
    });
    expect(
      toProfileAssets({ avatarUrl: 1, backgroundUrl: {}, characterArtworkUrl: [] }),
    ).toEqual(NO_ASSETS);
  });
});
