/**
 * 冻结接口：QQ 传输层、RankHub 客户端、存储、渲染器。
 *
 * 这些类型是并行开发的边界：qq-transport / rankhub-data / render-* / commands
 * 四个方向都只依赖本文件，任何一方不得单方面改动签名（要改先改这里并通知 lead）。
 */

// ─────────────────────────────────── QQ ───────────────────────────────────

export type QQEventKind = 'group_at' | 'c2c';

/** 归一后的入站消息。`content` 已去掉 @机器人 前缀（QQ 平台保证）。 */
export interface QQMessageEvent {
  kind: QQEventKind;
  /** 被动回复用的 msg_id。 */
  messageId: string;
  groupOpenid: string | null;
  userOpenid: string;
  content: string;
  timestamp: string;
  raw: unknown;
}

/** 被动回复上下文：记录该消息已用的 msg_seq，避免重复发送失败。 */
export interface ReplyContext {
  event: QQMessageEvent;
}

export interface QQIdentity {
  id: string;
  username: string;
}

export interface QQTransport {
  /** 建立网关连接并开始派发事件。须在返回前完成一次 READY（或抛错）。 */
  start(handler: (event: QQMessageEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  identity(): QQIdentity | null;
  replyText(ctx: ReplyContext, text: string): Promise<void>;
  /** PNG/JPEG 字节；内部负责上传拿 file_info 与 msg_type=7 发送。 */
  replyImage(ctx: ReplyContext, image: Buffer, filename?: string): Promise<void>;
}

// ───────────────────────────────── RankHub ────────────────────────────────

export interface RankHubTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  idToken: string | null;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'ok'; tokens: RankHubTokens }
  | { status: 'denied' }
  | { status: 'expired' };

export interface RankHubIdentity {
  subject: string;
  name: string | null;
  picture: string | null;
}

export interface GameCapability {
  game: string;
  read: boolean;
  pushProfile: boolean;
  pushScores: boolean;
  deletionRequest: boolean;
}

export interface GamePlayer {
  name: string | null;
  rating: number | null;
  native: Record<string, unknown> | null;
}

export interface GameProfile {
  profileId: string;
  game: string;
  player: GamePlayer;
  isPublic: boolean;
  origin: 'user' | 'app';
  syncCapable: boolean;
  lastSyncedAt: string | null;
  updatedAt: string;
}

export interface GameScore {
  scoreId: string;
  songId: string;
  songName: string | null;
  type: string | null;
  difficulty: string | null;
  levelIndex: number | null;
  level: string | null;
  achievements: number | null;
  score: number | null;
  rating: number | null;
  rank: string | null;
  dxScore: number | null;
  dxStar: number | null;
  fc: string | null;
  fs: string | null;
  playTime: string | null;
  native: Record<string, unknown> | null;
}

export interface GameBestBucket {
  key: string;
  label: string;
  total: number | null;
  items: GameScore[];
}

export interface GameBests {
  game: string;
  computedAt: string;
  totals: Record<string, number | null>;
  buckets: GameBestBucket[];
}

export interface ScoresQuery {
  limit?: number;
  cursor?: string;
  sortBy?: 'playTime' | 'achievements' | 'rating';
  order?: 'asc' | 'desc';
  difficulty?: string;
}

export interface ScorePage {
  items: GameScore[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type RankHubErrorCode =
  | 'unauthorized'
  | 'invalid_grant'
  | 'rate_limited'
  | 'first_party_only'
  | 'not_found'
  | 'invalid_argument'
  | 'server_error'
  | 'network_error';

export class RankHubError extends Error {
  constructor(
    readonly code: RankHubErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'RankHubError';
  }
}

export interface RankHubClient {
  deviceStart(scope: string): Promise<DeviceAuthorization>;
  devicePoll(deviceCode: string): Promise<DevicePollResult>;
  userinfo(accessToken: string): Promise<RankHubIdentity>;
  listGames(accessToken: string): Promise<GameCapability[]>;
  listProfiles(accessToken: string, game: string): Promise<GameProfile[]>;
  getBests(accessToken: string, game: string, profileId: string): Promise<GameBests>;
  listScores(
    accessToken: string,
    game: string,
    profileId: string,
    query?: ScoresQuery,
  ): Promise<ScorePage>;
  revoke(token: string): Promise<void>;
}

// ────────────────────────────────── 存储 ──────────────────────────────────

export type BindingStatus = 'active' | 'revoked';

export interface Binding {
  id: string;
  qqUserOpenid: string;
  unionOpenid: string | null;
  rankhubSubject: string;
  rankhubName: string | null;
  refreshTokenEnc: string;
  accessTokenEnc: string | null;
  accessExpiresAt: number | null;
  scopes: string;
  status: BindingStatus;
  createdAt: number;
  updatedAt: number;
}

export interface BindingStore {
  getByQqUser(qqUserOpenid: string): Promise<Binding | null>;
  upsert(input: {
    qqUserOpenid: string;
    unionOpenid: string | null;
    rankhubSubject: string;
    rankhubName: string | null;
    refreshToken: string;
    accessToken: string;
    accessExpiresAt: number;
    scopes: string;
  }): Promise<Binding>;
  updateTokens(
    bindingId: string,
    input: { accessToken: string; refreshToken: string; accessExpiresAt: number; scopes: string },
  ): Promise<void>;
  markRevoked(bindingId: string): Promise<void>;
  deleteByQqUser(qqUserOpenid: string): Promise<void>;
}

/** 设备码绑定中的临时会话（内存即可，进程重启后用户重发 /bind）。 */
export interface PendingDevice {
  qqUserOpenid: string;
  unionOpenid: string | null;
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  createdAt: number;
  messageId: string;
  groupOpenid: string | null;
  nextReplySeq: number;
}

// ────────────────────────────────── 渲染 ──────────────────────────────────

export interface RenderProfile {
  name: string;
  rating: string;
  game: string;
}

export interface MaimaiB50RenderInput {
  profileName: string;
  rating: number;
  /** `latest`(15) / `archive`(35)；`label` 来自 API 的展示名，可缺省。 */
  buckets: { key: string; label?: string; total?: number | null; items: GameScore[] }[];
  totals: Record<string, number | null>;
  computedAt: string;
}

export interface PhigrosRksRenderInput {
  profileName: string;
  rks: number;
  officialRks: number | null;
  phi: GameScore[];
  best: GameScore[];
  computedAt: string;
}

export interface Renderer {
  renderMaimaiB50(input: MaimaiB50RenderInput): Promise<Buffer>;
  renderPhigrosRks(input: PhigrosRksRenderInput): Promise<Buffer>;
  close(): Promise<void>;
}
