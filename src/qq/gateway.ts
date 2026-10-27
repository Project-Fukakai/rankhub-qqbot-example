import type { QQIdentity } from '../contracts/index.js';
import type { Logger } from '../logger/index.js';
import { QQApiError, QQGatewayError, errorMessage } from './errors.js';
import { assertBusinessOk, httpRequest, redactUrl } from './http.js';

/** 网关 dispatch 的原始形态（未归一）。 */
export interface QQDispatch {
  readonly t: string | null;
  readonly d: unknown;
  readonly s: number | null;
}

/** 最小 WebSocket 接口（便于单测注入，生产用 Node 全局 WebSocket）。 */
export type WebSocketEventListener = (event: {
  data?: unknown;
  code?: number;
  reason?: string;
  message?: string;
}) => void;

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: WebSocketEventListener): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface QQGatewayReconnectOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export interface QQGatewayOptions {
  /** REST 基址（用于 /gateway/bot；WS 地址以返回值为准，可能不同域）。 */
  apiBase: string;
  intents: number;
  logger: Logger;
  tokenProvider: { get(): Promise<string>; invalidate(): void };
  onDispatch(dispatch: QQDispatch): void;
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  shard?: [number, number];
  reconnect?: QQGatewayReconnectOptions;
  random?: () => number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export const GATEWAY_PROPERTIES = {
  $os: 'linux',
  $browser: 'rankhub-qqbot',
  $device: 'rankhub-qqbot',
} as const;

/**
 * QQ 官方机器人 WebSocket 网关。
 *
 * 流程：GET /gateway/bot（404 回退 /gateway）→ 连 wss → op10 Hello → op2 Identify
 * （或 op6 Resume）→ 等 READY 才算启动成功。之后按 heartbeat_interval 发 op1 心跳，
 * op7 重连、op9 清 session 重新 Identify、断线指数退避 + 抖动。
 */
export class QQGateway {
  private socket: WebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffResolve: (() => void) | null = null;
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private connectionClosed: Promise<void> | null = null;

  private stopped = true;
  private started = false;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private attempt = 0;
  private userIdentity: QQIdentity | null = null;
  private lastError: Error | null = null;

  private readonly logger: Logger;
  private readonly readyTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly jitter: boolean;
  private readonly random: () => number;
  private readonly webSocketFactory: WebSocketFactory;

  constructor(private readonly options: QQGatewayOptions) {
    this.logger = options.logger;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.reconnectBaseMs = options.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.jitter = options.reconnect?.jitter ?? true;
    this.random = options.random ?? Math.random;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  }

  identity(): QQIdentity | null {
    return this.userIdentity;
  }

  /** 建连并等待 READY；超时/失败抛错。 */
  async start(): Promise<void> {
    if (this.started) throw new QQGatewayError('QQ 网关已经启动');
    this.started = true;
    this.stopped = false;

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      this.readyTimer = setTimeout(() => {
        const detail = this.lastError === null ? '' : `，最后一次错误：${this.lastError.message}`;
        this.failStart(new QQGatewayError(`等待 QQ 网关 READY 超时（${this.readyTimeoutMs}ms${detail}）`));
      }, this.readyTimeoutMs);
    });

    void this.loop();
    await ready;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopped = true;
    this.started = false;
    this.clearReadyTimer();
    this.clearHeartbeat();
    this.clearBackoff();

    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.reject(new QQGatewayError('QQ 网关在 READY 之前被停止'));

    const pendingClose = this.connectionClosed;
    this.closeSocket(1000, 'shutdown');
    if (pendingClose !== null) {
      await Promise.race([pendingClose, delay(2_000)]);
    }
    this.socket = null;
    this.sessionId = null;
    this.lastSeq = null;
    this.userIdentity = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (error) {
        this.lastError = error instanceof Error ? error : new QQGatewayError(errorMessage(error));
        this.logger.warn('QQ 网关连接失败', { error: this.lastError.message });
      }
      if (this.stopped) break;
      await this.waitBackoff();
    }
  }

  private async connectOnce(): Promise<void> {
    const url = await this.resolveGatewayUrl();
    const raw = this.webSocketFactory(url);
    this.socket = raw;

    let settled = false;
    let resolveClosed: (() => void) | null = null;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.connectionClosed = closed;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (this.socket === raw) {
        this.socket = null;
        this.clearHeartbeat();
        this.connectionClosed = null;
      }
      resolveClosed?.();
    };

    raw.addEventListener('message', (event) => {
      if (settled) return;
      void this.handlePayload(event?.data, finish).catch((error: unknown) => {
        this.lastError = error instanceof Error ? error : new QQGatewayError(errorMessage(error));
        this.logger.warn('处理网关消息失败', { error: this.lastError.message });
        finish();
        this.closeSocket(4000, 'handler error');
      });
    });
    raw.addEventListener('error', (event) => {
      this.logger.warn('QQ 网关连接错误', { error: event?.message ?? 'unknown' });
      finish();
    });
    raw.addEventListener('close', (event) => {
      this.logger.info('QQ 网关连接关闭', { code: event?.code ?? 0 });
      finish();
    });

    this.logger.info('已连接 QQ 网关', { url: redactUrl(url) });
    await closed;
  }

  private async handlePayload(data: unknown, finish: () => void): Promise<void> {
    if (typeof data !== 'string') {
      this.logger.debug('忽略非文本网关帧');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      this.logger.warn('收到无法解析的网关帧');
      return;
    }
    if (!isRecord(payload)) return;

    const op = readInteger(payload.op);
    if (op === null) return;
    const d = payload.d;

    switch (op) {
      case OP_HELLO: {
        const interval = readPositiveInteger(isRecord(d) ? d.heartbeat_interval : null) ??
          DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.startHeartbeat(interval);
        await this.sendHandshake();
        return;
      }

      case OP_DISPATCH: {
        const t = typeof payload.t === 'string' ? payload.t : null;
        const s = readInteger(payload.s);
        if (s !== null) this.lastSeq = s;

        if (t === 'READY') {
          this.onReady(d);
          return;
        }
        if (t === 'RESUMED') {
          this.attempt = 0;
          this.logger.info('QQ 网关会话已恢复');
          this.resolveReady();
          return;
        }
        this.options.onDispatch({ t, d, s });
        return;
      }

      case OP_HEARTBEAT_ACK:
        this.logger.debug('收到心跳 ACK (op11)');
        return;

      case OP_HEARTBEAT:
        // 服务端主动要求心跳：立即回一次（d = 最近 s）。
        this.sendJson({ op: OP_HEARTBEAT, d: this.lastSeq });
        return;

      case OP_RECONNECT:
        this.logger.warn('QQ 网关要求重连 (op7)');
        finish();
        this.closeSocket(4000, 'server requested reconnect');
        return;

      case OP_INVALID_SESSION:
        this.logger.warn('QQ 网关会话失效 (op9)，清空 session 后重新 Identify');
        this.sessionId = null;
        this.lastSeq = null;
        finish();
        this.closeSocket(4001, 'invalid session');
        return;

      default:
        this.logger.debug('忽略未知网关 op', { op });
    }
  }

  private onReady(d: unknown): void {
    const record = isRecord(d) ? d : {};
    const sessionId = typeof record.session_id === 'string' ? record.session_id : null;
    if (sessionId !== null) this.sessionId = sessionId;

    const user = isRecord(record.user) ? record.user : null;
    if (user !== null && typeof user.id === 'string' && typeof user.username === 'string') {
      this.userIdentity = { id: user.id, username: user.username };
    }

    this.attempt = 0;
    this.logger.info('QQ 网关 READY', {
      username: this.userIdentity?.username ?? null,
      hasSession: this.sessionId !== null,
    });
    this.resolveReady();
  }

  private async sendHandshake(): Promise<void> {
    const token = await this.options.tokenProvider.get();
    const canResume = this.sessionId !== null && this.lastSeq !== null;

    if (canResume) {
      this.logger.info('QQ 网关发送 Resume', { seq: this.lastSeq });
      this.sendJson({
        op: OP_RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      });
      return;
    }

    this.logger.info('QQ 网关发送 Identify', { intents: this.options.intents });
    this.sendJson({
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: this.options.intents,
        shard: this.options.shard ?? [0, 1],
        properties: GATEWAY_PROPERTIES,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 首次心跳 d=null（还没有 s），之后带上最近一次 s。
      this.sendJson({ op: OP_HEARTBEAT, d: this.lastSeq });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
    this.logger.debug('网关心跳已启动', { intervalMs });
  }

  private sendJson(payload: unknown): void {
    const socket = this.socket;
    if (socket === null) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn('发送网关消息失败', { error: errorMessage(error) });
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === null) return;
    try {
      socket.close(code, reason);
    } catch (error) {
      this.logger.debug('关闭网关连接失败', { error: errorMessage(error) });
    }
  }

  private async resolveGatewayUrl(): Promise<string> {
    try {
      return await this.fetchGatewayUrl('/gateway/bot');
    } catch (error) {
      if (error instanceof QQApiError && error.status === 404) {
        this.logger.info('/gateway/bot 不可用（404），回退 /gateway');
        return this.fetchGatewayUrl('/gateway');
      }
      throw error;
    }
  }

  private async fetchGatewayUrl(path: string): Promise<string> {
    const token = await this.options.tokenProvider.get();
    const response = await httpRequest({
      url: `${this.options.apiBase.replace(/\/+$/, '')}${path}`,
      method: 'GET',
      headers: { authorization: `QQBot ${token}` },
      timeoutMs: this.options.requestTimeoutMs ?? 15_000,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });

    const body = assertBusinessOk(response, '获取 QQ 网关地址');
    const url = isRecord(body) && typeof body.url === 'string' ? body.url : '';
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      throw new QQGatewayError(`获取 QQ 网关地址失败：返回的 url 非法（${url === '' ? '空' : redactUrl(url)}）`);
    }
    return url;
  }

  private resolveReady(): void {
    const waiter = this.readyWaiter;
    if (waiter === null) return;
    this.readyWaiter = null;
    this.clearReadyTimer();
    waiter.resolve();
  }

  private failStart(error: Error): void {
    this.lastError = error;
    const waiter = this.readyWaiter;
    if (waiter === null) return;
    this.readyWaiter = null;
    this.clearReadyTimer();
    this.stopped = true;
    // 允许失败后再次 start()（start 的失败路径已经把定时器/连接都清理掉了）。
    this.started = false;
    this.clearHeartbeat();
    this.clearBackoff();
    this.closeSocket(1000, 'start failed');
    waiter.reject(error);
  }

  private async waitBackoff(): Promise<void> {
    const delayMs = this.nextBackoffDelay();
    this.logger.info('QQ 网关重连退避', { delayMs: Math.round(delayMs), attempt: this.attempt });
    await new Promise<void>((resolve) => {
      this.backoffResolve = () => {
        this.backoffResolve = null;
        resolve();
      };
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        this.backoffResolve = null;
        resolve();
      }, delayMs);
      this.backoffTimer.unref?.();
    });
  }

  private nextBackoffDelay(): number {
    const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempt);
    this.attempt += 1;
    if (!this.jitter) return exponential;
    // 抖动区间 [0.5, 1.0) * 指数退避，避免重连风暴。
    return exponential * (0.5 + this.random() * 0.5);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearBackoff(): void {
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    const resolve = this.backoffResolve;
    this.backoffResolve = null;
    resolve?.();
  }
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return null;
}
