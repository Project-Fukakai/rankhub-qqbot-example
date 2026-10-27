import { silentLogger } from '../../../src/logger/index.js';
import type { QQTransportConfig } from '../../../src/qq/index.js';

export const testLogger = silentLogger;

export function transportConfig(apiBase: string): QQTransportConfig {
  return {
    QQ_APP_ID: 'test-app-id',
    QQ_APP_SECRET: 'test-app-secret',
    QQ_API_BASE: apiBase,
    QQ_TOKEN_URL: `${apiBase}/app/getAppAccessToken`,
    QQ_INTENTS: 33554432,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
  message = '等待条件超时',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
