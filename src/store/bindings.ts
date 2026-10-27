import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type {
  Binding,
  BindingStatus,
  BindingStore,
  PendingDevice,
} from '../contracts/index.js';

import { createTokenCipher, type TokenCipher } from './crypto.js';
import {
  DatabaseSyncCtor as DatabaseSync,
  type DatabaseSync as DatabaseSyncType,
  type StatementSync,
} from './sqlite.js';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  type BindingRow,
  type PendingDeviceRow,
} from './schema.js';

/** `createBindingStore` 需要的最小配置（`loadConfig()` 的返回值天然满足）。 */
export interface BindingStoreConfig {
  DB_PATH: string;
  TOKEN_ENC_KEY: string;
}

export interface BindingStoreOptions {
  /** 测试注入时钟；默认 `Date.now`。 */
  now?: () => number;
}

/**
 * 契约 `BindingStore` 的超集：契约只有 QQ openid 入口，但运行期还需要这些。
 * （契约文件是冻结接口，扩展放在这里，不改 contracts。）
 */
export interface SqliteBindingStore extends BindingStore {
  getById(bindingId: string): Promise<Binding | null>;
  /** 用 `binding.id` + 字段名作 AAD 解密 access token。 */
  decryptAccessToken(binding: Binding): string;
  /** 用 `binding.id` + 字段名作 AAD 解密 refresh token。 */
  decryptRefreshToken(binding: Binding): string;
  savePendingDevice(device: PendingDevice): Promise<void>;
  getPendingDevice(qqUserOpenid: string): Promise<PendingDevice | null>;
  listPendingDevices(): Promise<PendingDevice[]>;
  deletePendingDevice(qqUserOpenid: string): Promise<void>;
  /** 删掉已过期的设备码会话，返回删除条数。 */
  purgeExpiredPendingDevices(now?: number): Promise<number>;
  /** 关闭底层连接（测试 / 进程退出用）。 */
  close(): void;
}

function toBinding(row: BindingRow): Binding {
  const status: BindingStatus = row.status === 'revoked' ? 'revoked' : 'active';
  if (row.status !== 'active' && row.status !== 'revoked') {
    throw new Error(`bindings.status 出现未知值：${String(row.status)}`);
  }
  return {
    id: row.id,
    qqUserOpenid: row.qq_user_openid,
    unionOpenid: row.union_openid,
    rankhubSubject: row.rankhub_subject,
    rankhubName: row.rankhub_name,
    refreshTokenEnc: row.refresh_token_enc,
    accessTokenEnc: row.access_token_enc,
    accessExpiresAt: row.access_expires_at === null ? null : Number(row.access_expires_at),
    scopes: row.scopes,
    status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toPendingDevice(row: PendingDeviceRow): PendingDevice {
  return {
    qqUserOpenid: row.qq_user_openid,
    unionOpenid: row.union_openid,
    deviceCode: row.device_code,
    userCode: row.user_code,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    messageId: row.message_id,
    groupOpenid: row.group_openid,
    nextReplySeq: Number(row.next_reply_seq),
  };
}

function transaction<T>(db: DatabaseSyncType, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误（它是更有信息量的那个）。
    }
    throw error;
  }
}

