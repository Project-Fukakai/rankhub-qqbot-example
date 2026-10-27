/** 被动回复窗口是 5 分钟，msg_seq 也只需要在这个窗口内保持唯一。 */
export const DEFAULT_SEQ_TTL_MS = 5 * 60_000;

/**
 * 按「入站 msg_id」分配被动回复 msg_seq。
 *
 * 官方约束：被动回复必须带 msg_id + msg_seq，且同一个 msg_id 下每个 msg_seq
 * 只能成功发送一次（重复 seq 会失败）。这里保证同一 msg_id 的 seq 从 1 开始单调递增。
 */
export class ReplySeqTracker {
  private readonly entries = new Map<string, { next: number; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_SEQ_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 分配下一个 seq（首次返回 1）。 */
  next(messageId: string): number {
    const now = this.now();
    this.prune(now);

    const entry = this.entries.get(messageId);
    if (entry === undefined) {
      this.entries.set(messageId, { next: 2, expiresAt: now + this.ttlMs });
      return 1;
    }

    const seq = entry.next;
    entry.next += 1;
    entry.expiresAt = now + this.ttlMs;
    return seq;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
