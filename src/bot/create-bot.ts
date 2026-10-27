import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger/index.js';

/**
 * 机器人装配入口（lead 先放骨架，commands-integration 接管实现）。
 *
 * 依赖注入顺序：store → rankhub → qq → renderer → commands → dispatcher。
 * 这里只暴露 start/stop，进程信号处理在 src/index.ts。
 */
export interface BotDeps {
  config: AppConfig;
  logger: Logger;
}

export interface Bot {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createBot(deps: BotDeps): Promise<Bot> {
  const { logger } = deps;
  logger.warn('createBot 尚未接入（骨架阶段）');
  return {
    async start() {
      throw new Error('机器人尚未接入：等待 commands-integration 完成 src/bot 与 src/commands');
    },
    async stop() {},
  };
}
