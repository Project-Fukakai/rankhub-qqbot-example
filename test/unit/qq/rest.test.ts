import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SHARD_THRESHOLD_BYTES,
  QQRESTClient,
  QQApiError,
  type QQRestOptions,
} from '../../../src/qq/index.js';
import { FakeQQServer, type FakeQQServerOptions } from '../../fakes/qq/index.js';
import { jsonResponse, testLogger } from './helpers.js';

const servers: FakeQQServer[] = [];

function md5Hex(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

async function startServer(options: FakeQQServerOptions = {}) {
  const server = await new FakeQQServer(options).start();
  servers.push(server);
  return server;
}

function createRest(server: FakeQQServer, overrides: Partial<QQRestOptions> = {}) {
  const tokenState = { invalidations: 0 };
  const rest = new QQRESTClient({
    apiBase: server.apiBase,
    tokenProvider: {
      get: async () => 'fake-access-token',
      invalidate: () => {
        tokenState.invalidations += 1;
      },
    },
    logger: testLogger,
    ...overrides,
  });
  return { rest, tokenState };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe('QQRESTClient 文本', () => {
  it('群消息：路径 /v2/groups/{openid}/messages + msg_type=0 + msg_id/msg_seq', async () => {
    const server = await startServer();
    const { rest } = createRest(server);

    const ack = await rest.sendText(
      { kind: 'group', openid: 'group-openid-1' },
      { content: '你好', messageId: 'msg-1', messageSeq: 1 },
    );

    expect(ack.id).toBeTypeOf('string');
    expect(server.messageRequests).toHaveLength(1);
    const message = server.messageRequests[0];
    expect(message).toMatchObject({
      targetKind: 'group',
      targetOpenid: 'group-openid-1',
      authorization: 'QQBot fake-access-token',
    });
    expect(message?.body).toEqual({
      content: '你好',
      msg_type: 0,
      msg_id: 'msg-1',
      msg_seq: 1,
    });
    expect(server.requests.some((request) => request.path === '/v2/groups/group-openid-1/messages')).toBe(
      true,
    );
  });

  it('单聊消息：路径 /v2/users/{openid}/messages', async () => {
    const server = await startServer();
    const { rest } = createRest(server);

    await rest.sendText(
      { kind: 'c2c', openid: 'user-openid-2' },
      { content: 'hi', messageId: 'msg-2', messageSeq: 3 },
    );

    expect(server.messageRequests[0]).toMatchObject({
      targetKind: 'c2c',
      targetOpenid: 'user-openid-2',
    });
    expect(server.requests.some((request) => request.path === '/v2/users/user-openid-2/messages')).toBe(
      true,
    );
  });
});

describe('QQRESTClient 图片', () => {
  const png = Buffer.from('fake-png-bytes');

  it('先上传 file（base64 file_data），再发 msg_type=7', async () => {
    const server = await startServer({ uploadFileInfo: 'file-info-abc' });
    const { rest } = createRest(server);

    await rest.sendImage(
      { kind: 'group', openid: 'group-openid-1' },
      { buffer: png, filename: 'b50.png', messageId: 'msg-1', messageSeq: 2 },
    );

    expect(server.fileUploads).toHaveLength(1);
    expect(server.fileUploads[0]?.body).toEqual({
      file_type: 1,
      file_name: 'b50.png',
      srv_send_msg: false,
      file_data: png.toString('base64'),
    });

    expect(server.messageRequests).toHaveLength(1);
    expect(server.messageRequests[0]?.body).toEqual({
      msg_type: 7,
      media: { file_info: 'file-info-abc' },
      msg_id: 'msg-1',
      msg_seq: 2,
    });
  });

  it('fileDataEncoding=binary 时走 multipart/form-data', async () => {
    const server = await startServer({ uploadFileInfo: 'file-info-bin' });
    const { rest } = createRest(server, { fileDataEncoding: 'binary' });

    await rest.sendImage(
      { kind: 'c2c', openid: 'user-openid-2' },
      { buffer: png, filename: 'rks.png', messageId: 'msg-2', messageSeq: 1 },
    );

    const upload = server.fileUploads[0];
    expect(upload?.contentType?.startsWith('multipart/form-data')).toBe(true);
    expect(upload?.rawBytes).toBeGreaterThan(png.length);
    expect(server.messageRequests[0]?.body.media).toEqual({ file_info: 'file-info-bin' });
  });

  it('空图片直接报错，不发请求', async () => {
    const server = await startServer();
    const { rest } = createRest(server);

    await expect(
      rest.sendImage(
        { kind: 'group', openid: 'g' },
        { buffer: Buffer.alloc(0), filename: 'x.png', messageId: 'm', messageSeq: 1 },
      ),
    ).rejects.toThrow(/图片内容为空/);
    expect(server.requests).toHaveLength(0);
  });

  it('超过阈值走分片上传：prepare → 逐片 PUT → 每片 part_finish → 带 upload_id 合并', async () => {
    const server = await startServer({ shardBlockSize: 100, uploadFileInfo: 'file-info-merged' });
    const { rest } = createRest(server, { shardThresholdBytes: 100 });

    const buffer = Buffer.alloc(250, 7);
    await rest.sendImage(
      { kind: 'group', openid: 'group-openid-1' },
      { buffer, filename: 'big.png', messageId: 'msg-9', messageSeq: 1 },
    );

    // 1. prepare：官方字段（file_size / block_size 是字符串，含 md5_10m）
    expect(server.prepares).toHaveLength(1);
    expect(server.prepares[0]).toEqual({
      file_type: 1,
      file_size: '250',
      file_name: 'big.png',
      md5: md5Hex(buffer),
      sha1: createHash('sha1').update(buffer).digest('hex'),
      md5_10m: md5Hex(buffer.subarray(0, 10_002_432)),
    });

    // 官方路径：/v2/groups/{group_id}/upload_prepare（与 /files 同级，不是 /files/upload_prepare）
    expect(
      server.requests.some((request) => request.path === '/v2/groups/group-openid-1/upload_prepare'),
    ).toBe(true);
    expect(server.requests.some((request) => request.path.includes('/files/upload_prepare'))).toBe(
      false,
    );

    // 2. 逐片 PUT：分片大小以 parts[].block_size 为准 → 100 + 100 + 50，且不带 Authorization
    expect(server.partPuts.map((part) => part.index).sort((left, right) => left - right)).toEqual([
      0, 1, 2,
    ]);
    expect(server.partPuts.map((part) => part.bytes).sort((left, right) => left - right)).toEqual([
      50, 100, 100,
    ]);
    expect(server.partPuts.every((part) => part.authorization === undefined)).toBe(true);

    // 3. 每片 PUT 成功后各调一次 part_finish（part_index / block_size 字符串 / 该片 md5）
    expect(server.partFinishes).toHaveLength(3);
    const finishes = [...server.partFinishes].sort(
      (left, right) => Number(left.part_index) - Number(right.part_index),
    );
    expect(finishes).toEqual([
      {
        upload_id: 'upload-1',
        part_index: 0,
        block_size: '100',
        md5: md5Hex(buffer.subarray(0, 100)),
      },
      {
        upload_id: 'upload-1',
        part_index: 1,
        block_size: '100',
        md5: md5Hex(buffer.subarray(100, 200)),
      },
      {
        upload_id: 'upload-1',
        part_index: 2,
        block_size: '50',
        md5: md5Hex(buffer.subarray(200, 250)),
      },
    ]);

    // 4. 合并体只有 file_type / file_name / upload_id / srv_send_msg=false
    expect(server.fileMerges).toHaveLength(1);
    expect(server.fileMerges[0]).toEqual({
      file_type: 1,
      file_name: 'big.png',
      upload_id: 'upload-1',
      srv_send_msg: false,
    });

    expect(server.messageRequests[0]?.body).toMatchObject({
      msg_type: 7,
      media: { file_info: 'file-info-merged' },
    });
  });

  it('分片 PUT 失败时按 upload_config.retry_delay 重试', async () => {
    const server = await startServer({ shardBlockSize: 100, failFirstPartPut: true });
    const { rest } = createRest(server, { shardThresholdBytes: 100 });

    const buffer = Buffer.alloc(150, 3);
    await rest.sendImage(
      { kind: 'group', openid: 'group-openid-1' },
      { buffer, filename: 'retry.png', messageId: 'msg-10', messageSeq: 1 },
    );

    // 2 个分片 + 第 1 次 PUT 的失败尝试 = 3 次请求；成功的 2 片各一次 part_finish。
    expect(server.partPuts).toHaveLength(3);
    expect(server.partPuts.filter((part) => part.index === 0)).toHaveLength(2);
    expect(server.partFinishes).toHaveLength(2);
    expect(server.messageRequests).toHaveLength(1);
  });

  it('默认阈值是 4.5MB', () => {
    expect(DEFAULT_SHARD_THRESHOLD_BYTES).toBe(4_718_592);
  });
});

describe('QQRESTClient 错误处理', () => {
  it('401 时 invalidate token 并重试一次', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    let attempt = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ headers });
      if (attempt === 1) return jsonResponse({ code: 401, message: 'unauthorized' }, 401);
      return jsonResponse({ id: 'out-1', timestamp: '2026-10-27T00:00:00Z' });
    }) as unknown as typeof fetch;

    const invalidations: number[] = [];
    const rest = new QQRESTClient({
      apiBase: 'http://127.0.0.1:1',
      tokenProvider: {
        get: async () => 'tok-1',
        invalidate: () => {
          invalidations.push(1);
        },
      },
      logger: testLogger,
      fetchImpl,
    });

    const ack = await rest.sendText(
      { kind: 'group', openid: 'g' },
      { content: 'hi', messageId: 'm', messageSeq: 1 },
    );

    expect(attempt).toBe(2);
    expect(invalidations).toHaveLength(1);
    expect(ack.id).toBe('out-1');
    expect(calls.every((call) => call.headers.authorization === 'QQBot tok-1')).toBe(true);
  });

  it('HTTP 200 + body.code 视为业务错误', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ code: 11244, message: 'msg limit exceeded' })) as unknown as typeof fetch;

    const rest = new QQRESTClient({
      apiBase: 'http://127.0.0.1:1',
      tokenProvider: { get: async () => 'tok', invalidate: () => {} },
      logger: testLogger,
      fetchImpl,
    });

    const error = await rest
      .sendText({ kind: 'group', openid: 'g' }, { content: 'hi', messageId: 'm', messageSeq: 1 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QQApiError);
    expect((error as QQApiError).code).toBe(11244);
    expect((error as QQApiError).message).toContain('msg limit exceeded');
  });

  it('上传响应缺 file_info 时报错', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ file_uuid: 'u' })) as unknown as typeof fetch;

    const rest = new QQRESTClient({
      apiBase: 'http://127.0.0.1:1',
      tokenProvider: { get: async () => 'tok', invalidate: () => {} },
      logger: testLogger,
      fetchImpl,
    });

    await expect(
      rest.uploadFile({ kind: 'group', openid: 'g' }, { buffer: Buffer.from('x'), filename: 'x.png' }),
    ).rejects.toThrow(/file_info/);
  });
});
