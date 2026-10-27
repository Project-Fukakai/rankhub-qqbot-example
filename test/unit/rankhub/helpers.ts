import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Binding, RankHubTokens } from '../../../src/contracts/index.js';
import {
  createRankHubClient,
  type RankHubClientExtended,
  type RankHubClientDeps,
} from '../../../src/rankhub/index.js';
import { createBindingStore, type SqliteBindingStore } from '../../../src/store/index.js';
import type { FakeRankHub, RecordedRequest } from '../../fakes/rankhub/index.js';

/** 测试密钥：每次运行随机，32 字节 base64。 */
export function newTestKey(): string {
  return randomBytes(32).toString('base64');
}

export const TEST_ENC_KEY = newTestKey();

export function createTempDir(prefix = 'rankhub-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function makeStore(dir: string, key: string = TEST_ENC_KEY): SqliteBindingStore {
  return createBindingStore({ DB_PATH: join(dir, 'bot.db'), TOKEN_ENC_KEY: key });
}

/** 用假服务器的地址装配客户端（config 里只有非敏感默认值 + 测试密钥）。 */
export function makeClient(
  fake: FakeRankHub,
  store: RankHubClientDeps['store'],
  options: Pick<RankHubClientDeps, 'sleep' | 'timeoutMs'> = {},
  key: string = TEST_ENC_KEY,
): RankHubClientExtended {
  return createRankHubClient(
    {
      RANKHUB_CLIENT_ID: fake.state.clientId,
      RANKHUB_CLIENT_SECRET: fake.state.clientSecret,
      RANKHUB_AUTH_BASE: fake.authBase,
      RANKHUB_API_BASE: fake.apiBase,
      RANKHUB_SCOPES: 'openid profile offline_access game:read',
      TOKEN_ENC_KEY: key,
    },
    { store, ...options },
  );
}

/** 走完设备码拿到一对令牌（默认假服务首次轮询就批准）。 */
export async function obtainTokens(
  fake: FakeRankHub,
  client: RankHubClientExtended,
): Promise<RankHubTokens> {
  const authorization = await client.deviceStart('openid profile offline_access game:read');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await client.devicePoll(authorization.deviceCode);
    if (result.status === 'ok') return result.tokens;
    if (result.status === 'denied' || result.status === 'expired') {
      throw new Error(`设备码流程意外终止：${result.status}`);
    }
  }
  throw new Error('设备码轮询 10 次仍未批准');
}

export async function obtainAccessToken(
  fake: FakeRankHub,
  client: RankHubClientExtended,
): Promise<string> {
  const tokens = await obtainTokens(fake, client);
  return tokens.accessToken;
}

/** 把一对令牌写进 store（等价于 commands 层绑定成功后的动作）。 */
export async function saveBinding(
  store: SqliteBindingStore,
  tokens: RankHubTokens,
  overrides: Partial<{ qqUserOpenid: string; rankhubSubject: string; rankhubName: string | null }> = {},
): Promise<Binding> {
  return store.upsert({
    qqUserOpenid: overrides.qqUserOpenid ?? 'qq-openid-1',
    unionOpenid: null,
    rankhubSubject: overrides.rankhubSubject ?? 'user-fake-sub',
    rankhubName: overrides.rankhubName ?? 'Fake User',
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessExpiresAt: Date.now() + tokens.expiresIn * 1000,
    scopes: tokens.scope,
  });
}

/** 取最后一次命中某 path 的请求（断言 query / form 用）。 */
export function lastRequest(fake: FakeRankHub, path: string): RecordedRequest {
  for (let index = fake.state.requests.length - 1; index >= 0; index -= 1) {
    const request = fake.state.requests[index];
    if (request !== undefined && request.path === path) return request;
  }
  throw new Error(`假服务器没有收到 ${path} 的请求`);
}

export function requestsTo(fake: FakeRankHub, path: string): RecordedRequest[] {
  return fake.state.requests.filter((request) => request.path === path);
}
