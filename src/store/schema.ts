/**
 * SQLite schema 迁移。
 *
 * 纪律：
 * - 只增不改：已发布的迁移语句一旦上线就不再修改，后续变更追加新的一段；
 * - 每段在事务里执行并推进 `PRAGMA user_version`，所以**重复打开同一个库是幂等的**；
 * - 表名 / 列名用 snake_case（SQL 侧惯例），映射回 contracts 的 camelCase 在 bindings.ts 里做。
 */

export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY,
        qq_user_openid TEXT NOT NULL UNIQUE,
        union_openid TEXT,
        rankhub_subject TEXT NOT NULL,
        rankhub_name TEXT,
        refresh_token_enc TEXT NOT NULL,
        access_token_enc TEXT,
        access_expires_at INTEGER,
        scopes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_bindings_qq_user ON bindings (qq_user_openid)`,
      `CREATE INDEX IF NOT EXISTS idx_bindings_status ON bindings (status)`,
      `CREATE TABLE IF NOT EXISTS pending_devices (
        qq_user_openid TEXT PRIMARY KEY,
        union_openid TEXT,
        device_code TEXT NOT NULL,
        user_code TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        group_openid TEXT,
        next_reply_seq INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pending_devices_expires ON pending_devices (expires_at)`,
    ],
  },
];

/** bindings 表的原始行。 */
export interface BindingRow {
  id: string;
  qq_user_openid: string;
  union_openid: string | null;
  rankhub_subject: string;
  rankhub_name: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: number | null;
  scopes: string;
  status: string;
  created_at: number;
  updated_at: number;
}

/** pending_devices 表的原始行。 */
export interface PendingDeviceRow {
  qq_user_openid: string;
  union_openid: string | null;
  device_code: string;
  user_code: string;
  expires_at: number;
  created_at: number;
  message_id: string;
  group_openid: string | null;
  next_reply_seq: number;
}

/** 当前 schema 版本（迁移段数）。 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
