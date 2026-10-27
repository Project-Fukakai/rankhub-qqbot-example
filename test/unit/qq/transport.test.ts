import { afterEach, describe, expect, it } from 'vitest';

import type { QQMessageEvent, QQTransport } from '../../../src/contracts/index.js';
import { createQQTransport, type QQTransportOptions } from '../../../src/qq/index.js';
import { FakeQQServer, type FakeQQServerOptions } from '../../fakes/qq/index.js';
import { sleep, testLogger, transportConfig, waitUntil } from './helpers.js';

const servers: FakeQQServer[] = [];
const transports: QQTransport[] = [];

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function setup(
  serverOptions: FakeQQServerOptions = {},
  transportOverrides: Partial<QQTransportOptions> = {},
): Promise<{ server: FakeQQServer; transport: QQTransport; events: QQMessageEvent[] }> {
  const server = await new FakeQQServer(serverOptions).start();
  servers.push(server);
  const events: QQMessageEvent[] = [];
  const transport = createQQTransport({
    config: transportConfig(server.apiBase),
    logger: testLogger,
    ...transportOverrides,
  });
  transports.push(transport);
  return { server, transport, events };
}

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0)) await server.stop();
});

describe('QQTransport 群@ 消息', () => {
  it('收到群@事件后回复文本：正确路径、Authorization、msg_id/msg_seq', async () => {
    const { server, transport, events } = await setup();
    await transport.start(async (event) => {
      events.push(event);
      await transport.replyText({ event }, '你好，RankHub');
    });

    const dispatch = server.emitGroupAt('/help');
    await waitUntil(() => server.messageRequests.length === 1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'group_at',
      messageId: dispatch.id,
      groupOpenid: 'group-openid-1',
      userOpenid: 'user-openid-1',
      content: '/help',
      timestamp: dispatch.timestamp,
    });

    const message = server.messageRequests[0];
    expect(message?.authorization).toBe('QQBot fake-access-token');
    expect(message?.body).toEqual({
      content: '你好，RankHub',
      msg_type: 0,
      msg_id: dispatch.id,
      msg_seq: 1,
      message_reference: { message_id: 'REFIDX_' + dispatch.id + '==' },
    });
    expect(
      server.requests.some((request) => request.path === '/v2/groups/group-openid-1/messages'),
    ).toBe(true);
  });

  it('content 为空串也归一为事件（不丢事件）', async () => {
    const { server, transport, events } = await setup();
    await transport.start(async (event) => {
      events.push(event);
    });

    server.emitGroupAt('');
    await waitUntil(() => events.length === 1);
    expect(events[0]?.content).toBe('');
  });

  it('单聊事件走 /v2/users/{openid}/messages', async () => {
    const { server, transport, events } = await setup();
    await transport.start(async (event) => {
      events.push(event);
      await transport.replyText({ event }, 'pong');
    });

    server.emitC2C('/me');
    await waitUntil(() => server.messageRequests.length === 1);

    expect(events[0]).toMatchObject({
      kind: 'c2c',
      groupOpenid: null,
      userOpenid: 'user-openid-2',
    });
    expect(
      server.requests.some((request) => request.path === '/v2/users/user-openid-2/messages'),
    ).toBe(true);
    expect(server.messageRequests[0]?.body.msg_seq).toBe(1);
  });
});

describe('QQTransport msg_seq', () => {
  it('同一 msg_id 的多次回复 seq 从 1 递增', async () => {
    const { server, transport, events } = await setup();
    await transport.start(async (event) => {
      events.push(event);
      await transport.replyText({ event }, '第一条');
      await transport.replyText({ event }, '第二条');
    });

    const dispatch = server.emitGroupAt('/help');
    await waitUntil(() => server.messageRequests.length === 2);

    expect(server.messageRequests.map((message) => message.body.msg_seq)).toEqual([1, 2]);
    expect(server.messageRequests.map((message) => message.body.msg_id)).toEqual([
      dispatch.id,
      dispatch.id,
    ]);

    // 同一 msg_id 继续回复，seq 接着递增。
    await transport.replyText({ event: events[0] as QQMessageEvent }, '第三条');
    await waitUntil(() => server.messageRequests.length === 3);
    expect(server.messageRequests[2]?.body.msg_seq).toBe(3);
  });

  it('不同 msg_id 各自从 1 开始', async () => {
    const { server, transport, events } = await setup();
    await transport.start(async (event) => {
      events.push(event);
      await transport.replyText({ event }, 'ok');
    });

    server.emitGroupAt('a');
    await waitUntil(() => events.length === 1);
    server.emitGroupAt('b');
    await waitUntil(() => server.messageRequests.length === 2);

    expect(server.messageRequests.map((message) => message.body.msg_seq)).toEqual([1, 1]);
    expect(new Set(server.messageRequests.map((message) => message.body.msg_id)).size).toBe(2);
  });

  it('超长文本按 1500 字符切分，逐段递增 seq', async () => {
    const { server, transport } = await setup();
    const longText = 'a'.repeat(3200);
    await transport.start(async (event) => {
      await transport.replyText({ event }, longText);
    });

    server.emitGroupAt('long');
    await waitUntil(() => server.messageRequests.length === 3);

    expect(server.messageRequests.map((message) => (message.body.content as string).length)).toEqual([
      1500, 1500, 200,
    ]);
    expect(server.messageRequests.map((message) => message.body.msg_seq)).toEqual([1, 2, 3]);
    expect(server.messageRequests.map((message) => message.body.content).join('')).toBe(longText);
  });
});

