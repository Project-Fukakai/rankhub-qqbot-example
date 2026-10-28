/**
 * 单测：`/me` 名片数据装配 + `/me diff` 指令。
 *
 * 覆盖 task-3 验收点：
 * - `resolveMeArgs` 参数解析（`diff` / 难度大小写 / 非法参数）；
 * - 三款游戏卡片按冻结契约映射（maimai B35/B15、phigros B30 平均与难度达成、arcaea PTT/B50/B10）；
 * - `/me diff` 读当前难度、`/me diff <难度>` 写回回执、写回失败的明确错误文案；
 * - 单游戏失败只跳过该卡；全失败 + 无账号资料回文字摘要；
 * - v1 `assets`：头像/背景板(frame)/曲绘/立绘进渲染入参；老实例（无 assets）不带图。
 *
 * 假 RankHub 用内存对象；素材由测试内起的本机 HTTP 图片服务提供（不联网）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CommandRuntime } from '../../../src/commands/runtime.js';
import type {
  CommandContext,
  CommandServices,
  Reply,
} from '../../../src/commands/common.js';
import {
  achievementsFor,
  computeB30Average,
  meCommand,
  resolveMeArgs,
  ME_DIFF_USAGE_TEXT,
} from '../../../src/commands/me.js';
import type { AppConfig } from '../../../src/config/index.js';
import {
  RankHubError,
  type Binding,
  type DisplayPreferences,
  type GameBests,
  type GameCapability,
  type GameProfile,
  type GameProfileAssets,
  type PlayerCardRenderInput,
  type QQMessageEvent,
  type Renderer,
} from '../../../src/contracts/index.js';
import { silentLogger } from '../../../src/logger/index.js';
import type {
  MeProfile,
  PhigrosStatistics,
  RankHubClientExtended,
} from '../../../src/rankhub/index.js';
import { createBindingStore, type SqliteBindingStore } from '../../../src/store/index.js';

const TOKEN_KEY = Buffer.alloc(32, 0x2a).toString('base64');

// ────────────────────────────────── 夹具 ──────────────────────────────────

/** 空 assets（老实例形状：没有头像/背景/立绘）。 */
const NO_ASSETS: GameProfileAssets = {
  avatarUrl: null,
  backgroundUrl: null,
  characterArtworkUrl: null,
};

/** 1x1 透明 PNG（`fetchImage` 只接受 `image/*`）。 */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
  'base64',
);

interface ImageServer {
  /** 本机 origin（拼素材绝对 URL 用）。 */
  readonly base: string;
  /** 收到的请求路径（断言「被 fetch 过」）。 */
  readonly requests: string[];
  close(): Promise<void>;
}

/** 本机图片服务：验证素材下载路径，不发任何外网请求。 */
async function startImageServer(): Promise<ImageServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': ONE_PX_PNG.length,
    });
    res.end(ONE_PX_PNG);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function profile(
  overrides: Partial<GameProfile> & { game: string; profileId: string },
): GameProfile {
  return {
    player: { name: 'Fake Player', rating: null, native: null },
    isPublic: true,
    origin: 'user',
    syncCapable: true,
    lastSyncedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    assets: NO_ASSETS,
    ...overrides,
  };
}

const MAIMAI_PROFILE = profile({
  game: 'maimai',
  profileId: 'profile-mai-1',
  player: { name: 'Mai Player', rating: 15000, native: { course_rank: 10 } },
});

const PHIGROS_PROFILE = profile({
  game: 'phigros',
  profileId: 'profile-phi-1',
  player: { name: 'Phi Player', rating: 15.2, native: { challengeModeRank: 316 } },
  isPublic: false,
  origin: 'app',
  lastSyncedAt: null,
  updatedAt: '2026-10-02T00:00:00Z',
});

const ARCAEA_PROFILE = profile({
  game: 'arcaea',
  profileId: 'profile-arc-1',
  player: { name: 'Arc Player', rating: 12.34, native: { b50Avg: 10.8, b10Avg: 12.1 } },
});

const MAIMAI_BESTS: GameBests = {
  game: 'maimai',
  computedAt: '2026-10-20T00:00:00Z',
  totals: { total: 15000, latest: 12000, archive: 3000 },
  buckets: [],
};

