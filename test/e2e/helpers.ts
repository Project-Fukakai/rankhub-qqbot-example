/**
 * E2E 测试脚手架：真实 `createBot` + `FakeQQServer` + `FakeRankHub` + `FakeRenderer`。
 *
 * 纪律：
 * - 所有 URL 指向 127.0.0.1（配置里不会出现真实 api.bot.qq.com / rankhub.cc）；
 * - DB 用临时目录，TOKEN_ENC_KEY 用测试固定 32 字节 base64；
 * - renderer 注入固定 1x1 PNG，不启动 Chromium、不依赖 vendor 素材；
 * - `sleep` 可注入（`createManualSleep`）把 `/bind` 的后台轮询变成确定性步骤。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Bot } from '../../src/bot/create-bot.js';
import { createBot } from '../../src/bot/create-bot.js';
import type { AppConfig } from '../../src/config/index.js';
import type {
  Binding,
  MaimaiB50RenderInput,
  PhigrosRksRenderInput,
  Renderer,
} from '../../src/contracts/index.js';
import { silentLogger } from '../../src/logger/index.js';
import { createBindingStore, type SqliteBindingStore } from '../../src/store/index.js';
import { FakeQQServer, type RecordedMessage } from '../fakes/qq/index.js';
import {
  DEVICE_CODE_GRANT_TYPE,
  FakeRankHub,
  type FakeRankHubOptions,
} from '../fakes/rankhub/index.js';

/** 测试固定密钥：32 字节 base64（不是任何真实密钥）。 */
export const TEST_TOKEN_KEY = Buffer.alloc(32, 0x2a).toString('base64');

/** 1x1 透明 PNG（固定字节，仅用于验证「上传了图片」）。 */
export const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
  'base64',
);

export class FakeRenderer implements Renderer {
  readonly maimaiCalls: MaimaiB50RenderInput[] = [];
  readonly phigrosCalls: PhigrosRksRenderInput[] = [];
  readonly cardCalls: import('../../src/contracts/index.js').PlayerCardRenderInput[] = [];
  readonly arcCalls: import('../../src/contracts/index.js').ArcaeaB50RenderInput[] = [];
  closed = false;

  async renderMaimaiB50(input: MaimaiB50RenderInput): Promise<Buffer> {
    this.maimaiCalls.push(input);
    return ONE_PX_PNG;
  }

  async renderPhigrosRks(input: PhigrosRksRenderInput): Promise<Buffer> {
    this.phigrosCalls.push(input);
    return ONE_PX_PNG;
  }

  async renderPlayerCard(input: import('../../src/contracts/index.js').PlayerCardRenderInput): Promise<Buffer> {
    this.cardCalls.push(input);
    return ONE_PX_PNG;
  }