describe('QQTransport 图片', () => {
  it('回复图片：先上传再发 msg_type=7，图片也占用 msg_seq', async () => {
    const { server, transport } = await setup({ uploadFileInfo: 'file-info-1' });
    await transport.start(async (event) => {
      await transport.replyImage({ event }, PNG, 'b50.png');
      await transport.replyText({ event }, '成绩单');
    });

    const dispatch = server.emitGroupAt('/b50');
    await waitUntil(() => server.messageRequests.length === 2);

    expect(server.fileUploads).toHaveLength(1);
    expect(server.fileUploads[0]?.body).toMatchObject({
      file_type: 1,
      file_name: 'b50.png',
      srv_send_msg: false,
      file_data: PNG.toString('base64'),
    });

    expect(server.messageRequests[0]?.body).toEqual({
      msg_type: 7,
      media: { file_info: 'file-info-1' },
      msg_id: dispatch.id,
      msg_seq: 1,
      message_reference: { message_id: 'REFIDX_' + dispatch.id + '==' },
    });
    expect(server.messageRequests[1]?.body).toMatchObject({ msg_type: 0, msg_seq: 2 });
  });

  it('完整链路：收到群@ → 回复文本 → 回复图片', async () => {
    const { server, transport } = await setup({ uploadFileInfo: 'file-info-e2e' });
    await transport.start(async (event) => {
      await transport.replyText({ event }, '正在生成图片…');
      await transport.replyImage({ event }, PNG, 'rankhub.png');
    });

    const dispatch = server.emitGroupAt('/b50 测试');
    await waitUntil(() => server.messageRequests.length === 2);

    expect(server.messageRequests.map((message) => message.body.msg_type)).toEqual([0, 7]);
    expect(server.messageRequests.map((message) => message.body.msg_seq)).toEqual([1, 2]);
    expect(server.messageRequests.every((message) => message.body.msg_id === dispatch.id)).toBe(true);
    expect(server.fileUploads).toHaveLength(1);
    expect(server.messageRequests[1]?.body.media).toEqual({ file_info: 'file-info-e2e' });
  });
});

describe('QQTransport 去重', () => {
  it('同一 msg_id 重复推送只回调一次', async () => {
    const { server, transport, events } = await setup();
    await transport.start(async (event) => {
      events.push(event);
    });

    server.emitGroupAt('dup-a', { messageId: 'same-id' });
    server.emitGroupAt('dup-b', { messageId: 'same-id' });
    await waitUntil(() => events.length === 1);
    await sleep(120);

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('dup-a');

    // 不同 msg_id 正常回调。
    server.emitGroupAt('fresh', { messageId: 'other-id' });
    await waitUntil(() => events.length === 2);
  });
});

describe('QQTransport 启动', () => {
  it('READY 后暴露机器人身份', async () => {
    const { transport } = await setup();
    await transport.start(async () => {});
    expect(transport.identity()).toEqual({ id: 'bot-id', username: 'RankHub 小助手' });
  });

  it('AccessToken 业务错误会导致 start 失败（错误信息带 code）', async () => {
    const { transport } = await setup(
      { tokens: { businessError: { code: 100016, message: 'appid or secret is invalid' } } },
      { readyTimeoutMs: 250 },
    );

    const error = await transport.start(async () => {}).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/READY 超时/);
    expect((error as Error).message).toContain('100016');
  });
});
