import { createRequire } from 'node:module';

import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * `node:sqlite` 的运行期加载入口。
 *
 * 为什么不用普通的 `import { DatabaseSync } from 'node:sqlite'`：
 * Vite 5 的内置模块表里还没有 `sqlite`，它会把 `node:sqlite` 剥成裸 `sqlite` 再去解析，
 * 于是 vitest 直接报 `Failed to load url sqlite`。`createRequire(...)` 是**运行期**求值，
 * 交给 Node 自己解析 `node:sqlite`，tsx / 生产运行 / vitest 三条路径都成立。
 *
 * 类型仍然来自 `@types/node` 的 `node:sqlite`（`import type` 会被擦除，不参与模块解析）。
 */

export type { DatabaseSync, StatementSync };

export type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

const require = createRequire(import.meta.url);
const nodeSqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };

export const DatabaseSyncCtor: DatabaseSyncConstructor = nodeSqlite.DatabaseSync;
