/**
 * 指令层公共设施：服务容器、回复封装、绑定/令牌处理、缓存、文本格式化。
 *
 * 约定：
 * - 所有 handler 只依赖 `CommandServices` + `CommandContext`，不直接 new 任何底层；
 * - 「没有绑定 / 令牌失效 / 限流 / 网络错误」四类用户可见状态在这里统一转成中文文案；
 * - 未知异常一律 rethrow，由 dispatcher 兜底（日志留内部细节，用户只看到通用提示）。
 */
import type { AppConfig } from '../config/index.js';
import {
  RankHubError,
  type Binding,
  type GameBests,
  type GameProfile,
  type GameScore,
  type QQMessageEvent,
  type ReplyContext,
  type Renderer,
} from '../contracts/index.js';
import type { Logger } from '../logger/index.js';
import type { RankHubClientExtended } from '../rankhub/index.js';
import type { SqliteBindingStore } from '../store/index.js';

import type { CommandRuntime } from './runtime.js';

/** 回复通道（由 create-bot 用 QQTransport 实现；测试可注入假实现）。 */
export interface Reply {
  text(ctx: ReplyContext, text: string): Promise<void>;
  image(ctx: ReplyContext, image: Buffer, filename?: string): Promise<void>;
}

export interface QQIdentityLike {
  id: string;
  username: string;
}

