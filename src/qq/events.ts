import type { QQMessageEvent } from '../contracts/index.js';

/** 同一 msg_id 可能被重复推送，去重窗口 5 分钟。 */
export const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000;

export const GROUP_AT_MESSAGE_CREATE = 'GROUP_AT_MESSAGE_CREATE';
export const C2C_MESSAGE_CREATE = 'C2C_MESSAGE_CREATE';

/**
 * 把网关 dispatch 归一成 QQMessageEvent；非消息事件返回 null。
 *
 * 字段来源（官方 v2 文档）：
 * - GROUP_AT_MESSAGE_CREATE：d.group_openid / d.author.member_openid / d.id / d.content / d.timestamp
 * - C2C_MESSAGE_CREATE：d.author.user_openid（没有群）
 */
export function normalizeInboundEvent(
  t: string | null | undefined,
  d: unknown,
): QQMessageEvent | null {
  if (t === null || t === undefined || t === '') return null;
  if (!isRecord(d)) return null;

  switch (t) {
    case GROUP_AT_MESSAGE_CREATE: {
      const messageId = readString(d.id);
      const content = readString(d.content);
      const groupOpenid = readString(d.group_openid);
      const author = isRecord(d.author) ? d.author : null;
      const userOpenid = author === null ? null : readString(author.member_openid);
      if (messageId === null || messageId === '' || content === null) return null;
      if (groupOpenid === null || groupOpenid === '' || userOpenid === null || userOpenid === '') {
        return null;
      }
      return {
        kind: 'group_at',
        messageId,
        groupOpenid,
        userOpenid,
        content,
        timestamp: readTimestamp(d.timestamp),
        raw: d,
      };
    }

    case C2C_MESSAGE_CREATE: {
      const messageId = readString(d.id);
      const content = readString(d.content);
      const author = isRecord(d.author) ? d.author : null;
      const userOpenid = author === null ? null : readString(author.user_openid);
      if (messageId === null || messageId === '' || content === null) return null;
      if (userOpenid === null || userOpenid === '') return null;
      return {
        kind: 'c2c',
        messageId,
        groupOpenid: null,
        userOpenid,
        content,
        timestamp: readTimestamp(d.timestamp),
        raw: d,
      };
    }

    default:
      return null;
  }
}

/** msg_id 去重（TTL 内重复返回 true）。 */
export class MessageDeduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_DEDUPE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 返回 true 表示这条消息之前已经见过（应丢弃）。 */
  isDuplicate(messageId: string): boolean {
    const now = this.now();
    this.prune(now);

    const expiresAt = this.seen.get(messageId);
    if (expiresAt !== undefined && expiresAt > now) return true;

    this.seen.set(messageId, now + this.ttlMs);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readTimestamp(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}