/** ϕ 桶 3 首 + best30 桶 27 首，全部 rks 15 ⇒ 平均 15。 */
const PHIGROS_BESTS: GameBests = {
  game: 'phigros',
  computedAt: '2026-10-20T00:00:00Z',
  totals: { rks: 15, officialRks: 15.2 },
  buckets: [
    {
      key: 'phi',
      label: 'ϕ',
      total: 45,
      items: [0, 1, 2].map((index) => ({
        scoreId: `phi-${String(index)}`,
        songId: `phi-${String(index)}`,
        songName: 'Phi Song',
        type: null,
        difficulty: 'IN',
        levelIndex: 2,
        level: '15',
        achievements: 100,
        score: null,
        rating: 15,
        rank: 'phi',
        dxScore: null,
        dxStar: null,
        fc: 'phi',
        fs: null,
        playTime: null,
        native: null,
      })),
    },
    {
      key: 'best30',
      label: 'Best 30',
      total: 405,
      items: Array.from({ length: 27 }, (_, index) => ({
        scoreId: `best-${String(index)}`,
        songId: `best-${String(index)}`,
        songName: 'Best Song',
        type: null,
        difficulty: 'IN',
        levelIndex: 2,
        level: '15',
        achievements: 99,
        score: null,
        rating: 15,
        rank: null,
        dxScore: null,
        dxStar: null,
        fc: null,
        fs: null,
        playTime: null,
        native: null,
      })),
    },
  ],
};

const PHIGROS_STATISTICS: PhigrosStatistics = {
  officialRks: 15.2,
  calculatedRks: 15,
  b19AverageRks: 15.05,
  challengeModeRank: 316,
  challengeRankLevel: 3,
  challengeDifficulty: 16,
  totalScores: 128,
  fcCount: 42,
  phiCount: 3,
  ratings: { ϕ: 3 },
  levels: {
    EZ: { played: 10, clear: 9, fc: 6, phi: 2 },
    HD: { played: 20, clear: 18, fc: 12, phi: 4 },
    IN: { played: 30, clear: 25, fc: 15, phi: 5 },
    AT: { played: 5, clear: 3, fc: 1, phi: 0 },
  },
  lastSyncedAt: null,
};

const ME_PROFILE: MeProfile = {
  uid: '100234567',
  displayName: 'Fake User',
  bio: '测试账号',
  avatarUrl: null,
  bannerUrl: null,
  isPublic: true,
  displayPreferences: { phigrosDifficulty: 'IN' },
  games: [],
};

class FakeCardRenderer implements Renderer {
  readonly cardCalls: PlayerCardRenderInput[] = [];
  closed = false;

  async renderMaimaiB50(): Promise<Buffer> {
    throw new Error('未装配');
  }

  async renderPhigrosRks(): Promise<Buffer> {
    throw new Error('未装配');
  }

