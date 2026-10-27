import type { QQIdentity, QQMessageEvent, QQTransport, ReplyContext } from '../contracts/index.js';
import type { Logger } from '../logger/index.js';
import { AccessTokenManager, type AccessTokenManagerOptions } from './access-token.js';
import { DEFAULT_DEDUPE_TTL_MS, MessageDeduper, normalizeInboundEvent } from './events.js';
import { errorMessage } from './errors.js';
import type { QQDispatch, QQGatewayReconnectOptions, WebSocketFactory } from './gateway.js';
import { QQGateway } from './gateway.js';
import { DEFAULT_SEQ_TTL_MS, ReplySeqTracker } from './seq.js';
import {
  QQRESTClient,
  type FileDataEncoding,
  type QQMessageTarget,
  type ShardUploadPaths,
} from './rest.js';
import { DEFAULT_TEXT_CHUNK_SIZE, splitText } from './split.js';

/** QQTransport 需要的最小配置面（AppConfig 结构上满足）。 */
export interface QQTransportConfig {
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;
  QQ_API_BASE: string;
  QQ_TOKEN_URL: string;
  QQ_INTENTS: number;
}

export interface QQTransportOptions {
  config: QQTransportConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  /** 单条文本切分上限，默认 1500 字符。 */
  textChunkSize?: number;
  /** file_data 编码，默认 base64；live 实测后可切 binary。 */
  fileDataEncoding?: FileDataEncoding;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  shardThresholdBytes?: number;
  shardPaths?: ShardUploadPaths;
  reconnect?: QQGatewayReconnectOptions;
  dedupeTtlMs?: number;
  seqTtlMs?: number;
  random?: () => number;
  tokenRefreshAheadMs?: number;
  tokenProvider?: AccessTokenManager;
}

/**
 * QQ 官方机器人传输层实现：AccessToken + REST 被动回复 + WebSocket 网关。
 *
 * 事件流：网关 dispatch → 归一（group_at / c2c）→ msg_id 去重（TTL 5 分钟）→ 顺序回调 handler。
 */
export class QQTTransport implements QQTransport {
  private readonly logger: Logger;
  private readonly token: AccessTokenManager;
  private readonly rest: QQRESTClient;
  private readonly gateway: QQGateway;
  private readonly seq: ReplySeqTracker;
  private readonly deduper: MessageDeduper;
  private readonly chunkSize: number;

  private handler: ((event: QQMessageEvent) => Promise<void>) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(options: QQTransportOptions) {
    this.logger = options.logger;
    this.chunkSize = options.textChunkSize ?? DEFAULT_TEXT_CHUNK_SIZE;

    this.token =
      options.tokenProvider ??
      new AccessTokenManager(
        buildTokenOptions(options),
      );

    this.rest = new QQRESTClient({
      apiBase: options.config.QQ_API_BASE,
      tokenProvider: this.token,
      logger: this.logger,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.fileDataEncoding === undefined ? {} : { fileDataEncoding: options.fileDataEncoding }),
      ...(options.shardThresholdBytes === undefined
        ? {}
        : { shardThresholdBytes: options.shardThresholdBytes }),
      ...(options.shardPaths === undefined ? {} : { shardPaths: options.shardPaths }),
    });

    this.seq = new ReplySeqTracker(options.seqTtlMs ?? DEFAULT_SEQ_TTL_MS);
    this.deduper = new MessageDeduper(options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS);

    this.gateway = new QQGateway({
      apiBase: options.config.QQ_API_BASE,
      intents: options.config.QQ_INTENTS,
      logger: this.logger,
      tokenProvider: this.token,
      onDispatch: (dispatch) => this.handleDispatch(dispatch),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  }

  async start(handler: (event: QQMessageEvent) => Promise<void>): Promise<void> {
    if (this.started) throw new Error('QQTransport 已经启动');
    this.started = true;
    this.handler = handler;
    try {
      await this.gateway.start();
    } catch (error) {
      this.started = false;
      this.handler = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
    await this.queue;
    this.started = false;
    this.handler = null;
  }

  identity(): QQIdentity | null {
    return this.gateway.identity();
  }

  async replyText(ctx: ReplyContext, text: string): Promise<void> {
    const chunks = splitText(text, this.chunkSize);
    if (chunks.length === 0) {
      this.logger.debug('回复文本为空，跳过发送');
      return;
    }
    const target = targetFor(ctx.event);
    for (const chunk of chunks) {
      const messageSeq = this.seq.next(ctx.event.messageId);
      await this.rest.sendText(target, {
        content: chunk,
        messageId: ctx.event.messageId,
        messageSeq,
        quoteId: ctx.event.quoteId,
      });
    }
    this.logger.info('QQ 文本已发送', {
      kind: ctx.event.kind,
      messageId: ctx.event.messageId,
      chunks: chunks.length,
    });
  }

  async replyImage(ctx: ReplyContext, image: Buffer, filename = 'rankhub.png'): Promise<void> {
    const target = targetFor(ctx.event);
    const messageSeq = this.seq.next(ctx.event.messageId);
    await this.rest.sendImage(target, {
      buffer: image,
      filename,
      messageId: ctx.event.messageId,
      messageSeq,
      quoteId: ctx.event.quoteId,
    });
    this.logger.info('QQ 图片已发送', {
      kind: ctx.event.kind,
      messageId: ctx.event.messageId,
      messageSeq,
      bytes: image.length,
      filename,
    });
  }

  private handleDispatch(dispatch: QQDispatch): void {
    const event = normalizeInboundEvent(dispatch.t, dispatch.d);
    if (event === null) {
      this.logger.debug('忽略非消息网关事件', { t: dispatch.t });
      return;
    }

    if (this.deduper.isDuplicate(event.messageId)) {
      this.logger.debug('忽略重复推送的消息', { messageId: event.messageId });
      return;
    }

    this.logger.info('收到 QQ 消息', { kind: event.kind, messageId: event.messageId });
    this.enqueue(event);
  }

  /** 顺序处理，保证同一会话的回复顺序；单条失败不阻塞后续事件。 */
  private enqueue(event: QQMessageEvent): void {
    this.queue = this.queue
      .then(async () => {
        const handler = this.handler;
        if (handler === null) return;
        await handler(event);
      })
      .catch((error: unknown) => {
        this.logger.error('处理入站消息失败', {
          messageId: event.messageId,
          error: errorMessage(error),
        });
      });
  }
}

export function createQQTransport(options: QQTransportOptions): QQTransport {
  return new QQTTransport(options);
}

function targetFor(event: QQMessageEvent): QQMessageTarget {
  if (event.kind === 'group_at') {
    if (event.groupOpenid === null) {
      throw new Error(`群消息缺少 group_openid（msg_id=${event.messageId}）`);
    }
    return { kind: 'group', openid: event.groupOpenid };
  }
  return { kind: 'c2c', openid: event.userOpenid };
}

function buildTokenOptions(options: QQTransportOptions): AccessTokenManagerOptions {
  return {
    tokenUrl: options.config.QQ_TOKEN_URL,
    appId: options.config.QQ_APP_ID,
    appSecret: options.config.QQ_APP_SECRET,
    logger: options.logger,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.tokenRefreshAheadMs === undefined
      ? {}
      : { refreshAheadMs: options.tokenRefreshAheadMs }),
  };
}
