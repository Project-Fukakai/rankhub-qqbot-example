import { describe, expect, it } from 'vitest';

import { MessageDeduper, normalizeInboundEvent } from '../../../src/qq/index.js';

describe('normalizeInboundEvent', () => {
  it('GROUP_AT_MESSAGE_CREATE → group_at', () => {
    const event = normalizeInboundEvent('GROUP_AT_MESSAGE_CREATE', {
      id: 'msg-1',
      content: '/help',
      timestamp: '2026-10-27T04:00:00.000Z',
      group_openid: 'group-1',
      author: { id: 'author-1', member_openid: 'member-1' },
    });
    expect(event).toEqual({
      kind: 'group_at',
      messageId: 'msg-1',
      groupOpenid: 'group-1',
      userOpenid: 'member-1',
      content: '/help',
      timestamp: '2026-10-27T04:00:00.000Z',
      raw: expect.any(Object) as unknown,
    });
  });

  it('C2C_MESSAGE_CREATE → c2c（无群）', () => {
    const event = normalizeInboundEvent('C2C_MESSAGE_CREATE', {
      id: 'c2c-1',
      content: '/me',
      timestamp: 1_700_000_000,
      author: { user_openid: 'user-1' },
    });
    expect(event).toMatchObject({
      kind: 'c2c',
      messageId: 'c2c-1',
      groupOpenid: null,
      userOpenid: 'user-1',
      content: '/me',
      timestamp: '1700000000',
    });
  });

  it('非消息事件 / 缺字段返回 null', () => {
    expect(normalizeInboundEvent('READY', {})).toBeNull();
    expect(normalizeInboundEvent(null, {})).toBeNull();
    expect(normalizeInboundEvent('GROUP_AT_MESSAGE_CREATE', { id: 'x' })).toBeNull();
    expect(
      normalizeInboundEvent('GROUP_AT_MESSAGE_CREATE', {
        id: 'x',
        content: '',
        group_openid: 'g',
        author: {},
      }),
    ).toBeNull();
    expect(
      normalizeInboundEvent('C2C_MESSAGE_CREATE', { id: 'x', content: 'c', author: {} }),
    ).toBeNull();
  });

  it('content 为空串仍然保留（避免丢事件）', () => {
    const event = normalizeInboundEvent('C2C_MESSAGE_CREATE', {
      id: 'x',
      content: '',
      author: { user_openid: 'u' },
    });
    expect(event?.content).toBe('');
  });
});

describe('MessageDeduper', () => {
  it('TTL 内同一 msg_id 判重', () => {
    const deduper = new MessageDeduper();
    expect(deduper.isDuplicate('msg-1')).toBe(false);
    expect(deduper.isDuplicate('msg-1')).toBe(true);
    expect(deduper.isDuplicate('msg-2')).toBe(false);
  });

  it('TTL 过期后允许再次通过', () => {
    let now = 1_000;
    const deduper = new MessageDeduper(5 * 60_000, () => now);
    expect(deduper.isDuplicate('msg-1')).toBe(false);
    now += 5 * 60_000 + 1;
    expect(deduper.isDuplicate('msg-1')).toBe(false);
    expect(deduper.size).toBe(1);
  });
});
