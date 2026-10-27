/**
 * 真实 QQ 网关冒烟：连接 → 等 READY → 打印机器人身份 → 保持 12s（收心跳）→ 退出。
 * 不发送任何消息，不订阅额外 intents。
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/logger/index.js';
import { createQQTransport } from '../src/qq/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, { app: 'live-gateway' });
const transport = createQQTransport({ config, logger });
const startedAt = Date.now();

async function main(): Promise<void> {
  await transport.start(async (event) => {
    logger.info('收到事件', {
      kind: event.kind,
      contentLength: event.content.length,
      group: event.groupOpenid !== null,
    });
  });
  const identity = transport.identity();
  console.log(
    JSON.stringify({
      step: 'gateway',
      ready: true,
      identity,
      intents: config.QQ_INTENTS,
      readyMs: Date.now() - startedAt,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 12_000));
  console.log(JSON.stringify({ step: 'gateway', aliveAfterMs: Date.now() - startedAt }));
  await transport.stop();
  console.log(JSON.stringify({ step: 'stop', ok: true }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ step: 'fatal', error: (error as Error).message }));
  process.exitCode = 1;
});
