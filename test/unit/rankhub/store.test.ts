import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { PendingDevice } from '../../../src/contracts/index.js';
import { DatabaseSyncCtor as DatabaseSync } from '../../../src/store/sqlite.js';
import {
  createBindingStore,
  createTokenCipher,
  SCHEMA_VERSION,
  TokenCipherError,
  type SqliteBindingStore,
} from '../../../src/store/index.js';

import {
  createTempDir,
  makeStore,
  newTestKey,
  removeTempDir,
  TEST_ENC_KEY,
} from './helpers.js';

const cleanup: (() => void)[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    fn?.();
  }
});

function tempDir(): string {
  const dir = createTempDir();
  cleanup.push(() => removeTempDir(dir));
  return dir;
}

function openStore(dir: string, key: string = TEST_ENC_KEY): SqliteBindingStore {
  const store = makeStore(dir, key);
  cleanup.push(() => store.close());
  return store;
}

const bindingInput = {
  qqUserOpenid: 'qq-openid-1',
  unionOpenid: null,
  rankhubSubject: 'user-sub',
  rankhubName: '玩家',
  refreshToken: 'rt_plain_secret',
  accessToken: 'at_plain_secret',
  accessExpiresAt: 1_760_000_000_000,
  scopes: 'openid profile offline_access game:read',
};

function pending(overrides: Partial<PendingDevice> = {}): PendingDevice {
  return {
    qqUserOpenid: 'qq-openid-1',
    unionOpenid: null,
    deviceCode: 'dc_test',
    userCode: 'ABCD-EFGH',
    expiresAt: 1_760_000_000_000,
    createdAt: 1_759_999_000_000,
    messageId: 'msg-1',
    groupOpenid: 'group-1',
    nextReplySeq: 1,
    ...overrides,
  };
}

describe('令牌静态加密（AES-256-GCM）', () => {
  it('往返成功、IV 随机、密文不含明文且格式为 v1.<iv>.<tag>.<ct>', () => {
    const cipher = createTokenCipher(TEST_ENC_KEY);
    const sealed = cipher.encrypt('binding-a', 'refresh_token', 'rt_plain_secret');

    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed.split('.')).toHaveLength(4);
    expect(sealed).not.toContain('rt_plain_secret');
    expect(cipher.decrypt('binding-a', 'refresh_token', sealed)).toBe('rt_plain_secret');

    const again = cipher.encrypt('binding-a', 'refresh_token', 'rt_plain_secret');
    expect(again).not.toBe(sealed);
    expect(cipher.decrypt('binding-a', 'refresh_token', again)).toBe('rt_plain_secret');
  });

  it('AAD 绑定 bindingId 与字段名：串号 / 字段互换都失败', () => {
    const cipher = createTokenCipher(TEST_ENC_KEY);
    const sealed = cipher.encrypt('binding-a', 'refresh_token', 'rt_plain_secret');

    expect(() => cipher.decrypt('binding-b', 'refresh_token', sealed)).toThrow(TokenCipherError);
    expect(() => cipher.decrypt('binding-a', 'access_token', sealed)).toThrow(TokenCipherError);
  });

  it('错误密钥 / 篡改密文 / 非法密钥都失败（绝不回退明文）', () => {
    const cipher = createTokenCipher(TEST_ENC_KEY);
    const sealed = cipher.encrypt('binding-a', 'access_token', 'at_plain_secret');

    const otherKey = newTestKey();
    const other = createTokenCipher(otherKey);
    expect(() => other.decrypt('binding-a', 'access_token', sealed)).toThrow(TokenCipherError);

    const parts = sealed.split('.');
    const ciphertext = parts[3] ?? '';
    parts[3] = ciphertext.endsWith('AA') ? `${ciphertext.slice(0, -2)}BB` : `${ciphertext.slice(0, -2)}AA`;
    expect(() => cipher.decrypt('binding-a', 'access_token', parts.join('.'))).toThrow(
      TokenCipherError,
    );

    expect(() => createTokenCipher(Buffer.alloc(31).toString('base64'))).toThrow(TokenCipherError);
    expect(() => cipher.decrypt('binding-a', 'access_token', 'not-a-sealed-value')).toThrow(
      TokenCipherError,
    );
  });
});