/** 指令层可见的依赖（全部由 create-bot 装配，测试可只替换 renderer/sleep/now）。 */
export interface CommandServices {
  config: AppConfig;
  logger: Logger;
  store: SqliteBindingStore;
  rankhub: RankHubClientExtended;
  renderer: Renderer;
  /** `identity()` 用于 /status；测试可传 null。 */
  qq: { identity(): QQIdentityLike | null };
  reply: Reply;
  runtime: CommandRuntime;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CommandContext {
  event: QQMessageEvent;
  /** 首 token 之后的原始参数串（已 trim，不解析引号）。 */
  args: string;
  /** 注册表里的规范指令名（别名已归一）。 */
  command: string;
  logger: Logger;
}

export type CommandHandler = (services: CommandServices, ctx: CommandContext) => Promise<void>;

/** 未绑定 RankHub 时的统一提示。 */
export const NOT_BOUND_TEXT =
  '你还没有绑定 RankHub。发送 /bind 获取设备码并完成绑定后再试。';

const PENDING_BIND_TEXT =
  '绑定流程尚未完成。请打开 /bind 返回的链接并确认；如果链接已过期，重新发送 /bind。';

// ───────────────────────────────── 回复封装 ────────────────────────────────

export function eventContext(event: QQMessageEvent): ReplyContext {
  return { event };
}

export async function sendText(
  services: CommandServices,
  ctx: CommandContext,
  text: string,
): Promise<void> {
  await services.reply.text(eventContext(ctx.event), text);
}

export async function sendImage(
  services: CommandServices,
  ctx: CommandContext,
  image: Buffer,
  filename?: string,
): Promise<void> {
  await services.reply.image(eventContext(ctx.event), image, filename);
}

/** 后台任务里的回复：会话可能已关闭，失败只记日志不抛。 */
export async function safeSendText(
  services: CommandServices,
  ctx: CommandContext,
  text: string,
): Promise<void> {
  try {
    await sendText(services, ctx, text);
  } catch (error) {
    ctx.logger.warn('后台回复失败', {
      messageId: ctx.event.messageId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// ───────────────────────────────── 计时 / 指标 ─────────────────────────────

/** 包一层 RankHub 调用，记录耗时供 /status 展示。 */
export async function timed<T>(
  services: CommandServices,
  label: string,
  call: () => Promise<T>,
): Promise<T> {
  const startedAt = services.now();
  try {
    return await call();
  } finally {
    services.runtime.recordApi(label, Math.max(0, services.now() - startedAt));
  }
}

// ───────────────────────────────── 令牌 / 错误 ─────────────────────────────

const RANKHUB_ERROR_TEXT: Record<RankHubError['code'], string> = {
  unauthorized: 'RankHub 授权已失效，请重新发送 /bind 绑定。',
  invalid_grant: 'RankHub 授权已失效（令牌被撤销或过期），请重新发送 /bind 绑定。',
  rate_limited: 'RankHub 请求过于频繁，请稍后再试。',
  first_party_only: '该游戏仅支持第一方访问，暂时无法查询。',
  not_found: '没有找到对应的 RankHub 数据（档案可能已删除）。',
  invalid_argument: '请求参数不合法，请检查指令用法。',
  server_error: 'RankHub 服务异常，请稍后再试。',
  network_error: 'RankHub 暂时不可用，请稍后再试。',
};

/** 把 RankHubError 翻译成用户可见文案；未知异常返回 false（交给 dispatcher 兜底）。 */
export async function replyRankHubError(
  services: CommandServices,
  ctx: CommandContext,
  error: unknown,
  binding: Binding | null,
): Promise<boolean> {
  if (!(error instanceof RankHubError)) return false;
  if ((error.code === 'invalid_grant' || error.code === 'unauthorized') && binding !== null) {
    try {
      await services.store.markRevoked(binding.id);
    } catch (markError) {
      ctx.logger.warn('标记 binding 失效失败', {
        bindingId: binding.id,
        reason: markError instanceof Error ? markError.message : String(markError),
      });
    }
  }
  ctx.logger.warn('RankHub 调用失败', { code: error.code, status: error.status });
  await sendText(services, ctx, RANKHUB_ERROR_TEXT[error.code]);
  return true;
}

export interface AuthorizedBinding {
  binding: Binding;
  accessToken: string;
}

/**
 * 读取 binding 并取可用 access token（过期自动刷新并落库）。
 *
 * 失败时已经回好用户提示（未绑定 / 令牌失效 / 限流 / 网络），调用方直接 return。
 */
export async function authorizeBinding(
  services: CommandServices,
  ctx: CommandContext,
): Promise<AuthorizedBinding | null> {
  const binding = await services.store.getByQqUser(ctx.event.userOpenid);
  if (binding === null) {
    // 可能刚 /bind 但后台轮询还没完成：区分一下提示，避免用户困惑。
    const pending = await services.store.getPendingDevice(ctx.event.userOpenid);
    await sendText(
      services,
      ctx,
      pending !== null && pending.expiresAt > services.now() ? PENDING_BIND_TEXT : NOT_BOUND_TEXT,
    );
    return null;
  }
  if (binding.status === 'revoked') {
    await sendText(services, ctx, '你的 RankHub 绑定已失效，请重新发送 /bind 绑定。');
    return null;
  }
  try {
    const accessToken = await timed(services, 'authorize', () =>
      services.rankhub.authorize(binding),
    );
    return { binding, accessToken };
  } catch (error) {
    if (await replyRankHubError(services, ctx, error, binding)) return null;
    throw error;
  }
}

/** 带授权执行一段指令逻辑；RankHubError 统一转文案，其余异常 rethrow。 */
export async function withAuthorized(
  services: CommandServices,
  ctx: CommandContext,
  run: (auth: AuthorizedBinding) => Promise<void>,
): Promise<void> {
  const auth = await authorizeBinding(services, ctx);
  if (auth === null) return;
  try {
    await run(auth);
  } catch (error) {
    if (await replyRankHubError(services, ctx, error, auth.binding)) return;
    throw error;
  }
}

// ───────────────────────────────── 缓存读取 ────────────────────────────────

export const PROFILE_CACHE_TTL_MS = 60_000;
export const SCORE_CACHE_TTL_MS = 5 * 60_000;

/** 档案列表（60s 内存缓存，按 binding 隔离）。 */
export async function loadProfiles(
  services: CommandServices,
  binding: Binding,
  accessToken: string,
  game: string,
): Promise<GameProfile[]> {
  const cached = services.runtime.getProfiles(binding.id, game);
  if (cached !== null) return cached;
  const profiles = await timed(services, `listProfiles(${game})`, () =>
    services.rankhub.listProfiles(accessToken, game),
  );
  services.runtime.setProfiles(binding.id, game, profiles);
  return profiles;
}

/** 选 updatedAt 最新的档案（时间解析失败按 0 处理）。 */
export function pickLatestProfile(profiles: GameProfile[]): GameProfile | null {
  let picked: GameProfile | null = null;
  let pickedTime = Number.NEGATIVE_INFINITY;
  for (const profile of profiles) {
    const parsed = Date.parse(profile.updatedAt);
    const time = Number.isFinite(parsed) ? parsed : 0;
    if (time > pickedTime) {
      pickedTime = time;
      picked = profile;
    }
  }
  return picked;
}

// ───────────────────────────────── 文本格式化 ──────────────────────────────

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '未知';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const date = new Date(parsed);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : String(value);
}

export function formatAchievement(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(4)}%`;
}

/** 单条成绩的紧凑文本：曲名 [类型 难度] 达成率 → rating。 */
export function formatScore(score: GameScore): string {
  const name = score.songName ?? `#${score.songId}`;
  const difficulty = [score.type, score.level ?? score.difficulty]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
  const head = difficulty === '' ? name : `${name} [${difficulty}]`;
  const rating = score.rating === null || score.rating === undefined ? '-' : String(score.rating);
  return `${head} ${formatAchievement(score.achievements)} → ${rating}`;
}

/** 成绩桶摘要（图片渲染失败 / 文字查询共用）。 */
export function summarizeBests(game: string, bests: GameBests, perBucket = 5): string {
  const lines: string[] = [
    `${game} 成绩概览（计算于 ${formatDateTime(bests.computedAt)}）`,
  ];
  const buckets = bests.buckets.filter((bucket) => bucket.items.length > 0);
  if (buckets.length === 0) {
    lines.push('暂无成绩记录。');
    return lines.join('\n');
  }
  for (const bucket of bests.buckets) {
    const label = bucket.label ?? bucket.key;
    const total = bucket.total === null || bucket.total === undefined ? '' : `，合计 ${bucket.total}`;
    lines.push(`【${label}】${bucket.items.length} 条${total}`);
    for (const item of bucket.items.slice(0, perBucket)) {
      lines.push(`· ${formatScore(item)}`);
    }
    if (bucket.items.length > perBucket) {
      lines.push(`· … 其余 ${bucket.items.length - perBucket} 条`);
    }
  }
  return lines.join('\n');
}

/** 游戏名归一：支持常见别名；未知返回 null。 */
export function normalizeGame(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (key === '') return null;
  if (['maimai', 'mai', '舞萌', '舞萌dx', 'mdx', 'b50'].includes(key)) return 'maimai';
  if (['phigros', 'phi', '屁股肉', 'rks'].includes(key)) return 'phigros';
  return null;
}

/** 游戏别名提示（未知游戏时用）。 */
export const GAME_HINT = '可选游戏：maimai（舞萌，别名 mai）、phigros（别名 phi / 屁股肉）。';