function migrate(db: DatabaseSyncType): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}：请升级程序，不要降级运行`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      // PRAGMA 不能参数化；version 来自代码内常量，不是外部输入。
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 同上。
      }
      throw error;
    }
  }
}

/**
 * 打开（必要时创建）SQLite 库并返回 `BindingStore` 实现。
 *
 * - 目录不存在会自动创建；
 * - 开 WAL（并发读不阻塞写；`PRAGMA journal_mode = WAL` 对 `:memory:` 会回落为 memory，不报错）；
 * - access / refresh token 一律 AES-256-GCM 加密入库（AAD = `${bindingId}:${field}`）。
 */
export function createBindingStore(
  config: BindingStoreConfig,
  options: BindingStoreOptions = {},
): SqliteBindingStore {
  const now = options.now ?? (() => Date.now());
  const dbPath = config.DB_PATH;
  if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const cipher: TokenCipher = createTokenCipher(config.TOKEN_ENC_KEY);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const selectByQqUser: StatementSync = db.prepare(
    'SELECT * FROM bindings WHERE qq_user_openid = ? LIMIT 1',
  );
  const selectById: StatementSync = db.prepare('SELECT * FROM bindings WHERE id = ? LIMIT 1');
  const upsertBinding: StatementSync = db.prepare(`
    INSERT INTO bindings (
      id, qq_user_openid, union_openid, rankhub_subject, rankhub_name,
      refresh_token_enc, access_token_enc, access_expires_at, scopes, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT (qq_user_openid) DO UPDATE SET
      union_openid = excluded.union_openid,
      rankhub_subject = excluded.rankhub_subject,
      rankhub_name = excluded.rankhub_name,
      refresh_token_enc = excluded.refresh_token_enc,
      access_token_enc = excluded.access_token_enc,
      access_expires_at = excluded.access_expires_at,
      scopes = excluded.scopes,
      status = 'active',
      updated_at = excluded.updated_at
  `);
  const updateTokensStmt: StatementSync = db.prepare(`
    UPDATE bindings
       SET access_token_enc = ?, refresh_token_enc = ?, access_expires_at = ?, scopes = ?, updated_at = ?
     WHERE id = ?
  `);
  const markRevokedStmt: StatementSync = db.prepare(
    `UPDATE bindings SET status = 'revoked', updated_at = ? WHERE id = ?`,
  );
  const deleteByQqUserStmt: StatementSync = db.prepare(
    'DELETE FROM bindings WHERE qq_user_openid = ?',
  );

  const selectPending: StatementSync = db.prepare(
    'SELECT * FROM pending_devices WHERE qq_user_openid = ? LIMIT 1',
  );
  const selectAllPending: StatementSync = db.prepare(
    'SELECT * FROM pending_devices ORDER BY created_at ASC',
  );
  const upsertPending: StatementSync = db.prepare(`
    INSERT INTO pending_devices (
      qq_user_openid, union_openid, device_code, user_code, expires_at, created_at,
      message_id, group_openid, next_reply_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (qq_user_openid) DO UPDATE SET
      union_openid = excluded.union_openid,
      device_code = excluded.device_code,
      user_code = excluded.user_code,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      message_id = excluded.message_id,
      group_openid = excluded.group_openid,
      next_reply_seq = excluded.next_reply_seq
  `);
  const deletePending: StatementSync = db.prepare(
    'DELETE FROM pending_devices WHERE qq_user_openid = ?',
  );
  const purgePending: StatementSync = db.prepare(
    'DELETE FROM pending_devices WHERE expires_at <= ?',
  );

  const store: SqliteBindingStore = {
    async getByQqUser(qqUserOpenid: string): Promise<Binding | null> {
      const row = selectByQqUser.get(qqUserOpenid) as unknown as BindingRow | undefined;
      return row === undefined ? null : toBinding(row);
    },

    async getById(bindingId: string): Promise<Binding | null> {
      const row = selectById.get(bindingId) as unknown as BindingRow | undefined;
      return row === undefined ? null : toBinding(row);
    },

    async upsert(input): Promise<Binding> {
      return transaction(db, () => {
        const existing = selectByQqUser.get(input.qqUserOpenid) as unknown as
          | BindingRow
          | undefined;
        // 用「库里已有的 id」而不是新 UUID 加密：AAD 里的 bindingId 必须与落库的 id 一致，
        // 否则重新绑定（upsert 命中 ON CONFLICT）后旧密文还能解、新密文却解不开。
        const id = existing?.id ?? randomUUID();
        const timestamp = now();
        const refreshTokenEnc = cipher.encrypt(id, 'refresh_token', input.refreshToken);
        const accessTokenEnc = cipher.encrypt(id, 'access_token', input.accessToken);
        upsertBinding.run(
          id,
          input.qqUserOpenid,
          input.unionOpenid,
          input.rankhubSubject,
          input.rankhubName,
          refreshTokenEnc,
          accessTokenEnc,
          input.accessExpiresAt,
          input.scopes,
          timestamp,
          timestamp,
        );
        const row = selectByQqUser.get(input.qqUserOpenid) as unknown as BindingRow | undefined;
        if (row === undefined) throw new Error('bindings upsert 后读不到刚写入的行');
        return toBinding(row);
      });
    },

    async updateTokens(bindingId, input): Promise<void> {
      transaction(db, () => {
        const accessTokenEnc = cipher.encrypt(bindingId, 'access_token', input.accessToken);
        const refreshTokenEnc = cipher.encrypt(bindingId, 'refresh_token', input.refreshToken);
        const result = updateTokensStmt.run(
          accessTokenEnc,
          refreshTokenEnc,
          input.accessExpiresAt,
          input.scopes,
          now(),
          bindingId,
        );
        if (Number(result.changes) === 0) {
          throw new Error(`binding ${bindingId} 不存在，updateTokens 未写入任何行`);
        }
      });
    },

    async markRevoked(bindingId: string): Promise<void> {
      // 幂等：binding 已不存在 / 已 revoked 都不视为错误。
      markRevokedStmt.run(now(), bindingId);
    },

    async deleteByQqUser(qqUserOpenid: string): Promise<void> {
      transaction(db, () => {
        deleteByQqUserStmt.run(qqUserOpenid);
      });
    },

    decryptAccessToken(binding: Binding): string {
      if (binding.accessTokenEnc === null) {
        throw new Error('该 binding 没有存 access token（可能尚未登录或已撤销）');
      }
      return cipher.decrypt(binding.id, 'access_token', binding.accessTokenEnc);
    },

    decryptRefreshToken(binding: Binding): string {
      return cipher.decrypt(binding.id, 'refresh_token', binding.refreshTokenEnc);
    },

    async savePendingDevice(device: PendingDevice): Promise<void> {
      upsertPending.run(
        device.qqUserOpenid,
        device.unionOpenid,
        device.deviceCode,
        device.userCode,
        device.expiresAt,
        device.createdAt,
        device.messageId,
        device.groupOpenid,
        device.nextReplySeq,
      );
    },

    async getPendingDevice(qqUserOpenid: string): Promise<PendingDevice | null> {
      const row = selectPending.get(qqUserOpenid) as unknown as PendingDeviceRow | undefined;
      return row === undefined ? null : toPendingDevice(row);
    },

    async listPendingDevices(): Promise<PendingDevice[]> {
      const rows = selectAllPending.all() as unknown as PendingDeviceRow[];
      return rows.map(toPendingDevice);
    },

    async deletePendingDevice(qqUserOpenid: string): Promise<void> {
      deletePending.run(qqUserOpenid);
    },

    async purgeExpiredPendingDevices(at?: number): Promise<number> {
      const result = purgePending.run(at ?? now());
      return Number(result.changes);
    },

    close(): void {
      db.close();
    },
  };

  return store;
}
