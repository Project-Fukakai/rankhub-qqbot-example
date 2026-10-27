/**
 * 事件分发：去重 → 解析指令 → 限并发执行 handler → 统一兜底。
 *
 * 与传输层的分工：
 * - `QQTransport` 已按 msg_id 做 5 分钟 TTL 去重，这里再加一层**进程内 TTL 兜底**
 *   （防同一 event 被上层重复投递 / 多分发器实例）；
 * - 传输层保证单条消息内顺序，dispatcher 只负责「跨消息并发 ≤ maxConcurrent」；
 * - handler 的任何异常都在这里变成一句中文兜底，**不把内部错误细节发给用户**。
 */
import type { QQMessageEvent } from '../contracts/index.js';
import type { Logger } from '../logger/index.js';

import type { CommandContext, CommandHandler, CommandServices } from '../commands/common.js';

/** 指令解析结果：首 token（已小写）+ 原始参数串。 */
export interface ParsedCommand {
  token: string;
  args: string;
}

export interface CommandRegistryLike {
  resolve(token: string): { name: string; handler: CommandHandler } | null;
}

export interface DispatcherDeps {
  services: CommandServices;
  registry: CommandRegistryLike;
  logger: Logger;
  /** 跨消息并发上限，默认 4。 */
  maxConcurrent?: number;
  /** 进程内 msg_id 去重 TTL，默认 5 分钟。 */
  dedupeTtlMs?: number;
}

export interface Dispatcher {
  handle(event: QQMessageEvent): Promise<void>;
}

export const UNKNOWN_COMMAND_TEXT =
  '未知指令。发送 /help 查看全部指令；首次使用请先发送 /bind 绑定 RankHub。';

export const INTERNAL_ERROR_TEXT = '处理指令时出错了，请稍后再试。如果持续失败，请重新 /bind。';

/** 去掉前导 `/`、`!`、`！`、`#`、`＃`、全角斜杠。 */
const LEADING_PREFIX = /^[/／!！＃#]+/u;

/** 解析 `content`：空内容返回 null（调用方回帮助提示）。 */
export function parseCommand(content: string): ParsedCommand | null {
  const stripped = content.trim().replace(LEADING_PREFIX, '').trim();
  if (stripped === '') return null;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(stripped);
  if (match === null) return null;
  const token = (match[1] ?? '').toLowerCase();
  if (token === '') return null;
  return { token, args: (match[2] ?? '').trim() };
}

/** 简单信号量：限制同时执行的指令数。 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { services, registry, logger } = deps;
  const ttlMs = deps.dedupeTtlMs ?? 5 * 60 * 1000;
  const semaphore = new Semaphore(Math.max(1, deps.maxConcurrent ?? 4));
  const seen = new Map<string, number>();
  const log = logger.child({ module: 'dispatcher' });

  function sweepSeen(now: number): void {
    if (seen.size <= 500) return;
    for (const [messageId, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(messageId);
    }
  }

  async function replySafe(event: QQMessageEvent, text: string): Promise<void> {
    try {
      await services.reply.text({ event }, text);
    } catch (error) {
      log.error('回复失败', {
        messageId: event.messageId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function runHandler(
    resolved: { name: string; handler: CommandHandler },
    ctx: CommandContext,
  ): Promise<void> {
    try {
      await resolved.handler(services, ctx);
    } catch (error) {
      // 只记日志，不把内部细节发给用户。
      ctx.logger.error('指令处理失败', {
        messageId: ctx.event.messageId,
        reason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await replySafe(ctx.event, INTERNAL_ERROR_TEXT);
    }
  }

  return {
    async handle(event: QQMessageEvent): Promise<void> {
      const now = services.now();
      sweepSeen(now);

      const expiresAt = seen.get(event.messageId);
      if (expiresAt !== undefined && expiresAt > now) {
        log.debug('进程内去重命中，忽略重复事件', { messageId: event.messageId });
        return;
      }
      seen.set(event.messageId, now + ttlMs);

      // 解析、未知指令提示与 handler 执行都进 semaphore：跨消息并发严格 ≤ maxConcurrent。
      await semaphore.run(async () => {
        const parsed = parseCommand(event.content);
        if (parsed === null) {
          log.debug('空内容，回帮助提示', { messageId: event.messageId });
          await replySafe(event, UNKNOWN_COMMAND_TEXT);
          return;
        }

        const resolved = registry.resolve(parsed.token);
        if (resolved === null) {
          log.debug('未知指令', { messageId: event.messageId, token: parsed.token });
          await replySafe(event, UNKNOWN_COMMAND_TEXT);
          return;
        }

        const ctx: CommandContext = {
          event,
          args: parsed.args,
          command: resolved.name,
          logger: log.child({ command: resolved.name, messageId: event.messageId }),
        };

        // 单条消息内天然串行（一个事件一个 handler），跨消息靠上面的 semaphore 限并发。
        await runHandler(resolved, ctx);
      });
    },
  };
}