describe('SQLite BindingStore', () => {
  it('目录不存在会自动创建；upsert 后可按 QQ openid 读回并解密', async () => {
    const dir = tempDir();
    const dbPath = `${dir}/nested/deeper/bot.db`;
    const store = createBindingStore({ DB_PATH: dbPath, TOKEN_ENC_KEY: TEST_ENC_KEY });
    cleanup.push(() => store.close());

    expect(existsSync(dbPath)).toBe(true);
    expect(await store.getByQqUser('qq-openid-1')).toBeNull();
    const binding = await store.upsert(bindingInput);

    expect(binding.id).toMatch(/[0-9a-f-]{36}/);
    expect(binding.status).toBe('active');
    expect(binding.createdAt).toBeGreaterThan(0);
    expect(store.decryptRefreshToken(binding)).toBe('rt_plain_secret');
    expect(store.decryptAccessToken(binding)).toBe('at_plain_secret');
  });

  it('重复 upsert 同一 QQ 用户时 id 稳定，且新密文仍可解密（AAD 用库里的 id）', async () => {
    const store = openStore(tempDir());
    const first = await store.upsert(bindingInput);
    const second = await store.upsert({
      ...bindingInput,
      rankhubName: '新名字',
      refreshToken: 'rt_second',
      accessToken: 'at_second',
    });

    expect(second.id).toBe(first.id);
    expect(second.rankhubName).toBe('新名字');
    expect(store.decryptRefreshToken(second)).toBe('rt_second');
    expect(store.decryptAccessToken(second)).toBe('at_second');
  });

  it('token 以密文入库：原始行读不到明文，是 v1 封套', async () => {
    const dir = tempDir();
    const store = openStore(dir);
    await store.upsert(bindingInput);

    const raw = new DatabaseSync(`${dir}/bot.db`);
    try {
      const row = raw
        .prepare('SELECT refresh_token_enc, access_token_enc FROM bindings WHERE qq_user_openid = ?')
        .get('qq-openid-1') as { refresh_token_enc: string; access_token_enc: string };
      expect(row.refresh_token_enc.startsWith('v1.')).toBe(true);
      expect(row.access_token_enc.startsWith('v1.')).toBe(true);
      expect(row.refresh_token_enc).not.toContain('rt_plain_secret');
      expect(row.access_token_enc).not.toContain('at_plain_secret');
    } finally {
      raw.close();
    }
  });

  it('updateTokens 原子更新两个令牌与过期时间；不存在的 binding 直接失败', async () => {
    const store = openStore(tempDir());
    const binding = await store.upsert(bindingInput);

    await store.updateTokens(binding.id, {
      accessToken: 'at_rotated',
      refreshToken: 'rt_rotated',
      accessExpiresAt: 1_770_000_000_000,
      scopes: 'openid',
    });
    const updated = await store.getById(binding.id);
    expect(updated).not.toBeNull();
    if (updated === null) throw new Error('unreachable');
    expect(updated.accessExpiresAt).toBe(1_770_000_000_000);
    expect(updated.scopes).toBe('openid');
    expect(store.decryptAccessToken(updated)).toBe('at_rotated');
    expect(store.decryptRefreshToken(updated)).toBe('rt_rotated');

    await expect(
      store.updateTokens('missing-binding', {
        accessToken: 'at_x',
        refreshToken: 'rt_x',
        accessExpiresAt: 1,
        scopes: 'openid',
      }),
    ).rejects.toThrow(/不存在/);
  });

  it('markRevoked 幂等、deleteByQqUser 删除绑定', async () => {
    const store = openStore(tempDir());
    const binding = await store.upsert(bindingInput);

    await store.markRevoked(binding.id);
    expect((await store.getById(binding.id))?.status).toBe('revoked');
    await store.markRevoked(binding.id); // 幂等
    expect((await store.getById(binding.id))?.status).toBe('revoked');

    await store.deleteByQqUser('qq-openid-1');
    expect(await store.getByQqUser('qq-openid-1')).toBeNull();
    expect(await store.getById(binding.id)).toBeNull();
  });

  it('迁移幂等：重开同一个库不重复建表、数据仍在、user_version 正确、WAL 生效', async () => {
    const dir = tempDir();
    const first = makeStore(dir);
    await first.upsert(bindingInput);
    first.close();

    const second = openStore(dir);
    await second.markRevoked((await second.getByQqUser('qq-openid-1'))?.id ?? '');
    expect(await second.getByQqUser('qq-openid-1')).not.toBeNull();

    const raw = new DatabaseSync(`${dir}/bot.db`);
    try {
      const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(Number(version.user_version)).toBe(SCHEMA_VERSION);
      const journal = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(String(journal.journal_mode).toLowerCase()).toBe('wal');
    } finally {
      raw.close();
    }
  });

  it('换错密钥能打开库但解密必失败', async () => {
    const dir = tempDir();
    const original = makeStore(dir);
    await original.upsert(bindingInput);
    original.close();

    const wrongKeyStore = openStore(dir, newTestKey());
    const binding = await wrongKeyStore.getByQqUser('qq-openid-1');
    expect(binding).not.toBeNull();
    if (binding === null) throw new Error('unreachable');
    expect(() => wrongKeyStore.decryptRefreshToken(binding)).toThrow(TokenCipherError);
    expect(() => wrongKeyStore.decryptAccessToken(binding)).toThrow(TokenCipherError);
  });

  it('pending_devices：保存 / 读取 / 列表 / 删除 / 清理过期', async () => {
    const store = openStore(tempDir());
    const device = pending();
    await store.savePendingDevice(device);
    expect(await store.getPendingDevice('qq-openid-1')).toEqual(device);
    expect(await store.listPendingDevices()).toHaveLength(1);

    // 覆盖同一个用户
    await store.savePendingDevice({ ...device, nextReplySeq: 2, userCode: 'ZZZZ-ZZZZ' });
    expect((await store.getPendingDevice('qq-openid-1'))?.nextReplySeq).toBe(2);

    // 另一个用户 + 过期清理
    await store.savePendingDevice(pending({ qqUserOpenid: 'qq-openid-2', expiresAt: 1_000 }));
    expect(await store.listPendingDevices()).toHaveLength(2);
    expect(await store.purgeExpiredPendingDevices(2_000)).toBe(1);
    expect(await store.getPendingDevice('qq-openid-2')).toBeNull();

    await store.deletePendingDevice('qq-openid-1');
    expect(await store.getPendingDevice('qq-openid-1')).toBeNull();
  });
});
