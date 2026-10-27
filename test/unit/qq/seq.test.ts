import { describe, expect, it } from 'vitest';

import { ReplySeqTracker } from '../../../src/qq/index.js';

describe('ReplySeqTracker', () => {
  it('同一 msg_id 的 seq 从 1 单调递增', () => {
    const tracker = new ReplySeqTracker();
    expect(tracker.next('msg-a')).toBe(1);
    expect(tracker.next('msg-a')).toBe(2);
    expect(tracker.next('msg-a')).toBe(3);
  });

  it('不同 msg_id 各自从 1 开始', () => {
    const tracker = new ReplySeqTracker();
    expect(tracker.next('msg-a')).toBe(1);
    expect(tracker.next('msg-b')).toBe(1);
    expect(tracker.next('msg-a')).toBe(2);
  });

  it('TTL 过期后重新从 1 开始', () => {
    let now = 1_000;
    const tracker = new ReplySeqTracker(100, () => now);
    expect(tracker.next('msg-a')).toBe(1);
    now += 50;
    expect(tracker.next('msg-a')).toBe(2);

    now += 200;
    expect(tracker.next('msg-a')).toBe(1);
  });

  it('过期条目会被清理，不无限增长', () => {
    let now = 0;
    const tracker = new ReplySeqTracker(100, () => now);
    tracker.next('msg-a');
    tracker.next('msg-b');
    expect(tracker.size).toBe(2);
    now = 1_000;
    tracker.next('msg-c');
    expect(tracker.size).toBe(1);
  });
});
