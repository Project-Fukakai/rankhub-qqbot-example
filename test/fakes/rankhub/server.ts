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
  scoresPages?: Record<string, FakeScorePage>;
  userinfo?: Record<string, unknown> | null;
}

const SENSITIVE_FORM_KEY = /(token|secret|code|password)/i;

function redactForm(form: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
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
        player: { name: 'Fake Player', rating: 15000, native: { course_rank: 10 } },
        isPublic: true,
        origin: 'user',
        createdByClientId: null,
        syncCapable: true,
        lastSyncedAt: '2026-10-01T00:00:00Z',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ],
    phigros: [
      {
        profileId: 'profile-phi-1',
        game: 'phigros',
        player: { name: 'Fake Player', rating: 15.2, native: null },
        isPublic: false,
        origin: 'app',
        createdByClientId: 'cli_fake',
        syncCapable: false,
        lastSyncedAt: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
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
  };
}

/** 可启动的假 RankHub。用 `FakeRankHub.start()` 创建。 */
export class FakeRankHub {
  readonly state: FakeRankHubState;
  private readonly server: Server;
  private readonly requestIdPrefix = 'req_';
  private requestSeq = 0;
  private port = 0;

  private constructor(options: FakeRankHubOptions) {
    this.state = {
      clientId: options.clientId ?? 'rankhub-qqbot',
      clientSecret: options.clientSecret ?? 'fake-client-secret',
      tokenExpiresIn: options.tokenExpiresIn ?? 3600,
      pendingPollsBeforeApproval: options.pendingPollsBeforeApproval ?? 0,
      devices: new Map(),
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
      profiles: options.profiles ?? defaultProfiles(),
      bests: options.bests ?? defaultBests(),
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

  /** 测试里手动推进设备码状态（deny / expire / 直接 approve）。 */
  setDeviceStatus(deviceCode: string, status: FakeDeviceStatus): void {
    const entry = this.state.devices.get(deviceCode);
    if (entry === undefined) throw new Error(`未知 device_code：${deviceCode}`);
    entry.status = status;
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
    if (req.method === 'POST') {
      const raw = await readBody(req);
      form = Object.fromEntries(new URLSearchParams(raw));
    }
    this.state.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form: redactForm(form),
      hasAuthorization: typeof req.headers.authorization === 'string',
    });
    try {
      this.route(req, res, url, form);
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
  ): void {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'POST' && path === '/v1/oauth/device_authorization') {
      this.handleDeviceAuthorization(res, form);
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
    if (method === 'GET' && path === '/v1/oidc/userinfo') {
      this.handleUserinfo(req, res);
      return;
    }
    if (method === 'GET' && path === '/v1/games') {
      this.handleGames(req, res);
      return;
    }
    const match = /^\/v1\/games\/([^/]+)\/profiles(?:\/([^/]+)\/(bests|scores))?$/.exec(path);
    if (method === 'GET' && match !== null) {
      const game = decodeURIComponent(match[1] ?? '');
      const profileId = match[2] === undefined ? null : decodeURIComponent(match[2]);
      const kind = match[3] ?? 'profiles';
      this.handleGameResource(req, res, url, game, profileId, kind);
      return;
    }
    this.sendEnvelope(res, 404, 'common.notFound', `假服务没有这条路由：${method} ${path}`, null);
  }

  // ───────────────────────────────── OAuth ─────────────────────────────────

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
      { code, message, data, requestId: `${this.requestIdPrefix}${this.requestSeq}` },
      headers,
    );
  }
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
