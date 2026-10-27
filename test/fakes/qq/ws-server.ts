/**
 * 极简 RFC 6455 WebSocket 服务端。
 *
 * 仓库没有 `ws` 依赖（也不允许改 package.json），Node 只内置客户端 WebSocket，
 * 所以假 QQ 网关这里用 node:http upgrade + 手写帧编解码实现（仅覆盖测试需要：
 * 文本帧、ping/pong、close、分片）。
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface FakeFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header.writeUInt8((fin ? 0x80 : 0) | opcode, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8((fin ? 0x80 : 0) | opcode, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 从缓冲区解出尽可能多的完整帧，返回未消费的尾巴。 */
export function decodeFrames(buffer: Buffer): { frames: FakeFrame[]; rest: Buffer } {
  const frames: FakeFrame[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer.readUInt8(offset);
    const second = buffer.readUInt8(offset + 1);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;

    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (offset + headerLength + 4 > buffer.length) break;
      maskKey = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      headerLength += 4;
    }

    if (offset + headerLength + length > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(offset + headerLength, offset + headerLength + length));
    if (maskKey !== null) {
      for (let index = 0; index < payload.length; index += 1) {
        payload.writeUInt8(payload.readUInt8(index) ^ maskKey.readUInt8(index % 4), index);
      }
    }

    frames.push({ fin, opcode, payload });
    offset += headerLength + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

type JsonListener = (payload: unknown) => void;

export class FakeWebSocketConnection {
  readonly jsonMessages: unknown[] = [];
  readonly textMessages: string[] = [];

  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private closed = false;
  private closeCode: number | null = null;
  private readonly jsonListeners = new Set<JsonListener>();
  private readonly closeWaiters: Array<() => void> = [];

  constructor(
    readonly id: number,
    private readonly socket: Duplex,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.markClosed(1006));
    socket.on('close', () => this.markClosed(this.closeCode ?? 1006));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get closedWithCode(): number | null {
    return this.closeCode;
  }

  onJson(listener: JsonListener): () => void {
    this.jsonListeners.add(listener);
    return () => this.jsonListeners.delete(listener);
  }

  /** 测试注入初始字节（upgrade 的 head）。 */
  pushRaw(chunk: Buffer): void {
    this.onData(chunk);
  }

  sendJson(payload: unknown): void {
    this.sendText(JSON.stringify(payload));
  }

  sendText(text: string): void {
    this.writeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'));
  }

  sendClose(code = 1000, reason = ''): void {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.writeFrame(OPCODE_CLOSE, payload);
    this.markClosed(code);
    this.socket.end();
  }

  /** 直接掐断 TCP（模拟网络层断开，不发 close 帧）。 */
  destroy(): void {
    this.socket.destroy();
    this.markClosed(1006);
  }

  async waitForClose(timeoutMs = 3_000): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 WebSocket 关闭超时')), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;

    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: FakeFrame): void {
    switch (frame.opcode) {
      case OPCODE_PING:
        this.writeFrame(OPCODE_PONG, frame.payload);
        return;
      case OPCODE_PONG:
        return;
      case OPCODE_CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        this.sendClose(code === 1005 || code === 1006 ? 1000 : code);
        return;
      }
      case OPCODE_TEXT:
      case OPCODE_BINARY:
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        if (frame.fin) this.flushMessage();
        return;
      case OPCODE_CONTINUATION:
        this.fragments.push(frame.payload);
        if (frame.fin) this.flushMessage();
        return;
      default:
        return;
    }
  }

  private flushMessage(): void {
    const payload = Buffer.concat(this.fragments);
    this.fragments = [];
    const opcode = this.fragmentOpcode;
    this.fragmentOpcode = null;

    if (opcode === OPCODE_BINARY) return;

    const text = payload.toString('utf8');
    this.textMessages.push(text);

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    this.jsonMessages.push(parsed);
    for (const listener of this.jsonListeners) listener(parsed);
  }

  private markClosed(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    const waiters = this.closeWaiters.splice(0);
    for (const waiter of waiters) waiter();
    this.jsonListeners.clear();
  }
}

/** 挂在已有 http.Server 上的假 WebSocket 服务端（共享端口，便于同时提供 REST）。 */
export class FakeWebSocketServer {
  readonly connections: FakeWebSocketConnection[] = [];
  private readonly connectionListeners = new Set<(connection: FakeWebSocketConnection) => void>();
  private nextId = 1;

  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string' || key === '') {
        socket.destroy();
        return;
      }

      const response = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '',
        '',
      ].join('\r\n');
      socket.write(response);

      const connection = new FakeWebSocketConnection(this.nextId, socket);
      this.nextId += 1;
      this.connections.push(connection);
      if (head.length > 0) connection.pushRaw(head);
      for (const listener of this.connectionListeners) listener(connection);
    });
  }

  onConnection(listener: (connection: FakeWebSocketConnection) => void): () => void {
    this.connectionListeners.add(listener);
    for (const connection of this.connections) listener(connection);
    return () => this.connectionListeners.delete(listener);
  }

  get openConnections(): FakeWebSocketConnection[] {
    return this.connections.filter((connection) => !connection.isClosed);
  }

  async waitForConnectionCount(count: number, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.connections.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`等待第 ${count} 个 WebSocket 连接超时（当前 ${this.connections.length}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  closeAll(code = 1000, reason = 'test shutdown'): void {
    for (const connection of this.connections) connection.sendClose(code, reason);
  }
}