  async renderArcaeaB50(input: import('../../src/contracts/index.js').ArcaeaB50RenderInput): Promise<Buffer> {
    this.arcCalls.push(input);
    return ONE_PX_PNG;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface ManualSleep {
  sleep(ms: number): Promise<void>;
  /** 放行 count 次等待。 */
  release(count?: number): void;
  /** 当前有多少个 sleep 正在等待。 */
  pending(): number;
  /** 之后所有 sleep 立即返回。 */
  setAuto(): void;
}

/** 可控 sleep：默认挂起，测试手动 release；用于“等用户批准设备码”的确定性时序。 */
export function createManualSleep(): ManualSleep {
  const waiters: Array<() => void> = [];
  let auto = false;
  return {
    sleep(): Promise<void> {
      if (auto) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(count = 1): void {
      for (let i = 0; i < count; i += 1) {
        waiters.shift()?.();
      }
    },
    pending(): number {
      return waiters.length;
    },
    setAuto(): void {
      auto = true;
      while (waiters.length > 0) waiters.shift()?.();
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${description}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

export function makeTestConfig(options: {
  qqOrigin: string;
  rankhubOrigin: string;
  dbPath: string;
}): AppConfig {
  return {
    QQ_APP_ID: 'test-app-id',
    QQ_APP_SECRET: 'test-app-secret',
    QQ_API_BASE: options.qqOrigin,
    QQ_TOKEN_URL: `${options.qqOrigin}/app/getAppAccessToken`,
    QQ_INTENTS: 1 << 25,
    RANKHUB_CLIENT_ID: 'rankhub-qqbot',
    RANKHUB_CLIENT_SECRET: 'fake-client-secret',
    RANKHUB_AUTH_BASE: options.rankhubOrigin,
    RANKHUB_API_BASE: options.rankhubOrigin,
    RANKHUB_SCOPES: 'openid profile offline_access game:read',
    RANKHUB_REDIRECT_URI: 'http://127.0.0.1:17830/callback',
    RANKHUB_DEVICE_POLL_MAX_SECONDS: 240,
    TOKEN_ENC_KEY: TEST_TOKEN_KEY,
    DB_PATH: options.dbPath,
    MAIMAI_RENDERER: 'auto',
    MAIMAI_PYTHON: 'python3.11',
    LOG_LEVEL: 'error',
    rootDir: process.cwd(),
    envFileLoaded: false,
  };
}

export interface HarnessOptions {
  rankhub?: FakeRankHubOptions;
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（设备码超时用例用）。 */
  now?: () => number;
}

export interface Harness {
  readonly fakeQQ: FakeQQServer;
  readonly fakeRankHub: FakeRankHub;
  readonly renderer: FakeRenderer;
  readonly config: AppConfig;
  /** 另开一个只读/校验用的 store 句柄（与 bot 共用同一 DB 文件）。 */
  readonly store: SqliteBindingStore;
  readonly bot: Bot;
  emitGroup(content: string, messageId: string): void;
  messagesFor(messageId: string): RecordedMessage[];
  waitForMessages(messageId: string, count: number): Promise<RecordedMessage[]>;
  waitForImageMessage(): Promise<RecordedMessage>;
  /** 直接走假 RankHub 设备码流拿令牌并写入 store（跳过 QQ 绑定交互）。 */
  seedBinding(qqUserOpenid?: string): Promise<Binding>;
  stop(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'rankhub-e2e-'));
  const dbPath = join(dir, 'bot.db');
  const fakeQQ = await new FakeQQServer().start();
  const fakeRankHub = await FakeRankHub.start(options.rankhub ?? {});
  const config = makeTestConfig({
    qqOrigin: fakeQQ.apiBase,
    rankhubOrigin: fakeRankHub.origin,
    dbPath,
  });
  const renderer = new FakeRenderer();
  const bot = await createBot({
    config,
    logger: silentLogger,
    renderer,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await bot.start();
  const store = createBindingStore(config);

  let stopped = false;
  const harness: Harness = {
    fakeQQ,
    fakeRankHub,
    renderer,
    config,
    store,
    bot,
    emitGroup(content: string, messageId: string): void {
      fakeQQ.emitGroupAt(content, { messageId });
    },
    messagesFor(messageId: string): RecordedMessage[] {
      return fakeQQ.messageRequests.filter((message) => message.body.msg_id === messageId);
    },
    async waitForMessages(messageId: string, count: number): Promise<RecordedMessage[]> {
      await waitFor(
        () => harness.messagesFor(messageId).length >= count,
        `消息 ${messageId} 收到 ${count} 条回复`,
      );
      return harness.messagesFor(messageId);
    },
    async waitForImageMessage(): Promise<RecordedMessage> {
      await waitFor(
        () => fakeQQ.messageRequests.some((message) => message.body.msg_type === 7),
        '收到 msg_type=7 的图片消息',
      );
      const found = fakeQQ.messageRequests.find((message) => message.body.msg_type === 7);
      if (found === undefined) throw new Error('内部错误：图片消息在等待后消失');
      return found;
    },
    async seedBinding(qqUserOpenid = 'user-openid-1'): Promise<Binding> {
      const origin = fakeRankHub.origin;
      const form = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields);
      const deviceResponse = await fetch(`${origin}/v1/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: config.RANKHUB_CLIENT_ID, scope: config.RANKHUB_SCOPES }),
      });
      if (!deviceResponse.ok) {
        throw new Error(`假 RankHub 设备码申请失败：HTTP ${deviceResponse.status}`);
      }
      const device = (await deviceResponse.json()) as { device_code: string };
      const tokenResponse = await fetch(`${origin}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: device.device_code,
          client_id: config.RANKHUB_CLIENT_ID,
          client_secret: config.RANKHUB_CLIENT_SECRET,
        }),
      });
      if (!tokenResponse.ok) {
        throw new Error(`假 RankHub 换取令牌失败：HTTP ${tokenResponse.status}`);
      }
      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
      };
      return store.upsert({
        qqUserOpenid,
        unionOpenid: null,
        rankhubSubject: 'user-fake-sub',
        rankhubName: 'Fake User',
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessExpiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope,
      });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await bot.stop();
      } finally {
        try {
          store.close();
        } catch {
          // 已在 bot.stop 里关闭自己的连接；这里只是另一个句柄，失败不影响清理。
        }
        await fakeQQ.stop().catch(() => undefined);
        await fakeRankHub.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };

  return harness;
}
