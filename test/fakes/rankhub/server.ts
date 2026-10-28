import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本地假 RankHub（`node:http`）。
 *
 * 只实现客户端真正会用到的端点，但**形状严格照服务端事实**：
 * - 设备码：`POST /v1/oauth/device_authorization`（form 六键响应）；
 * - 令牌：`POST /v1/oauth/token`（RFC 8628 语义：pending / slow_down 是 **200 + body.error**，
 *   access_denied / expired_token 是 400；refresh 轮换后旧 rt 重放 ⇒ 401 invalid_grant）；
 * - userinfo / revoke；
 * - `/v1/games/**` 的 v1 envelope（`{code,message,data,requestId}`）与 429 + Retry-After。
 *
 * 测试只打这个假服务，绝不访问真实 RankHub。记录下来的请求体对 token/secret 做脱敏，
 * 失败信息里也不会出现明文凭据。
 */

export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export type FakeDeviceStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface FakeDeviceEntry {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string;
  status: FakeDeviceStatus;
  /** 还要返回几次 `authorization_pending`（HTTP 200）。 */
  pendingPolls: number;
  /** 还要返回几次 `slow_down`（HTTP 200）。 */
  slowDownPolls: number;
  interval: number;
  issued: boolean;
}

export interface FakeAuthorizationEntry {
  pollToken: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  code: string | null;
}

