/**
 * 假 QQ 官方机器人服务器：同一端口提供 REST 与 WebSocket 网关。
 *
 * 只用于单测/联调，绝不访问真实 QQ。行为由 FakeQQServerOptions 控制，
 * 记录所有请求以便断言（token 请求、消息体、图片上传、分片 PUT、Identify/Resume/心跳）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { FakeWebSocketServer, type FakeWebSocketConnection } from './ws-server.js';

export interface FakeQQTokensOptions {
  accessToken?: string;
  /** 官方实测返回字符串 "7200"，这里默认保持字符串以覆盖解析分支。 */
  expiresIn?: number | string;
  /** 模拟业务错误：HTTP 200 + body.code。 */
  businessError?: { code: number; message: string } | null;
  /** 模拟 HTTP 层错误（例如 500）。 */
  httpStatus?: number;
  /** 失败次数；不设置时，只要配置了错误就始终失败。 */
  failTimes?: number;
}

export interface FakeQQServerOptions {
  tokens?: FakeQQTokensOptions;
  /** 'root' 时 /gateway/bot 返回 404，用于覆盖回退 /gateway 的分支。 */
  gatewayPath?: 'bot' | 'root';
  heartbeatIntervalMs?: number;
  /** 'silent' = 只发 Hello 不发 READY，用于覆盖 READY 超时。 */
  readyPolicy?: 'ready' | 'silent';
  readyDelayMs?: number;
  /** 收到 op6 Resume 后的行为。 */
  resumePolicy?: 'resumed' | 'silent';
  sessionId?: string;
  botId?: string;
  botUsername?: string;
  uploadFileInfo?: string;
  shardBlockSize?: number;
  shardConcurrency?: number;
  /** 第一次分片 PUT 注入 500，用于覆盖重试分支。 */
  failFirstPartPut?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  body: unknown;
}

export interface RecordedMessage {
  targetKind: 'group' | 'c2c';
  targetOpenid: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export interface RecordedFileUpload {
  targetKind: 'group' | 'c2c';
  targetOpenid: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
  contentType: string | undefined;
  rawBytes: number;
}

export interface RecordedPartPut {
  index: number;
  uploadId: string;
  bytes: number;
  contentType: string | undefined;
  authorization: string | undefined;
}

export class FakeQQServer {
  readonly requests: RecordedRequest[] = [];
  readonly tokenRequests: RecordedRequest[] = [];
  readonly messageRequests: RecordedMessage[] = [];
  readonly fileUploads: RecordedFileUpload[] = [];
  readonly fileMerges: Record<string, unknown>[] = [];
  readonly prepares: Record<string, unknown>[] = [];
  readonly partFinishes: Record<string, unknown>[] = [];
  readonly partPuts: RecordedPartPut[] = [];

  readonly gatewayConnections: FakeWebSocketConnection[] = [];
  readonly identifies: Array<Record<string, unknown>> = [];
  readonly resumes: Array<Record<string, unknown>> = [];
  readonly heartbeats: Array<{ op: number; d: unknown }> = [];

  private httpServer: http.Server | null = null;
  private readonly wsServer = new FakeWebSocketServer();
  private port = 0;
  private seq = 0;
  private messageCounter = 0;
  private failedFirstPartPut = false;
  private tokenFailuresLeft: number;
  private readonly options: FakeQQServerOptions;

  constructor(options: FakeQQServerOptions = {}) {
    this.options = options;
    const tokens = options.tokens ?? {};
    const hasFailure = tokens.businessError != null || tokens.httpStatus !== undefined;
    this.tokenFailuresLeft = tokens.failTimes ?? (hasFailure ? Number.POSITIVE_INFINITY : 0);
  }

