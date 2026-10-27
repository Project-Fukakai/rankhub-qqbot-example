import { createBot } from './bot/create-bot.js';
import { loadConfig } from './config/index.js';
import { createLogger } from './logger/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, { app: 'rankhub-qqbot' });
  logger.info('启动中', {
    envFileLoaded: config.envFileLoaded,
    dbPath: config.DB_PATH,
    maimaiRenderer: config.MAIMAI_RENDERER,
  });

  const bot = await createBot({ config, logger });
  await bot.start();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('收到退出信号，开始优雅停机', { signal });
    try {
      await bot.stop();
      process.exitCode = 0;
    } catch (error) {
      logger.error('停机失败', { error: (error as Error).message });
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const logger = createLogger('error', { app: 'rankhub-qqbot' });
  logger.error('启动失败', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
});