export interface FakeScorePage {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FakeGameError {
  status: number;
  code: string;
  message?: string;
}

export interface FakeRankHubState {
  clientId: string;
  clientSecret: string;
  tokenExpiresIn: number;
  /** 新建设备码时初始 `authorization_pending` 次数（默认 0 = 首次轮询即批准）。 */
  pendingPollsBeforeApproval: number;
  devices: Map<string, FakeDeviceEntry>;
  authorizations: Map<string, FakeAuthorizationEntry>;
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  /** access token → 同一次签发里的 refresh token（撤销任一都撤整对，模拟族撤销）。 */
  accessToRefresh: Map<string, string>;
  /** 已撤销 / 已轮换的令牌（任何再用都算重放）。 */
  revokedTokens: Set<string>;
  userinfo: Record<string, unknown> | null;
  tokenRequests: number;
  deviceRequests: number;
  refreshRequests: number;
  games: Record<string, unknown>[];
  profiles: Record<string, Record<string, unknown>[]>;
  bests: Record<string, Record<string, unknown>>;
  /** phigros 逐难度统计：`profileId → statistics`（路由缺省回落到默认形状）。 */
  statistics: Record<string, Record<string, unknown>>;
  /** 用户显示偏好（`/v1/me/display-preferences` 的 data，PATCH 会就地改写）。 */
  displayPreferences: { phigrosDifficulty: string };
  /** `false` 模拟「老实例」：profile 响应里没有 `assets` 字段（测试回退规则用）。 */
  includeAssets: boolean;
  /** `cursor`（默认页用空串）→ 页面。 */
  scoresPages: Record<string, FakeScorePage>;
  firstPartyOnly: Set<string>;
  gameErrors: Map<string, FakeGameError>;
  rateLimit: { remaining: number; retryAfterSeconds: number };
  requests: RecordedRequest[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** 表单字段；敏感字段值已脱敏成 `[redacted]`。 */
  form: Record<string, string>;
  /** JSON body（PATCH 等）；敏感字段值已脱敏成 `[redacted]`。 */
  json: Record<string, unknown>;
  hasAuthorization: boolean;
}

export interface FakeRankHubOptions {
  clientId?: string;
  clientSecret?: string;
  tokenExpiresIn?: number;
  pendingPollsBeforeApproval?: number;
  games?: Record<string, unknown>[];
  profiles?: Record<string, Record<string, unknown>[]>;
  bests?: Record<string, Record<string, unknown>>;
  statistics?: Record<string, Record<string, unknown>>;
  displayPreferences?: { phigrosDifficulty: string };
  /** `false` 模拟老实例（profile 不带 `assets`）；默认 true。 */
  includeAssets?: boolean;
  scoresPages?: Record<string, FakeScorePage>;
  userinfo?: Record<string, unknown> | null;
}

const SENSITIVE_FORM_KEY = /(token|secret|code|password)/i;

/** 后端 display-preferences 允许的难度值（契约 §2.1）。 */
const PHIGROS_DIFFICULTY_LABELS = new Set(['EZ', 'HD', 'IN', 'AT']);

/**
 * 假图片路径：`defaultProfiles()` 的 `assets` 夹具把 URL 指向
 * `{{origin}}/fake/image.png?...`（响应时替换 origin），E2E 因此全程不联网。
 */
export const FAKE_IMAGE_PATH = '/fake/image.png';

/** 1x1 透明 PNG（固定字节）。 */
export const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
  'base64',
);

function redactForm(form: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    out[key] = SENSITIVE_FORM_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}

function redactJson(json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    out[key] = SENSITIVE_FORM_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}

function makeUserCode(): string {
  const raw = randomUUID().replace(/-/g, '').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

const DEFAULT_SCORE: Record<string, unknown> = {
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
  // 服务端将来可能加字段：客户端必须忽略，而不是崩。
  unknownFutureField: true,
};

function defaultProfiles(): Record<string, Record<string, unknown>[]> {
  return {
    maimai: [
      {
        profileId: 'profile-mai-1',
        game: 'maimai',
        // v1 adapter 的真实 native 形状（camelCase）：展示字段 + 头像 URL。
        player: {
          name: 'Fake Player',
          rating: 15000,
          native: { course_rank: 10, class_rank: 5, star: 12 },
        },
        isPublic: true,
        origin: 'user',
        createdByClientId: null,
        syncCapable: true,
        lastSyncedAt: '2026-10-01T00:00:00Z',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
        // v1 `GameProfileDto.assets`（契约 V1-PROFILE-ASSETS §2）：URL 用 `{{origin}}`
        // 占位，`sendEnvelope()` 在响应时替换成本假服务 origin（E2E 不访问外网）。
        assets: {
          avatarUrl: '{{origin}}/fake/image.png?game=maimai&asset=avatar',
          backgroundUrl: '{{origin}}/fake/image.png?game=maimai&asset=frame',
          characterArtworkUrl: null,
        },
      },
    ],
    arcaea: [
      {
        profileId: 'profile-arc-1',
        game: 'arcaea',
        // `b50Avg` / `b10Avg` 是 v1 native 的评级均值字段（b10Avg 由契约 2.3 新增）。
        player: {
          name: 'Fake Arc Player',
          rating: 12.34,
          native: { b30Avg: 11.2, b50Avg: 10.8, b10Avg: 12.1 },
        },
        isPublic: true,
        origin: 'user',
        createdByClientId: null,
        syncCapable: true,
        lastSyncedAt: '2026-10-01T00:00:00Z',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
        assets: {
          avatarUrl: '{{origin}}/fake/image.png?game=arcaea&asset=avatar',
          backgroundUrl: '{{origin}}/fake/image.png?game=arcaea&asset=nameplate',
          characterArtworkUrl: '{{origin}}/fake/image.png?game=arcaea&asset=artwork',
        },
      },
    ],
    phigros: [
      {
        profileId: 'profile-phi-1',
        game: 'phigros',
        player: {
          name: 'Fake Player',
          rating: 15.2,
          native: { challengeModeRank: 316, gameVersion: '3.7.0' },
        },
        isPublic: false,
        origin: 'app',
        createdByClientId: 'cli_fake',
        syncCapable: false,
        lastSyncedAt: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
        assets: {
          avatarUrl: '{{origin}}/fake/image.png?game=phigros&asset=avatar',
          backgroundUrl: '{{origin}}/fake/image.png?game=phigros&asset=background',
          characterArtworkUrl: null,
        },
      },
    ],
  };
}

function defaultGames(): Record<string, unknown>[] {
  return [
    { game: 'maimai', read: true, pushProfile: true, pushScores: true, deletionRequest: true },
    { game: 'phigros', read: true, pushProfile: true, pushScores: true, deletionRequest: true },
  ];
}

/** 生成一条 phigros 成绩（rks 固定，便于断言 B30 平均）。 */
function phigrosScore(id: string, rks: number): Record<string, unknown> {
  return {
    scoreId: id,
    songId: id,
    songName: `Fake Phi ${id}`,
    type: null,
    difficulty: 'IN',
    levelIndex: 2,
    level: '15',
    achievements: 99.5,
    score: 1000000,
    rating: rks,
    rank: 'phi',
    dxScore: null,
    dxStar: null,
    fc: 'phi',
    fs: null,
    playTime: null,
    native: { constant: 15.0 },
  };
}

/**
 * phigros bests（契约：`totals.rks` / `buckets.phi` / `buckets.best30`）。
 *
 * ϕ 桶 3 首 + best30 桶 27 首、全部 rks 15.0 ⇒ B30 平均 = 450 / 30 = 15（便于 e2e 断言）。
 */
function defaultPhigrosBests(): Record<string, unknown> {
  return {
    game: 'phigros',
    computedAt: '2026-10-20T00:00:00Z',
    totals: { rks: 15, officialRks: 15.2 },
    buckets: [
      {
        key: 'phi',
        label: 'ϕ',
        total: 45,
        items: ['phi-1', 'phi-2', 'phi-3'].map((id) => phigrosScore(id, 15)),
      },
      {
        key: 'best30',
        label: 'Best 30',
        total: 405,
        items: Array.from({ length: 27 }, (_, index) =>
          phigrosScore(`best-${String(index + 1)}`, 15),
        ),
      },
    ],
  };
}

/** phigros 逐难度统计（契约 §2.2 的 `data.statistics` 形状）。 */
const DEFAULT_PHIGROS_STATISTICS: Record<string, unknown> = {
  officialRks: 15.2,
  calculatedRks: 15,
  b19AverageRks: 15.05,
  challengeModeRank: 316,
  challengeRankLevel: 3,
  challengeDifficulty: 16,
  totalScores: 128,
  fcCount: 42,
  phiCount: 3,
  ratings: { ϕ: 3, S: 12 },
  levels: {
    EZ: { played: 10, clear: 9, fc: 6, phi: 2 },
    HD: { played: 20, clear: 18, fc: 12, phi: 4 },
    IN: { played: 30, clear: 25, fc: 15, phi: 5 },
    AT: { played: 5, clear: 3, fc: 1, phi: 0 },
  },
  lastSyncedAt: null,
};

function defaultBests(): Record<string, Record<string, unknown>> {
  return {
    maimai: {
      game: 'maimai',
      computedAt: '2026-10-20T00:00:00Z',
      totals: { total: 15000, latest: 12000 },
      buckets: [
        {
          key: 'latest',
          label: '当期',
          total: 12000,
          items: [DEFAULT_SCORE],
        },
        {
          key: 'archive',
          label: '往期',
          total: null,
          items: [],
        },
      ],
    },
    phigros: defaultPhigrosBests(),
  };
}

/**
 * 模拟「老实例」：把 profile 上的 `assets` 删掉（响应里完全没有该字段），
 * 用来锁定客户端的本地 URL 回退路径。
 */
function stripProfileAssets(profiles: Record<string, Record<string, unknown>[]>): void {
  for (const list of Object.values(profiles)) {
    for (const profile of list) delete profile['assets'];
  }
}

/** 可启动的假 RankHub。用 `FakeRankHub.start()` 创建。 */
export class FakeRankHub {
  readonly state: FakeRankHubState;
  private readonly server: Server;
  private readonly requestIdPrefix = 'req_';
  private requestSeq = 0;
  private port = 0;

  private constructor(options: FakeRankHubOptions) {
    const profiles = options.profiles ?? defaultProfiles();
    const includeAssets = options.includeAssets !== false;
    if (!includeAssets) stripProfileAssets(profiles);
    this.state = {
      clientId: options.clientId ?? 'rankhub-qqbot',
      clientSecret: options.clientSecret ?? 'fake-client-secret',
      tokenExpiresIn: options.tokenExpiresIn ?? 3600,
      pendingPollsBeforeApproval: options.pendingPollsBeforeApproval ?? 0,
      devices: new Map(),
      authorizations: new Map(),
      accessTokens: new Set(),
      refreshTokens: new Set(),
      accessToRefresh: new Map(),
      revokedTokens: new Set(),
      userinfo:
        options.userinfo === undefined
          ? {
              sub: 'user-fake-sub',
              name: 'Fake User',
              preferred_username: 'fake_user',
              picture: 'https://example.test/avatar.png',
            }
          : options.userinfo,
      tokenRequests: 0,
      deviceRequests: 0,
      refreshRequests: 0,
      games: options.games ?? defaultGames(),
      profiles,
      bests: options.bests ?? defaultBests(),
      statistics: options.statistics ?? { 'profile-phi-1': DEFAULT_PHIGROS_STATISTICS },
      displayPreferences: options.displayPreferences ?? { phigrosDifficulty: 'IN' },
      includeAssets,
      scoresPages: options.scoresPages ?? {
        '': { items: [DEFAULT_SCORE], nextCursor: null, hasMore: false },
      },
      firstPartyOnly: new Set(),
      gameErrors: new Map(),
      rateLimit: { remaining: 0, retryAfterSeconds: 1 },
      requests: [],
    };
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  static async start(options: FakeRankHubOptions = {}): Promise<FakeRankHub> {
    const fake = new FakeRankHub(options);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      fake.server.once('error', onError);
      fake.server.listen(0, '127.0.0.1', () => {
        fake.server.off('error', onError);
        resolve();
      });
    });
    const address = fake.server.address() as AddressInfo;
    fake.port = address.port;
    return fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get authBase(): string {
    return this.origin;
  }

  get apiBase(): string {
    return this.origin;
  }

  /** 假图片的绝对 URL（临时改写夹具时用；默认 assets 夹具已自动指向本机）。 */
  get fakeImageUrl(): string {
    return `${this.origin}${FAKE_IMAGE_PATH}`;
  }

  /** 测试里手动推进设备码状态（deny / expire / 直接 approve）。 */
  setDeviceStatus(deviceCode: string, status: FakeDeviceStatus): void {
    const entry = this.state.devices.get(deviceCode);
    if (entry === undefined) throw new Error(`未知 device_code：${deviceCode}`);
    entry.status = status;
  }

  /** 模拟用户在 App 里确认授权（生成一次性 code）。 */
  approveAuthorization(pollToken: string): void {
    const entry = this.state.authorizations.get(pollToken);
    if (entry === undefined) throw new Error(`未知 pollToken：${pollToken}`);
    entry.status = 'approved';
    entry.code = `code_${randomUUID()}`;
  }

  /** 模拟用户拒绝。 */
  denyAuthorization(pollToken: string): void {
    const entry = this.state.authorizations.get(pollToken);
    if (entry === undefined) throw new Error(`未知 pollToken：${pollToken}`);
    entry.status = 'denied';
  }

  /** 模拟授权过期。 */
  expireAuthorization(pollToken: string): void {
    const entry = this.state.authorizations.get(pollToken);
    if (entry === undefined) throw new Error(`未知 pollToken：${pollToken}`);
    entry.status = 'expired';
  }

  /** 最近一次创建的 pollToken（E2E 用来推进审批）。 */
  lastAuthorization(): FakeAuthorizationEntry | null {
    const entries = [...this.state.authorizations.values()];
    return entries[entries.length - 1] ?? null;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // ────────────────────────────────── 路由 ──────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    let form: Record<string, string> = {};
    let json: Record<string, unknown> = {};
    // 有 body 的方法都要读：PATCH 是 `/v1/me/display-preferences` 的写路径。
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const raw = await readBody(req);
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        try {
          json = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          json = {};
        }
      } else {
        form = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    this.state.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form: redactForm(form),
      json: redactJson(json),
      hasAuthorization: typeof req.headers.authorization === 'string',
    });
    try {
      this.route(req, res, url, form, json);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.sendEnvelope(res, 500, 'common.internalError', `假服务内部错误：${detail}`, null);
    }
  }