  async renderPlayerCard(input: PlayerCardRenderInput): Promise<Buffer> {
    this.cardCalls.push(input);
    return Buffer.from('fake-png');
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface FakeRankHubState {
  profiles: Record<string, GameProfile[] | Error>;
  bests: Record<string, GameBests | Error>;
  statistics: PhigrosStatistics | Error;
  meProfile: MeProfile | Error;
  preferences: DisplayPreferences;
  updatePreferences: (preferences: DisplayPreferences) => Promise<DisplayPreferences>;
  calls: string[];
}

function createFakeRankHub(state: FakeRankHubState): RankHubClientExtended {
  const get = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);

  const fake = {
    async authorize(): Promise<string> {
      state.calls.push('authorize');
      return 'access-token';
    },
    async listGames(): Promise<GameCapability[]> {
      state.calls.push('listGames');
      return [
        { game: 'maimai', read: true, pushProfile: true, pushScores: true, deletionRequest: true },
        { game: 'phigros', read: true, pushProfile: true, pushScores: true, deletionRequest: true },
        { game: 'arcaea', read: true, pushProfile: true, pushScores: true, deletionRequest: true },
      ];
    },
    async listProfiles(_token: string, game: string): Promise<GameProfile[]> {
      state.calls.push(`listProfiles:${game}`);
      const value = state.profiles[game] ?? [];
      return get(value);
    },
    async getBests(_token: string, game: string): Promise<GameBests> {
      state.calls.push(`getBests:${game}`);
      const value = state.bests[game];
      if (value === undefined) throw new RankHubError('not_found', 404, '没有 bests');
      return get(value);
    },
    async getPhigrosStatistics(): Promise<PhigrosStatistics> {
      state.calls.push('getPhigrosStatistics');
      return get(state.statistics);
    },
    async getMeProfile(): Promise<MeProfile> {
      state.calls.push('getMeProfile');
      return get(state.meProfile);
    },
    async getDisplayPreferences(): Promise<DisplayPreferences> {
      state.calls.push('getDisplayPreferences');
      return state.preferences;
    },
    async updateDisplayPreferences(
      _token: string,
      preferences: DisplayPreferences,
    ): Promise<DisplayPreferences> {
      state.calls.push(`updateDisplayPreferences:${preferences.phigrosDifficulty}`);
      return state.updatePreferences(preferences);
    },
  };
  return fake as unknown as RankHubClientExtended;
}

interface Harness {
  services: CommandServices;
  renderer: FakeCardRenderer;
  replies: { text: string[]; images: Buffer[] };
  state: FakeRankHubState;
  store: SqliteBindingStore;
  dir: string;
  ctx(args: string): CommandContext;
  close(): void;
}

const BINDING_OPENID = 'qq-openid-1';

function makeConfig(dir: string): AppConfig {
  return {
    QQ_APP_ID: 'test-app-id',
    QQ_APP_SECRET: 'test-app-secret',
    QQ_API_BASE: 'http://127.0.0.1:1',
    QQ_TOKEN_URL: 'http://127.0.0.1:1/app/getAppAccessToken',
    QQ_INTENTS: 1 << 25,
    RANKHUB_CLIENT_ID: 'rankhub-qqbot',
    RANKHUB_CLIENT_SECRET: 'fake-client-secret',
    RANKHUB_AUTH_BASE: 'http://127.0.0.1:1',
    RANKHUB_API_BASE: 'http://127.0.0.1:1',
    RANKHUB_SCOPES: 'openid profile offline_access game:read',
    RANKHUB_REDIRECT_URI: 'http://127.0.0.1:17830/callback',
    RANKHUB_DEVICE_POLL_MAX_SECONDS: 240,
    TOKEN_ENC_KEY: TOKEN_KEY,
    DB_PATH: join(dir, 'bot.db'),
    MAIMAI_RENDERER: 'auto',
    MAIMAI_PYTHON: 'python3.11',
    LOG_LEVEL: 'error',
    rootDir: process.cwd(),
    envFileLoaded: false,
  };
}

async function createHarness(overrides: Partial<FakeRankHubState> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rankhub-me-test-'));
  const config = makeConfig(dir);
  const store = createBindingStore(config);
  await store.upsert({
    qqUserOpenid: BINDING_OPENID,
    unionOpenid: null,
    rankhubSubject: 'user-fake-sub',
    rankhubName: 'Fake User',
    refreshToken: 'rt_fake_refresh',
    accessToken: 'at_fake_access',
    accessExpiresAt: Date.now() + 3_600_000,
    scopes: 'openid profile offline_access game:read',
  });

  const state: FakeRankHubState = {
    profiles: {
      maimai: [MAIMAI_PROFILE],
      phigros: [PHIGROS_PROFILE],
      arcaea: [ARCAEA_PROFILE],
    },
    bests: { maimai: MAIMAI_BESTS, phigros: PHIGROS_BESTS },
    statistics: PHIGROS_STATISTICS,
    meProfile: ME_PROFILE,
    preferences: { phigrosDifficulty: 'IN' },
    updatePreferences: (preferences) => Promise.resolve(preferences),
    calls: [],
    ...overrides,
  };

  const renderer = new FakeCardRenderer();
  const replies: { text: string[]; images: Buffer[] } = { text: [], images: [] };
  const reply: Reply = {
    async text(_ctx, text): Promise<void> {
      replies.text.push(text);
    },
    async image(_ctx, image): Promise<void> {
      replies.images.push(image);
    },
  };

  const services: CommandServices = {
    config,
    logger: silentLogger,
    store,
    rankhub: createFakeRankHub(state),
    renderer,
    qq: { identity: () => null },
    reply,
    runtime: new CommandRuntime(() => Date.now(), silentLogger),
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
  };

  let seq = 0;
  const ctx = (args: string): CommandContext => {
    seq += 1;
    const event: QQMessageEvent = {
      kind: 'group_at',
      messageId: `msg-${String(seq)}`,
      groupOpenid: 'group-1',
      userOpenid: BINDING_OPENID,
      content: args === '' ? '/me' : `/me ${args}`,
      timestamp: new Date().toISOString(),
      quoteId: null,
      raw: null,
    };
    return { event, args, command: 'me', logger: silentLogger };
  };

  return {
    services,
    renderer,
    replies,
    state,
    store,
    dir,
    ctx,
    close(): void {
      try {
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** 已创建的 harness（afterEach 统一收尾）。 */
const activeHarnesses: Harness[] = [];

afterEach(() => {
  while (activeHarnesses.length > 0) activeHarnesses.pop()?.close();
});

/** 建 harness 并登记收尾（不执行指令）。 */
async function makeHarness(overrides: Partial<FakeRankHubState> = {}): Promise<Harness> {
  const harness = await createHarness(overrides);
  activeHarnesses.push(harness);
  return harness;
}

/** 建 harness 并执行一次 `/me <args>`。 */
async function runMe(
  args: string,
  overrides: Partial<FakeRankHubState> = {},
): Promise<Harness> {
  const harness = await makeHarness(overrides);
  await meCommand(harness.services, harness.ctx(args));
  return harness;
}

// ────────────────────────────────── 用例 ──────────────────────────────────

describe('/me 参数解析', () => {
  it('无参数 / 非 diff 参数都按渲染名片处理', () => {
    expect(resolveMeArgs('')).toEqual({ kind: 'card' });
    expect(resolveMeArgs('   ')).toEqual({ kind: 'card' });
    expect(resolveMeArgs('foo')).toEqual({ kind: 'card' });
    expect(resolveMeArgs('diffx')).toEqual({ kind: 'card' });
  });

  it('/me diff 回当前难度', () => {
    expect(resolveMeArgs('diff')).toEqual({ kind: 'diff-show' });
    expect(resolveMeArgs('  DIFF  ')).toEqual({ kind: 'diff-show' });
  });

  it('/me diff <难度> 大小写不敏感', () => {
    expect(resolveMeArgs('diff in')).toEqual({ kind: 'diff-set', difficulty: 'IN' });
    expect(resolveMeArgs('diff AT')).toEqual({ kind: 'diff-set', difficulty: 'AT' });
    expect(resolveMeArgs('diff  hd ')).toEqual({ kind: 'diff-set', difficulty: 'HD' });
  });

  it('非法难度 / 多余参数返回 diff-invalid', () => {
    expect(resolveMeArgs('diff xyz')).toEqual({ kind: 'diff-invalid' });
    expect(resolveMeArgs('diff 1')).toEqual({ kind: 'diff-invalid' });
    expect(resolveMeArgs('diff IN AT')).toEqual({ kind: 'diff-invalid' });
  });
});

describe('/me 名片数据装配', () => {
  it('三张卡按冻结契约映射（maimai B35/B15、phigros B30 与达成、arcaea PTT/B50/B10）', async () => {
    const harness = await runMe('');

    expect(harness.renderer.cardCalls).toHaveLength(1);
    const input = harness.renderer.cardCalls[0]!;
    expect(input.displayName).toBe('Fake User');
    expect(input.uid).toBe('100234567');
    expect(input.games.map((icon) => icon.name)).toEqual([
      'maimai DX',
      'Phigros',
      'Arcaea',
    ]);
    expect(input.cards.map((card) => card.game)).toEqual(['maimai', 'phigros', 'arcaea']);
    expect(input.qr).toBeInstanceOf(Buffer);

    const maimai = input.cards[0];
    expect(maimai).toMatchObject({
      game: 'maimai',
      name: 'Mai Player',
      rating: 15000,
      b35Rating: 3000,
      b15Rating: 12000,
      lastSyncedAt: '2026-10-01T00:00:00Z',
    });

    const phigros = input.cards[1];
    expect(phigros).toMatchObject({
      game: 'phigros',
      name: 'Phi Player',
      // (phi 3 + best30 27 首，全部 rks 15) / 30 = 15
      rks: 15,
      challengeModeRank: 316,
      difficulty: 'IN',
      achievements: { played: 30, clear: 25, fc: 15, phi: 5 },
    });

    const arcaea = input.cards[2];
    expect(arcaea).toMatchObject({
      game: 'arcaea',
      name: 'Arc Player',
      potential: 12.34,
      b50Avg: 10.8,
      b10Avg: 12.1,
    });
  });

  it('Phigros 难度取用户偏好（HD ⇒ 该难度达成统计）', async () => {
    const harness = await runMe('', {
      meProfile: { ...ME_PROFILE, displayPreferences: { phigrosDifficulty: 'HD' } },
    });
    const phigros = harness.renderer.cardCalls[0]!.cards[1];
    expect(phigros).toMatchObject({
      game: 'phigros',
      difficulty: 'HD',
      achievements: { played: 20, clear: 18, fc: 12, phi: 4 },
    });
  });

  it('/v1/me/profile 不可用时回退 getDisplayPreferences，再不行回退默认 IN', async () => {
    const harness = await runMe('', {
      meProfile: new RankHubError('not_found', 404, '旧实例没有该端点'),
      preferences: { phigrosDifficulty: 'AT' },
    });
    expect(harness.renderer.cardCalls[0]!.cards[1]).toMatchObject({ difficulty: 'AT' });
    expect(harness.state.calls).toContain('getDisplayPreferences');
  });

  it('单个游戏失败只跳过该卡', async () => {
    const harness = await runMe('', {
      profiles: {
        maimai: [MAIMAI_PROFILE],
        phigros: new RankHubError('server_error', 500, '炸了'),
        arcaea: [ARCAEA_PROFILE],
      },
    });
    const cards = harness.renderer.cardCalls[0]!.cards;
    expect(cards.map((card) => card.game)).toEqual(['maimai', 'arcaea']);
  });

  it('bests 失败时卡片降级（rating 仍在、B35/B15 为 null）而不是整卡丢弃', async () => {
    const harness = await runMe('', {
      bests: { maimai: new RankHubError('server_error', 500, '炸了') },
    });
    expect(harness.renderer.cardCalls[0]!.cards[0]).toMatchObject({
      game: 'maimai',
      rating: 15000,
      b35Rating: null,
      b15Rating: null,
    });
  });

  it('全部游戏失败且无账号资料时回文字摘要', async () => {
    const harness = await runMe('', {
      profiles: {
        maimai: new RankHubError('server_error', 500, '炸了'),
        phigros: new RankHubError('server_error', 500, '炸了'),
        arcaea: new RankHubError('server_error', 500, '炸了'),
      },
      meProfile: new RankHubError('not_found', 404, '旧实例'),
    });
    expect(harness.renderer.cardCalls).toHaveLength(0);
    const text = harness.replies.text.join('\n');
    expect(text).toContain('RankHub 账号：Fake User');
    expect(text).toContain('档案摘要');
  });

  it('v1 assets：maimai 头像/背景板、phigros 头像/曲绘、arcaea 头像/立绘 都进渲染入参', async () => {
    const images = await startImageServer();
    try {
      const harness = await runMe('', {
        profiles: {
          maimai: [
            profile({
              game: 'maimai',
              profileId: 'profile-mai-1',
              player: MAIMAI_PROFILE.player,
              assets: {
                avatarUrl: `${images.base}/mai/avatar.png`,
                backgroundUrl: `${images.base}/mai/frame.png`,
                characterArtworkUrl: null,
              },
            }),
          ],
          phigros: [
            profile({
              game: 'phigros',
              profileId: 'profile-phi-1',
              player: PHIGROS_PROFILE.player,
              isPublic: false,
              origin: 'app',
              lastSyncedAt: null,
              assets: {
                avatarUrl: `${images.base}/phi/avatar.png`,
                backgroundUrl: `${images.base}/phi/background.png`,
                characterArtworkUrl: null,
              },
            }),
          ],
          arcaea: [
            profile({
              game: 'arcaea',
              profileId: 'profile-arc-1',
              player: ARCAEA_PROFILE.player,
              assets: {
                avatarUrl: `${images.base}/arc/avatar.png`,
                backgroundUrl: `${images.base}/arc/nameplate.png`,
                characterArtworkUrl: `${images.base}/arc/artwork.png`,
              },
            }),
          ],
        },
      });

      const cards = harness.renderer.cardCalls[0]!.cards;
      // maimai：用户背景板（v1 assets.backgroundUrl）作为 frame 传给渲染器。
      expect(cards[0]).toMatchObject({
        game: 'maimai',
        avatar: expect.any(Buffer),
        frame: expect.any(Buffer),
      });
      expect(cards[1]).toMatchObject({
        game: 'phigros',
        avatar: expect.any(Buffer),
        background: expect.any(Buffer),
      });
      expect(cards[2]).toMatchObject({
        game: 'arcaea',
        avatar: expect.any(Buffer),
        characterArtwork: expect.any(Buffer),
      });

      // 每个 assets URL 都被真实 fetch 过（顺序不保证，故用 arrayContaining）。
      expect(images.requests).toEqual(
        expect.arrayContaining([
          '/mai/avatar.png',
          '/mai/frame.png',
          '/phi/avatar.png',
          '/phi/background.png',
          '/arc/avatar.png',
          '/arc/artwork.png',
        ]),
      );
    } finally {
      await images.close();
    }
  });

  it('老实例（assets 三字段全 null）：卡片不带任何图片字段', async () => {
    const harness = await runMe('');

    const cards = harness.renderer.cardCalls[0]!.cards;
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(card).not.toHaveProperty('avatar');
    expect(cards[0]).not.toHaveProperty('frame');
    expect(cards[1]).not.toHaveProperty('background');
    expect(cards[2]).not.toHaveProperty('characterArtwork');
  });
});

describe('/me diff 指令', () => {
  it('/me diff 回当前难度与可选值', async () => {
    const harness = await makeHarness({ preferences: { phigrosDifficulty: 'HD' } });
    await meCommand(harness.services, harness.ctx('diff'));

    const text = harness.replies.text.join('\n');
    expect(text).toContain('当前难度：HD');
    expect(text).toContain('EZ / HD / IN / AT');
    expect(harness.renderer.cardCalls).toHaveLength(0);
  });

  it('/me diff <难度> 写回并回执', async () => {
    const harness = await makeHarness();
    await meCommand(harness.services, harness.ctx('diff in'));

    expect(harness.state.calls).toContain('updateDisplayPreferences:IN');
    const text = harness.replies.text.join('\n');
    expect(text).toContain('已把 Phigros 卡片难度切换为 IN');
  });

  it('/me diff 非法参数：回用法提示且不写后端', async () => {
    const harness = await makeHarness();
    await meCommand(harness.services, harness.ctx('diff xyz'));

    expect(
      harness.state.calls.some((call) => call.startsWith('updateDisplayPreferences')),
    ).toBe(false);
    expect(harness.replies.text.join('\n')).toContain(ME_DIFF_USAGE_TEXT.split('\n')[0]!);
  });

  it('/me diff 写回失败：明确错误文案 + 说明当前难度未变更', async () => {
    const harness = await makeHarness({
      updatePreferences: () => Promise.reject(new RankHubError('server_error', 500, '后端炸了')),
    });
    await meCommand(harness.services, harness.ctx('diff AT'));

    const text = harness.replies.text.join('\n');
    expect(text).toContain('切换 Phigros 难度失败');
    expect(text).toContain('RankHub 服务异常');
    expect(text).toContain('当前难度保持不变');
  });

  it('/me diff 写回时授权失效：走统一失效提示', async () => {
    const harness = await makeHarness({
      updatePreferences: () => Promise.reject(new RankHubError('unauthorized', 401, '掉了')),
    });
    await meCommand(harness.services, harness.ctx('diff AT'));

    expect(harness.replies.text.join('\n')).toContain('授权已失效');
    // 统一失效处理会把 binding 标记为 revoked（与其它指令一致）。
    const binding: Binding | null = await harness.store.getByQqUser(BINDING_OPENID);
    expect(binding?.status).toBe('revoked');
  });
});

describe('纯函数：B30 平均与达成统计', () => {
  it('computeB30Average 缺失返回 null、空桶返回 0、按 30 取平均并保留 4 位小数', () => {
    expect(computeB30Average(null)).toBeNull();
    expect(computeB30Average({ ...PHIGROS_BESTS, buckets: [] })).toBe(0);
    expect(computeB30Average(PHIGROS_BESTS)).toBe(15);

    const custom: GameBests = {
      ...PHIGROS_BESTS,
      buckets: [
        { key: 'phi', label: 'ϕ', total: null, items: [{ ...PHIGROS_BESTS.buckets[0]!.items[0]!, rating: 16.6 }] },
        {
          key: 'best',
          label: 'Best',
          total: null,
          items: [{ ...PHIGROS_BESTS.buckets[1]!.items[0]!, rating: 16.6 }],
        },
      ],
    };
    // (16.6 + 16.6) / 30 = 1.10666… ⇒ 1.1067
    expect(computeB30Average(custom)).toBe(1.1067);
  });

  it('achievementsFor 缺失统计返回 0/0/0/0', () => {
    expect(achievementsFor(null, 'IN')).toEqual({ played: 0, clear: 0, fc: 0, phi: 0 });
    expect(achievementsFor(PHIGROS_STATISTICS, 'AT')).toEqual({
      played: 5,
      clear: 3,
      fc: 1,
      phi: 0,
    });
  });
});
