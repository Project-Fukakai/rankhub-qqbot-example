/**
 * 机器人装配入口。
 *
 * 依赖顺序：store → rankhub → qq → renderer → commands → dispatcher。
 * 这里只暴露 start/stop；进程信号处理在 src/index.ts。
 *
 * 可注入项（测试用，生产不传）：
 * - `renderer`：E2E 注入固定 PNG 的 FakeRenderer，避免依赖 Chromium / 素材；
 * - `sleep`：`/bind` 后台轮询的等待，E2E 用可控 sleep 把“等用户批准”变成确定性步骤；
 * - `now`：时钟（缓存 TTL / 设备码超时）。
 *
 * 停机顺序：后台轮询 abort → QQ 网关停止（等待在途消息处理）→ 渲染器关闭 → SQLite 关闭。
 */
import type { CommandServices, Reply } from '../commands/common.js';
import { createCommandRegistry } from '../commands/index.js';
import { CommandRuntime } from '../commands/runtime.js';
import type { AppConfig } from '../config/index.js';
import type {
  QQIdentity,
  QQMessageEvent,
  QQTransport,
  Renderer,
} from '../contracts/index.js';
import type { Logger } from '../logger/index.js';
import { createQQTransport } from '../qq/index.js';
import { createRankHubClient } from '../rankhub/index.js';
import { createBindingStore } from '../store/index.js';
import { createDispatcher } from './dispatcher.js';
import { createRenderer } from './renderer.js';

export interface BotDeps {
  config: AppConfig;
  logger: Logger;
  /** 测试注入；缺省按 config 动态装配真实渲染器（缺失时对应指令降级为文字）。 */
  renderer?: Renderer;
  /** 测试注入；缺省 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入；缺省 Date.now。 */
  now?: () => number;
}

export interface Bot {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createBot(deps: BotDeps): Promise<Bot> {
  const { config, logger } = deps;
  const log = logger.child({ module: 'bot' });
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  const store = createBindingStore(config);
  const rankhub = createRankHubClient(config, { store, logger });
  const qq: QQTransport = createQQTransport({ config, logger });
  const renderer: Renderer = deps.renderer ?? (await createRenderer(config, logger));
  const runtime = new CommandRuntime(now, logger.child({ module: 'runtime' }));

  const reply: Reply = {
    text: (ctx, text) => qq.replyText(ctx, text),
    image: (ctx, image, filename) => qq.replyImage(ctx, image, filename),
  };
  const qqFacade = {
    identity: (): QQIdentity | null => qq.identity(),
  };

  const services: CommandServices = {
    config,
    logger: logger.child({ module: 'commands' }),
    store,
    rankhub,
    renderer,
    qq: qqFacade,
    reply,
    runtime,
    now,
    sleep,
  };

  const registry = createCommandRegistry(services);
  const dispatcher = createDispatcher({ services, registry, logger });

  let started = false;
  let stopped = false;

  /** 每个阶段独立收尾，任何一步失败都不阻断后续释放。 */
  async function cleanup(): Promise<void> {
    const failures: string[] = [];
    try {
      await runtime.close();
    } catch (error) {
      failures.push(`清理后台任务失败：${describeError(error)}`);
    }
    try {
      await qq.stop();
    } catch (error) {
      failures.push(`关闭 QQ 网关失败：${describeError(error)}`);
    }
    try {
      await renderer.close();
    } catch (error) {
      failures.push(`关闭渲染器失败：${describeError(error)}`);
    }
    try {
      store.close();
    } catch (error) {
      failures.push(`关闭本地数据库失败：${describeError(error)}`);
    }
    for (const failure of failures) log.warn('停机阶段出现错误', { reason: failure });
  }

  return {
    async start(): Promise<void> {
      if (started) throw new Error('机器人已经启动，不能重复 start');
      if (stopped) throw new Error('机器人已经停止，不能再次 start');
      try {
        const purged = await store.purgeExpiredPendingDevices(now());
        if (purged > 0) log.info('清理过期设备码会话', { count: purged });
        await qq.start((event: QQMessageEvent) => dispatcher.handle(event));
        started = true;
        log.info('机器人已就绪', { bot: qq.identity()?.username ?? null });
      } catch (error) {
        // 启动失败也要释放已打开的资源（DB / 渲染器 / WS），避免进程卡住。
        await cleanup();
        stopped = true;
        throw error;
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      started = false;
      await cleanup();
      log.info('机器人已停止');
    },
  };
}
