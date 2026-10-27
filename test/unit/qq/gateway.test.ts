import { afterEach, describe, expect, it } from 'vitest';

import { QQGateway, type QQDispatch, type QQGatewayOptions } from '../../../src/qq/index.js';
import { FakeQQServer, type FakeQQServerOptions } from '../../fakes/qq/index.js';
import { testLogger, waitUntil } from './helpers.js';

const servers: FakeQQServer[] = [];
const gateways: QQGateway[] = [];

async function startServer(options: FakeQQServerOptions = {}): Promise<FakeQQServer> {
  const server = await new FakeQQServer(options).start();
  servers.push(server);
  return server;
}

function createGateway(
  server: FakeQQServer,
  overrides: Partial<QQGatewayOptions> = {},
): { gateway: QQGateway; dispatches: QQDispatch[] } {
  const dispatches: QQDispatch[] = [];
  const gateway = new QQGateway({
    apiBase: server.apiBase,
    intents: 33554432,
    logger: testLogger,
    tokenProvider: { get: async () => 'fake-token', invalidate: () => {} },
    onDispatch: (dispatch) => dispatches.push(dispatch),
    reconnect: { baseDelayMs: 20, maxDelayMs: 40, jitter: false },
    readyTimeoutMs: 1_000,
    ...overrides,
  });
  gateways.push(gateway);
  return { gateway, dispatches };
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const server of servers.splice(0)) await server.stop();
});

describe('QQGateway 握手', () => {
  it('Hello → Identify（含 intents/shard/properties）→ READY 后才 resolve，并记住身份', async () => {
    const server = await startServer();
    const { gateway, dispatches } = createGateway(server);

    await gateway.start();

    expect(gateway.identity()).toEqual({ id: 'bot-id', username: 'RankHub 小助手' });
    expect(server.identifies).toHaveLength(1);
    expect(server.identifies[0]).toMatchObject({
      op: 2,
      d: {
        token: 'QQBot fake-token',
        intents: 33554432,
        shard: [0, 1],
        properties: { $os: 'linux', $browser: 'rankhub-qqbot', $device: 'rankhub-qqbot' },
      },
    });

    server.emitGroupAt('/help');
    await waitUntil(() => dispatches.length === 1);
    expect(dispatches[0]?.t).toBe('GROUP_AT_MESSAGE_CREATE');
    expect(dispatches[0]?.s).toBeGreaterThanOrEqual(2);
  });

  it('/gateway/bot 404 时回退 /gateway', async () => {
    const server = await startServer({ gatewayPath: 'root' });
    const { gateway } = createGateway(server);

    await gateway.start();

    const paths = server.requests.filter((request) => request.method === 'GET').map((r) => r.path);
    expect(paths).toContain('/gateway/bot');
    expect(paths).toContain('/gateway');
    expect(paths.indexOf('/gateway/bot')).toBeLessThan(paths.indexOf('/gateway'));
  });

  it('READY 超时：start 抛错，且超时前已在发 d=null 的心跳', async () => {
    const server = await startServer({ readyPolicy: 'silent', heartbeatIntervalMs: 30 });
    const { gateway } = createGateway(server, { readyTimeoutMs: 250 });

    await expect(gateway.start()).rejects.toThrow(/READY 超时/);

    expect(server.heartbeats.length).toBeGreaterThan(0);
    expect(server.heartbeats[0]).toEqual({ op: 1, d: null });
  });
});

describe('QQGateway 心跳', () => {
  it('心跳按周期发送，携带最近一次 s', async () => {
    const server = await startServer({ heartbeatIntervalMs: 30 });
    const { gateway } = createGateway(server);

    await gateway.start();

    // READY 的 s=1；心跳里应出现 d=1。
    await waitUntil(() => server.heartbeats.some((beat) => beat.d === 1));

    server.emitGroupAt('x');
    // 新 dispatch 的 s=2，后续心跳携带 2。
    await waitUntil(() => server.heartbeats.some((beat) => beat.d === 2));
  });
});

describe('QQGateway 重连', () => {
  it('断线后优先 op6 Resume（session_id + seq）', async () => {
    const server = await startServer();
    const { gateway } = createGateway(server);

    await gateway.start();
    server.emitGroupAt('before-drop');
    await waitUntil(() => server.identifies.length === 1);

    server.closeGatewayConnections();
    await server.waitForConnectionCount(2);
    await waitUntil(() => server.resumes.length === 1);

    const resume = server.resumes[0];
    expect(resume?.op).toBe(6);
    expect(resume?.d).toMatchObject({ token: 'QQBot fake-token', session_id: 'session-1' });
    expect(Number((resume?.d as { seq?: unknown }).seq)).toBeGreaterThanOrEqual(1);
    expect(gateway.identity()).toEqual({ id: 'bot-id', username: 'RankHub 小助手' });
  });

  it('op9 invalid session：清 session 后重新 Identify（不发 Resume）', async () => {
    const server = await startServer();
    const { gateway } = createGateway(server);

    await gateway.start();
    expect(server.identifies).toHaveLength(1);

    server.sendGateway({ op: 9, d: false });
    await server.waitForConnectionCount(2);
    await waitUntil(() => server.identifies.length === 2);
    expect(server.resumes).toHaveLength(0);
  });

  it('op7 服务端要求重连：有 session 时走 Resume', async () => {
    const server = await startServer();
    const { gateway } = createGateway(server);

    await gateway.start();
    server.sendGateway({ op: 7 });
    await server.waitForConnectionCount(2);
    await waitUntil(() => server.resumes.length === 1);
    expect(server.identifies).toHaveLength(1);
  });

  it('stop 后连接关闭', async () => {
    const server = await startServer();
    const { gateway } = createGateway(server);

    await gateway.start();
    const connection = server.gatewayConnections[0];
    expect(connection?.isClosed).toBe(false);

    await gateway.stop();
    await connection?.waitForClose(1_000);
    expect(connection?.isClosed).toBe(true);
  });
});