  private route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    form: Record<string, string>,
    json: Record<string, unknown>,
  ): void {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'POST' && path === '/v1/oauth/device_authorization') {
      this.handleDeviceAuthorization(res, form);
      return;
    }
    if (method === 'POST' && path === '/v1/interaction/oauth-authorizations') {
      this.handleCreateAuthorization(res, json);
      return;
    }
    if (method === 'POST' && path === '/v1/interaction/oauth-authorizations/status') {
      this.handleAuthorizationStatus(res, json);
      return;
    }
    if (method === 'POST' && path === '/v1/oauth/token') {
      this.handleToken(res, form);
      return;
    }
    if (method === 'POST' && path === '/v1/oauth/revoke') {
      this.handleRevoke(res, form);
      return;
    }
    if (
      (method === 'GET' || method === 'PATCH') &&
      path === '/v1/me/display-preferences'
    ) {
      this.handleDisplayPreferences(req, res, method, json);
      return;
    }
    if (method === 'GET' && path === '/v1/me/profile') {
      this.sendEnvelope(res, 200, 'common.ok', 'OK', {
        uid: '100234567',
        displayName: 'Fake User',
        bio: '测试账号',
        avatarUrl: null,
        bannerUrl: null,
        isPublic: true,
        // 契约 §2.1：`/v1/me/profile` 带上 displayPreferences，省机器人一次往返。
        displayPreferences: { ...this.state.displayPreferences },
        games: this.meProfileGames(),
      });
      return;
    }
    if (method === 'GET' && path === '/v1/oidc/userinfo') {
      this.handleUserinfo(req, res);
      return;
    }
    if (method === 'GET' && path === '/v1/games') {
      this.handleGames(req, res);
      return;
    }
    const match =
      /^\/v1\/games\/([^/]+)\/profiles(?:\/([^/]+)\/(bests|scores|statistics))?$/.exec(path);
    if (method === 'GET' && match !== null) {
      const game = decodeURIComponent(match[1] ?? '');
      const profileId = match[2] === undefined ? null : decodeURIComponent(match[2]);
      const kind = match[3] ?? 'profiles';
      this.handleGameResource(req, res, url, game, profileId, kind);
      return;
    }
    // 假图片：E2E 测名片素材下载时把资产 URL 指到本机，避免任何外网请求。
    if (method === 'GET' && path === FAKE_IMAGE_PATH) {
      this.sendImage(res, ONE_PX_PNG);
      return;
    }
    this.sendEnvelope(res, 404, 'common.notFound', `假服务没有这条路由：${method} ${path}`, null);
  }

  // ───────────────────────────────── OAuth ─────────────────────────────────

  private handleCreateAuthorization(res: ServerResponse, json: Record<string, unknown>): void {
    const clientId = typeof json.clientId === 'string' ? json.clientId : '';
    const redirectUri = typeof json.redirectUri === 'string' ? json.redirectUri : '';
    if (clientId !== this.state.clientId) {
      this.sendJson(res, 401, { error: 'invalid_client', error_description: 'Unknown OAuth client' });
      return;
    }
    if (redirectUri === '') {
      this.sendEnvelope(res, 400, 'common.invalidArgument', 'redirectUri is required', null);
      return;
    }
    const pollToken = `oauth_poll_${randomUUID()}`;
    const entry: FakeAuthorizationEntry = {
      pollToken,
      clientId,
      redirectUri,
      state: typeof json.state === 'string' ? json.state : '',
      scope: typeof json.scope === 'string' ? json.scope : '',
      status: 'pending',
      code: null,
    };
    this.state.authorizations.set(pollToken, entry);
    this.sendJson(res, 201, {
      code: 'common.ok',
      message: 'OK',
      data: {
        pollToken,
        deepLink: `rankhub://oauth/authorize?token=${pollToken}`,
        deepLinkQrCodeDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        client: { clientId, clientName: 'RankHub QQ Bot' },
        permissions: [],
      },
      requestId: 'req_fake',
    });
  }

  private handleAuthorizationStatus(res: ServerResponse, json: Record<string, unknown>): void {
    const pollToken = typeof json.pollToken === 'string' ? json.pollToken : '';
    const entry = this.state.authorizations.get(pollToken);
    if (entry === undefined) {
      this.sendEnvelope(res, 400, 'common.invalidArgument', 'pollToken is invalid', null);
      return;
    }
    const resumeUrl =
      entry.status === 'approved' && entry.code !== null
        ? `${entry.redirectUri}?code=${encodeURIComponent(entry.code)}&state=${encodeURIComponent(entry.state)}`
        : null;
    this.sendJson(res, 200, {
      code: 'common.ok',
      message: 'OK',
      data: { status: entry.status, resumeUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() },
      requestId: 'req_fake',
    });
  }

  private handleAuthorizationCodeToken(res: ServerResponse, form: Record<string, string>): void {
    const code = form.code ?? '';
    const entry = [...this.state.authorizations.values()].find((item) => item.code === code);
    if (entry === undefined || entry.status !== 'approved' || entry.code === null) {
      this.sendJson(res, 400, { error: 'invalid_grant', error_description: 'authorization code is invalid' });
      return;
    }
    if (entry.code === code && entry.status === 'approved') {
      // 一次性：换过即作废。
      entry.status = 'cancelled';
    }
    this.sendJson(res, 200, this.issueTokens());
  }

  private handleDeviceAuthorization(res: ServerResponse, form: Record<string, string>): void {
    if (form.client_id !== this.state.clientId) {
      this.sendJson(res, 401, { error: 'invalid_client', error_description: 'Unknown OAuth client' });
      return;
    }
    this.state.deviceRequests += 1;
    const deviceCode = `dc_${randomUUID()}`;
    const userCode = makeUserCode();
    const entry: FakeDeviceEntry = {
      deviceCode,
      userCode,
      clientId: form.client_id,
      scope: form.scope ?? '',
      status: 'pending',
      pendingPolls: this.state.pendingPollsBeforeApproval,
      slowDownPolls: 0,
      interval: 5,
      issued: false,
    };
    this.state.devices.set(deviceCode, entry);
    this.sendJson(res, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${this.origin}/oauth/device`,
      verification_uri_complete: `${this.origin}/oauth/device?user_code=${encodeURIComponent(userCode)}`,
      expires_in: 600,
      interval: entry.interval,
    });
  }

  private handleToken(res: ServerResponse, form: Record<string, string>): void {
    this.state.tokenRequests += 1;
    if (
      form.client_id !== this.state.clientId ||
      form.client_secret !== this.state.clientSecret
    ) {
      this.sendJson(res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials' });
      return;
    }
    if (form.grant_type === DEVICE_CODE_GRANT_TYPE) {
      this.handleDeviceToken(res, form);
      return;
    }
    if (form.grant_type === 'authorization_code') {
      this.handleAuthorizationCodeToken(res, form);
      return;
    }
    if (form.grant_type === 'refresh_token') {
      this.handleRefreshToken(res, form);
      return;
    }
    this.sendJson(res, 400, {
      error: 'invalid_request',
      error_description: `Unsupported grant_type: ${form.grant_type ?? ''}`,
    });
  }

  private handleDeviceToken(res: ServerResponse, form: Record<string, string>): void {
    const entry = this.state.devices.get(form.device_code ?? '');
    if (entry === undefined) {
      this.sendJson(res, 400, { error: 'invalid_request', error_description: 'device_code is invalid' });
      return;
    }
    if (entry.status === 'expired') {
      this.sendJson(res, 400, { error: 'expired_token', error_description: 'The device_code has expired' });
      return;
    }
    if (entry.status === 'denied') {
      this.sendJson(res, 400, {
        error: 'access_denied',
        error_description: 'The user denied the device authorization request',
      });
      return;
    }
    if (entry.issued) {
      this.sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'device_code is not approved',
      });
      return;
    }
    if (entry.slowDownPolls > 0) {
      entry.slowDownPolls -= 1;
      // RFC 8628 §3.5：slow_down 是 200 + error 体。
      this.sendJson(res, 200, {
        error: 'slow_down',
        error_description: 'Polling is faster than the advised interval',
      });
      return;
    }
    if (entry.pendingPolls > 0) {
      entry.pendingPolls -= 1;
      this.sendJson(res, 200, {
        error: 'authorization_pending',
        error_description: 'The user has not yet approved the device',
      });
      return;
    }
    entry.issued = true;
    entry.status = 'approved';
    this.sendJson(res, 200, this.issueTokens());
  }

  private handleRefreshToken(res: ServerResponse, form: Record<string, string>): void {
    this.state.refreshRequests += 1;
    const refreshToken = form.refresh_token ?? '';
    if (!this.state.refreshTokens.has(refreshToken)) {
      // 旧 rt（已轮换）与未知 rt 同一条：401 invalid_grant（真实服务端还会撤整个族）。
      this.sendJson(res, 401, {
        error: 'invalid_grant',
        error_description: 'Refresh token replay detected; token family revoked',
      });
      return;
    }
    this.state.refreshTokens.delete(refreshToken);
    this.state.revokedTokens.add(refreshToken);
    this.sendJson(res, 200, this.issueTokens());
  }

  private issueTokens(): Record<string, unknown> {
    const accessToken = `at_${randomUUID()}`;
    const refreshToken = `rt_${randomUUID()}`;
    this.state.accessTokens.add(accessToken);
    this.state.refreshTokens.add(refreshToken);
    this.state.accessToRefresh.set(accessToken, refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.state.tokenExpiresIn,
      scope: 'openid profile offline_access game:read',
    };
  }

  private handleRevoke(res: ServerResponse, form: Record<string, string>): void {
    const token = form.token ?? '';
    if (token !== '') {
      // 撤销任一令牌都撤整个「对」：真实服务端撤的是 token family。
      const pairedRefresh = this.state.accessTokens.has(token)
        ? (this.state.accessToRefresh.get(token) ?? null)
        : this.state.refreshTokens.has(token)
          ? token
          : null;
      this.state.accessTokens.delete(token);
      this.state.accessToRefresh.delete(token);
      if (pairedRefresh !== null) {
        this.state.refreshTokens.delete(pairedRefresh);
        this.state.revokedTokens.add(pairedRefresh);
        for (const [access, refresh] of this.state.accessToRefresh) {
          if (refresh === pairedRefresh) {
            this.state.accessTokens.delete(access);
            this.state.accessToRefresh.delete(access);
          }
        }
      }
      this.state.revokedTokens.add(token);
    }
    // RFC 7009：未知 token 也 200。
    this.sendJson(res, 200, {});
  }

  private handleUserinfo(req: IncomingMessage, res: ServerResponse): void {
    const token = bearerToken(req);
    if (token === null || !this.state.accessTokens.has(token) || this.state.userinfo === null) {
      this.sendJson(
        res,
        401,
        { error: 'invalid_token', error_description: 'The access token is invalid or expired' },
        { 'www-authenticate': 'Bearer error="invalid_token"' },
      );
      return;
    }
    this.sendJson(res, 200, this.state.userinfo);
  }

  // ─────────────────────────── /v1/me/display-preferences ───────────────────────────

  /**
   * 用户显示偏好（契约 §2.1）：GET 读、PATCH 写（允许只传部分键，未知键忽略）。
   * 非法难度值 → 400 `common.invalidArgument`（与后端同一口径）。
   */
  private handleDisplayPreferences(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    json: Record<string, unknown>,
  ): void {
    if (!this.isAuthorized(req)) {
      this.sendEnvelope(res, 401, 'auth.unauthenticated', '未认证', null);
      return;
    }
    if (method === 'PATCH') {
      const requested = json['phigrosDifficulty'];
      if (requested !== undefined) {
        const normalized =
          typeof requested === 'string' ? requested.trim().toUpperCase() : '';
        if (!PHIGROS_DIFFICULTY_LABELS.has(normalized)) {
          this.sendEnvelope(
            res,
            400,
            'common.invalidArgument',
            'phigrosDifficulty 必须是 EZ / HD / IN / AT 之一',
            null,
          );
          return;
        }
        this.state.displayPreferences = {
          ...this.state.displayPreferences,
          phigrosDifficulty: normalized,
        };
      }
    }
    this.sendEnvelope(res, 200, 'common.ok', '成功', { ...this.state.displayPreferences });
  }

  /**
   * `/v1/me/profile` 的 `games[]`。
   *
   * 契约 V1-PROFILE-ASSETS §2：增加 `characterArtworkUrl`；maimai 的 `backgroundUrl`
   * 从 null 变为背景板（frame）URL。`includeAssets === false` 时按**老实例**形状返回
   * （只有 avatarUrl/backgroundUrl 且全 null，没有 characterArtworkUrl 字段）。
   */
  private meProfileGames(): Record<string, unknown>[] {
    if (!this.state.includeAssets) {
      return [
        {
          game: 'maimai',
          profileId: 'profile-mai-1',
          playerName: 'Fake Player',
          rating: 15000,
          isPublic: true,
          avatarUrl: null,
          backgroundUrl: null,
        },
        {
          game: 'phigros',
          profileId: 'profile-phi-1',
          playerName: 'Fake Player',
          rating: 15.2,
          isPublic: false,
          avatarUrl: null,
          backgroundUrl: null,
        },
        {
          game: 'arcaea',
          profileId: 'profile-arc-1',
          playerName: 'Fake Arc Player',
          rating: 12.34,
          isPublic: true,
          avatarUrl: null,
          backgroundUrl: null,
        },
      ];
    }
    return [
      {
        game: 'maimai',
        profileId: 'profile-mai-1',
        playerName: 'Fake Player',
        rating: 15000,
        isPublic: true,
        avatarUrl: '{{origin}}/fake/image.png?game=maimai&asset=avatar',
        backgroundUrl: '{{origin}}/fake/image.png?game=maimai&asset=frame',
        characterArtworkUrl: null,
      },
      {
        game: 'phigros',
        profileId: 'profile-phi-1',
        playerName: 'Fake Player',
        rating: 15.2,
        isPublic: false,
        avatarUrl: '{{origin}}/fake/image.png?game=phigros&asset=avatar',
        backgroundUrl: '{{origin}}/fake/image.png?game=phigros&asset=background',
        characterArtworkUrl: null,
      },
      {
        game: 'arcaea',
        profileId: 'profile-arc-1',
        playerName: 'Fake Arc Player',
        rating: 12.34,
        isPublic: true,
        avatarUrl: '{{origin}}/fake/image.png?game=arcaea&asset=avatar',
        backgroundUrl: '{{origin}}/fake/image.png?game=arcaea&asset=nameplate',
        characterArtworkUrl: '{{origin}}/fake/image.png?game=arcaea&asset=artwork',
      },
    ];
  }

  // ─────────────────────────────── /v1/games ───────────────────────────────

  private handleGames(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isAuthorized(req)) {
      this.sendEnvelope(res, 401, 'auth.unauthenticated', '未认证', null);
      return;
    }
    this.sendEnvelope(res, 200, 'common.ok', '成功', { games: this.state.games });
  }

  private handleGameResource(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    game: string,
    profileId: string | null,
    kind: string,
  ): void {
    if (!this.isAuthorized(req)) {
      this.sendEnvelope(res, 401, 'auth.unauthenticated', '未认证', null);
      return;
    }
    const injected = this.state.gameErrors.get(game);
    if (injected !== undefined) {
      this.sendEnvelope(
        res,
        injected.status,
        injected.code,
        injected.message ?? '注入的错误',
        null,
      );
      return;
    }
    if (this.state.rateLimit.remaining > 0) {
      this.state.rateLimit.remaining -= 1;
      this.sendEnvelope(res, 429, 'common.rateLimited', '请求过于频繁', null, {
        'retry-after': String(this.state.rateLimit.retryAfterSeconds),
      });
      return;
    }
    if (this.state.firstPartyOnly.has(game)) {
      this.sendEnvelope(
        res,
        403,
        'game.firstPartyOnly',
        '该游戏仅支持第一方访问',
        null,
      );
      return;
    }

    if (kind === 'profiles') {
      const profiles = this.state.profiles[game];
      if (profiles === undefined) {
        this.sendEnvelope(res, 404, 'common.notFound', '游戏或档案不存在', null);
        return;
      }
      this.sendEnvelope(res, 200, 'common.ok', '成功', {
        items: profiles,
        nextCursor: null,
        hasMore: false,
      });
      return;
    }

    if (profileId === null) {
      this.sendEnvelope(res, 404, 'common.notFound', '档案不存在', null);
      return;
    }

    if (kind === 'bests') {
      const bests = this.state.bests[game];
      if (bests === undefined) {
        this.sendEnvelope(res, 404, 'common.notFound', '档案不存在', null);
        return;
      }
      this.sendEnvelope(res, 200, 'common.ok', '成功', bests);
      return;
    }

    if (kind === 'statistics') {
      // 契约 §2.2：只有 phigros 实现 `getStatistics`；其它游戏 404（与"不支持"口径一致）。
      if (game !== 'phigros') {
        this.sendEnvelope(res, 404, 'common.notFound', `游戏 ${game} 不支持 statistics`, null);
        return;
      }
      const statistics = this.state.statistics[profileId];
      if (statistics === undefined) {
        this.sendEnvelope(res, 404, 'common.notFound', '档案不存在', null);
        return;
      }
      this.sendEnvelope(res, 200, 'common.ok', '成功', { game: 'phigros', statistics });
      return;
    }

    // scores
    const limitRaw = url.searchParams.get('limit');
    let limit: number | null = null;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        this.sendEnvelope(
          res,
          400,
          'common.invalidArgument',
          'limit 必须是 1..100 的整数',
          null,
        );
        return;
      }
      limit = parsed;
    }
    const cursor = url.searchParams.get('cursor') ?? '';
    const page = this.state.scoresPages[cursor];
    if (page === undefined) {
      this.sendEnvelope(res, 400, 'common.invalidArgument', `未知 cursor：${cursor}`, null);
      return;
    }
    const items = limit === null ? page.items : page.items.slice(0, limit);
    this.sendEnvelope(res, 200, 'common.ok', '成功', {
      items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const token = bearerToken(req);
    return token !== null && this.state.accessTokens.has(token);
  }

  // ──────────────────────────────── 响应工具 ────────────────────────────────

  /** 返回图片字节（`fetchImage` 只接受 `image/*`）。 */
  private sendImage(res: ServerResponse, image: Buffer): void {
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': image.length,
    });
    res.end(image);
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  }

  private sendEnvelope(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    data: unknown,
    headers: Record<string, string> = {},
  ): void {
    this.requestSeq += 1;
    this.sendJson(
      res,
      status,
      {
        code,
        message,
        // 夹具里的 `{{origin}}` 占位在本机 origin 上解析：E2E 素材下载不访问外网。
        data: resolvePlaceholders(data, this.origin),
        requestId: `${this.requestIdPrefix}${this.requestSeq}`,
      },
      headers,
    );
  }
}

/**
 * 递归替换夹具字符串里的 `{{origin}}` 占位（假服务端口在构造时未知，只能响应时解析）。
 * 只影响测试夹具；真实客户端看到的是绝对 URL。
 */
function resolvePlaceholders(value: unknown, origin: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{origin}}', origin);
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, origin));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolvePlaceholders(item, origin);
    }
    return out;
  }
  return value;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export { DEFAULT_SCORE };
