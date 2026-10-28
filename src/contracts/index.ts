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
  /** 引用回复用的消息索引（`message_scene.ext` 的 `msg_idx`）；没有则为 null。 */
  quoteId: string | null;
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

/**
 * 一条游戏档案的展示资源绝对 URL（v1 `GameProfileDto.assets`）。
 *
 * 冻结契约：`RankHubWorkspace/docs/V1-PROFILE-ASSETS.md` §2。三个字段一律
 * `string | null`——`null` 表示「该游戏没有这个概念 / 取不到」，不是「未实现」；
 * 老实例完全没有 `assets` 字段时由 wire 归一成「三字段全 null」，调用方据此回退本地规则。
 */
export interface GameProfileAssets {
  /** 头像绝对 URL（maimai 头像 / phigros 头像 / arcaea 头像）。 */
  avatarUrl: string | null;
  /** 背景绝对 URL（maimai 背景板 frame / phigros 曲绘 / arcaea 名片板）。 */
  backgroundUrl: string | null;
  /** 立绘绝对 URL（目前只有 arcaea 搭档立绘；其它游戏恒 null）。 */
  characterArtworkUrl: string | null;
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
  /** 展示资源（v1 新增；缺失时三字段全 null，见 `GameProfileAssets`）。 */
  assets: GameProfileAssets;
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

/** 名片顶部的圆形游戏图标（素材由调用方给 Buffer，避免渲染器碰网络/文件系统）。 */
export interface PlayerCardGameIcon {
  /** 游戏展示名（如 `maimai DX`）。 */
  name: string;
  icon: Buffer;
}

/** Phigros 难度（与 App `PhigrosDifficulty` / 后端偏好枚举逐字一致）。 */
export type PhigrosDifficulty = 'EZ' | 'HD' | 'IN' | 'AT';

/**
 * 名片里的玩家卡片（maimai / phigros / arcaea 的判别联合）。
 *
 * 版式 1:1 对齐 App「我的」页 `profileCardBuilder`：
 * - maimai → `PlayerInfoCard`（背景板 / 方形头像 / DX Rating 徽章 / 名字条 / B35+B15 / 最近同步）
 * - phigros → `PhigrosPlayerCard`（曲绘 / 左上 RKS+课题模式+名字 / 右下 CLEAR·FC·PHI / 难度平行四边形）
 * - arcaea → `ArcaeaPlayerInfoCard`（bg_light + hidden + banner / 立绘 / 头像+PTT 徽章 / B50+B10 / 最近同步）
 *
 * 所有图片都是调用方拉好的 Buffer：渲染器不解析 URL、不发网络请求。
 */
export interface PlayerCardMaimaiCardData {
  game: 'maimai';
  /** 玩家名（原样，空串由渲染器决定占位）。 */
  name: string;
  /** DX Rating（整数）。 */
  rating: number | null;
  /** 往期版本 B35。 */
  b35Rating: number | null;
  /** 当期版本 B15。 */
  b15Rating: number | null;
  avatar?: Buffer | null;
  /** 背景板（App 默认 frame 455203 或调用方拉的 frame）。 */
  frame?: Buffer | null;
  lastSyncedAt?: string | null;
}

export interface PlayerCardPhigrosCardData {
  game: 'phigros';
  name: string;
  /** 卡片大号数字：B30 平均 RKS（与 App `_b30Average` 一致，4 位小数）。 */
  rks: number | null;
  /** 课题模式三位数（百位段位 + 后两位难度）；0/缺省 = 不画徽章。 */
  challengeModeRank: number | null;
  avatar?: Buffer | null;
  /** 曲绘背景（`backgroundSongId` → App 曲绘 URL）。 */
  background?: Buffer | null;
  /** 当前展示难度（来自用户偏好）。 */
  difficulty: PhigrosDifficulty;
  /** 该难度下的全谱面达成统计（后端 statistics.levels[difficulty]）。 */
  achievements: { played: number; clear: number; fc: number; phi: number };
}

export interface PlayerCardArcaeaCardData {
  game: 'arcaea';
  name: string;
  /** Potential。 */
  potential: number | null;
  /** Best 50 平均。 */
  b50Avg: number | null;
  /** Best 10 平均。 */
  b10Avg: number | null;
  /** 档案头像（为空时渲染器回退立绘）。 */
  avatar?: Buffer | null;
  /** 搭档 1080px 立绘（`arc/char/1080/{character}.png`）。 */
  characterArtwork?: Buffer | null;
  lastSyncedAt?: string | null;
}

export type PlayerCardGameCard =
  | PlayerCardMaimaiCardData
  | PlayerCardPhigrosCardData
  | PlayerCardArcaeaCardData;

/** `/me` 完整玩家名片。 */
export interface PlayerCardRenderInput {
  displayName: string;
  uid: string | null;
  bio?: string | null;
  banner?: Buffer | null;
  avatar?: Buffer | null;
  games: PlayerCardGameIcon[];
  cards: PlayerCardGameCard[];
  /** 隐私为公开时才传；null/缺省 = 不画二维码。 */
  qr?: Buffer | null;
}

/** 用户显示偏好（后端 `/v1/me/display-preferences` 的 data）。 */
export interface DisplayPreferences {
  phigrosDifficulty: PhigrosDifficulty;
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  phigrosDifficulty: 'IN',
};

/** arcaea B50/B30 海报。 */
export interface ArcaeaB50RenderInput {
  profileName: string;
  potential: number | null;
  items: GameScore[];
  computedAt?: string | null;
}

export interface Renderer {
  renderMaimaiB50(input: MaimaiB50RenderInput): Promise<Buffer>;
  renderPhigrosRks(input: PhigrosRksRenderInput): Promise<Buffer>;
  /** 可选：未装配名片渲染器时为 undefined，由指令层降级成文字。 */
  renderPlayerCard?(input: PlayerCardRenderInput): Promise<Buffer>;
  renderArcaeaB50?(input: ArcaeaB50RenderInput): Promise<Buffer>;
  close(): Promise<void>;
}