  get apiBase(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        this.sendJson(response, 500, {
          code: 500,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
    this.httpServer = server;
    this.wsServer.attach(server);
    this.wsServer.onConnection((connection) => {
      this.gatewayConnections.push(connection);
      this.setupGatewayConnection(connection);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    this.port = address.port;
    return this;
  }

  async stop(): Promise<void> {
    for (const connection of this.wsServer.connections) {
      if (!connection.isClosed) connection.sendClose(1001, 'test stop');
    }
    await new Promise<void>((resolve) => {
      const server = this.httpServer;
      if (server === null) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    this.httpServer = null;
  }

  waitForConnectionCount(count: number, timeoutMs = 3_000): Promise<void> {
    return this.wsServer.waitForConnectionCount(count, timeoutMs);
  }

  /** 关闭当前所有网关连接（模拟断线，触发客户端重连/Resume）。 */
  closeGatewayConnections(): void {
    for (const connection of this.gatewayConnections) {
      if (!connection.isClosed) connection.destroy();
    }
  }

  /** 向所有网关连接推一个 dispatch 事件。 */
  emitDispatch(t: string, d: unknown): void {
    this.sendGateway({ op: 0, s: this.nextSeq(), t, d });
  }

  emitGroupAt(
    content: string,
    overrides: { messageId?: string; groupOpenid?: string; userOpenid?: string; timestamp?: string } = {},
  ): Record<string, unknown> {
    this.messageCounter += 1;
    const d: Record<string, unknown> = {
      id: overrides.messageId ?? `msg-${this.messageCounter}`,
      content,
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      group_openid: overrides.groupOpenid ?? 'group-openid-1',
      author: {
        id: 'author-id-1',
        member_openid: overrides.userOpenid ?? 'user-openid-1',
      },
    };
    this.emitDispatch('GROUP_AT_MESSAGE_CREATE', d);
    return d;
  }

  emitC2C(
    content: string,
    overrides: { messageId?: string; userOpenid?: string; timestamp?: string } = {},
  ): Record<string, unknown> {
    this.messageCounter += 1;
    const d: Record<string, unknown> = {
      id: overrides.messageId ?? `c2c-${this.messageCounter}`,
      content,
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      author: { id: 'author-id-1', user_openid: overrides.userOpenid ?? 'user-openid-2' },
    };
    this.emitDispatch('C2C_MESSAGE_CREATE', d);
    return d;
  }

  /** 直接发送任意网关 payload（例如 op7 / op9）。 */
  sendGateway(payload: unknown): void {
    for (const connection of this.gatewayConnections) {
      if (!connection.isClosed) connection.sendJson(payload);
    }
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private setupGatewayConnection(connection: FakeWebSocketConnection): void {
    connection.sendJson({
      op: 10,
      d: { heartbeat_interval: this.options.heartbeatIntervalMs ?? 40 },
    });

    connection.onJson((payload) => {
      if (!isRecord(payload)) return;
      const op = payload.op;

      if (op === 2) {
        this.identifies.push(payload);
        if ((this.options.readyPolicy ?? 'ready') === 'ready') {
          const sendReady = (): void => {
            if (connection.isClosed) return;
            connection.sendJson(this.readyPayload());
          };
          const delayMs = this.options.readyDelayMs ?? 0;
          if (delayMs > 0) setTimeout(sendReady, delayMs);
          else sendReady();
        }
        return;
      }

      if (op === 6) {
        this.resumes.push(payload);
        if ((this.options.resumePolicy ?? 'resumed') === 'resumed') {
          connection.sendJson({ op: 0, s: this.nextSeq(), t: 'RESUMED', d: {} });
        }
        return;
      }

      if (op === 1) {
        this.heartbeats.push({ op, d: payload.d });
        connection.sendJson({ op: 11 });
      }
    });
  }

  private readyPayload(): Record<string, unknown> {
    return {
      op: 0,
      s: this.nextSeq(),
      t: 'READY',
      d: {
        session_id: this.options.sessionId ?? 'session-1',
        user: {
          id: this.options.botId ?? 'bot-id',
          username: this.options.botUsername ?? 'RankHub 小助手',
        },
        shard: [0, 1],
      },
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    const rawBody = await readBody(request);
    const contentType = firstHeader(request.headers['content-type']);

    const record: RecordedRequest = {
      method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
      rawBody,
      body: parseBody(rawBody, contentType),
    };
    this.requests.push(record);

    if (method === 'POST' && path === '/app/getAppAccessToken') {
      this.tokenRequests.push(record);
      this.handleToken(response);
      return;
    }

    if (method === 'GET' && (path === '/gateway/bot' || path === '/gateway')) {
      if (path === '/gateway/bot' && this.options.gatewayPath === 'root') {
        this.sendJson(response, 404, { code: 404, message: 'not found' });
        return;
      }
      const authorization = firstHeader(request.headers.authorization);
      if (authorization === undefined || !authorization.startsWith('QQBot ')) {
        this.sendJson(response, 401, { code: 401, message: 'unauthorized' });
        return;
      }
      this.sendJson(response, 200, { url: `${this.wsUrl}/websocket`, shards: 1 });
      return;
    }

    const target = matchTarget(path);
    if (target !== null && method === 'POST' && path.endsWith('/messages')) {
      const authorization = firstHeader(request.headers.authorization);
      this.messageRequests.push({
        targetKind: target.kind,
        targetOpenid: target.openid,
        authorization,
        body: isRecord(record.body) ? record.body : {},
      });
      this.messageCounter += 1;
      this.sendJson(response, 200, {
        id: `out-${this.messageCounter}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (target !== null && method === 'POST' && path.endsWith('/upload_prepare')) {
      const body = isRecord(record.body) ? record.body : {};
      this.prepares.push(body);
      this.sendJson(response, 200, this.buildPrepareResponse(body));
      return;
    }

    if (target !== null && method === 'POST' && path.endsWith('/upload_part_finish')) {
      const body = isRecord(record.body) ? record.body : {};
      this.partFinishes.push(body);
      // 官方：part_finish 返回空对象，不返回 file_info（file_info 由 /files 合并返回）。
      this.sendJson(response, 200, {});
      return;
    }

    if (target !== null && method === 'POST' && path.endsWith('/files')) {
      const authorization = firstHeader(request.headers.authorization);
      const body = isRecord(record.body) ? record.body : null;
      this.fileUploads.push({
        targetKind: target.kind,
        targetOpenid: target.openid,
        authorization,
        body,
        contentType,
        rawBytes: rawBody.length,
      });

      if (body !== null && typeof body.upload_id === 'string' && body.upload_id !== '') {
        this.fileMerges.push(body);
      }

      this.sendJson(response, 200, {
        file_info: this.options.uploadFileInfo ?? 'fake-file-info',
        ttl: 3600,
      });
      return;
    }

    if (method === 'PUT' && path === '/upload/part') {
      const authorization = firstHeader(request.headers.authorization);
      this.partPuts.push({
        index: Number(url.searchParams.get('index') ?? '0'),
        uploadId: url.searchParams.get('upload_id') ?? '',
        bytes: rawBody.length,
        contentType,
        authorization,
      });
      if (this.options.failFirstPartPut === true && !this.failedFirstPartPut) {
        this.failedFirstPartPut = true;
        this.sendJson(response, 500, { code: 500, message: 'injected part failure' });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }

    this.sendJson(response, 404, { code: 404, message: `unknown route ${method} ${path}` });
  }

  private handleToken(response: ServerResponse): void {
    const tokens = this.options.tokens ?? {};

    if (this.tokenFailuresLeft > 0) {
      this.tokenFailuresLeft -= 1;
      if (tokens.httpStatus !== undefined) {
        this.sendJson(response, tokens.httpStatus, { code: tokens.httpStatus, message: 'token http error' });
        return;
      }
      if (tokens.businessError != null) {
        // 官方行为：HTTP 200 + body.code。
        this.sendJson(response, 200, {
          code: tokens.businessError.code,
          message: tokens.businessError.message,
        });
        return;
      }
    }

    this.sendJson(response, 200, {
      access_token: tokens.accessToken ?? 'fake-access-token',
      expires_in: tokens.expiresIn ?? '7200',
    });
  }

  private buildPrepareResponse(body: Record<string, unknown>): Record<string, unknown> {
    const fileSize = toInteger(body.file_size);
    const blockSize = this.options.shardBlockSize ?? 1024;
    const partCount = Math.max(1, Math.ceil(fileSize / blockSize));
    const uploadId = 'upload-1';
    const parts = Array.from({ length: partCount }, (_value, index) => {
      const start = index * blockSize;
      const size = Math.min(blockSize, fileSize - start);
      return {
        index,
        presigned_url: `${this.apiBase}/upload/part?upload_id=${uploadId}&index=${index}`,
        block_size: String(size),
      };
    });
    return {
      upload_id: uploadId,
      // 官方：block_size 是字符串，默认 5MB；分片大小以 parts[].block_size 为准。
      block_size: String(blockSize),
      parts,
      upload_config: {
        concurrency: this.options.shardConcurrency ?? 2,
        retry_timeout: 5,
        retry_delay: 0,
      },
    };
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded) return;
    const text = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    response.end(text);
  }
}

function matchTarget(path: string): { kind: 'group' | 'c2c'; openid: string } | null {
  const match = /^\/v2\/(groups|users)\/([^/]+)\//.exec(path);
  if (match === null) return null;
  const kind = match[1] === 'groups' ? 'group' : 'c2c';
  return { kind, openid: decodeURIComponent(match[2] as string) };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return null;
  if (contentType !== undefined && contentType.startsWith('multipart/form-data')) {
    return { multipart: true, bytes: raw.length };
  }
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
