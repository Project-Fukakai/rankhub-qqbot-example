import { describe, expect, it } from 'vitest';

import { formatTimeAgo, formatTimeAgoCompact } from '../../../src/util/timeago.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('formatTimeAgo', () => {
  it('按量级输出中文单位', () => {
    expect(formatTimeAgo(NOW - 5_000, NOW)).toBe('5 秒前');
    expect(formatTimeAgo(NOW - 3 * 60_000, NOW)).toBe('3 分钟前');
    expect(formatTimeAgo(NOW - 5 * 3_600_000, NOW)).toBe('5 小时前');
    expect(formatTimeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 天前');
    expect(formatTimeAgo(NOW - 65 * 86_400_000, NOW)).toBe('2 个月前');
    expect(formatTimeAgo(NOW - 400 * 86_400_000, NOW)).toBe('1 年前');
  });

  it('接受 ISO 串 / 秒级时间戳 / Date', () => {
    expect(formatTimeAgo('2026-10-24T12:00:00Z', NOW)).toBe('3 天前');
    expect(formatTimeAgo(Math.floor((NOW - 3_600_000) / 1000), NOW)).toBe('1 小时前');
    expect(formatTimeAgo(new Date(NOW - 86_400_000), NOW)).toBe('1 天前');
  });

  it('未来时间显示刚刚，无法解析返回 null', () => {
    expect(formatTimeAgo(NOW + 10_000, NOW)).toBe('刚刚');
    expect(formatTimeAgo('not-a-date', NOW)).toBeNull();
    expect(formatTimeAgo(null, NOW)).toBeNull();
    expect(formatTimeAgo(0, NOW)).toBeNull();
  });
});

describe('formatTimeAgoCompact', () => {
  it('输出紧凑英文单位', () => {
    expect(formatTimeAgoCompact(NOW - 5_000, NOW)).toBe('5s');
    expect(formatTimeAgoCompact(NOW - 3 * 60_000, NOW)).toBe('3m');
    expect(formatTimeAgoCompact(NOW - 5 * 3_600_000, NOW)).toBe('5h');
    expect(formatTimeAgoCompact(NOW - 3 * 86_400_000, NOW)).toBe('3d');
    expect(formatTimeAgoCompact(NOW - 65 * 86_400_000, NOW)).toBe('2mo');
    expect(formatTimeAgoCompact(NOW - 400 * 86_400_000, NOW)).toBe('1y');
    expect(formatTimeAgoCompact(NOW + 1, NOW)).toBe('0s');
  });
});
