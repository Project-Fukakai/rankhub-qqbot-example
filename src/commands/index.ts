/**
 * 指令注册表：规范名 → handler，别名（含中文、大小写）→ 规范名。
 *
 * 解析只接受**首 token**（dispatcher 已小写）；中文别名不做大小写处理。
 */
import type { CommandHandler, CommandServices } from './common.js';
import { b50Command } from './b50.js';
import { bestCommand } from './best.js';
import { bindCommand } from './bind.js';
import { gamesCommand } from './games.js';
import { helpCommand } from './help.js';
import { meCommand } from './me.js';
import { rksCommand } from './rks.js';
import { scoreCommand } from './score.js';
import { statusCommand } from './status.js';
import { unbindCommand } from './unbind.js';

export interface ResolvedCommand {
  name: string;
  handler: CommandHandler;
}

export interface CommandRegistry {
  /** 首 token → 指令；未知返回 null（dispatcher 回帮助提示）。 */
  resolve(token: string): ResolvedCommand | null;
  /** 规范指令名列表（诊断用）。 */
  commands(): readonly string[];
  /** 停机关闭后台任务（转发 runtime.close）。 */
  close(): Promise<void>;
}

/** 规范名 → handler。 */
const HANDLERS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ['help', helpCommand],
  ['games', gamesCommand],
  ['bind', bindCommand],
  ['unbind', unbindCommand],
  ['me', meCommand],
  ['b50', b50Command],
  ['rks', rksCommand],
  ['best', bestCommand],
  ['score', scoreCommand],
  ['status', statusCommand],
]);

/** 别名（key 一律小写；中文别名保持原样）。 */
const ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  // help
  ['help', 'help'],
  ['h', 'help'],
  ['?', 'help'],
  ['帮助', 'help'],
  ['菜单', 'help'],
  // games
  ['games', 'games'],
  ['game', 'games'],
  ['能力', 'games'],
  ['游戏', 'games'],
  // bind
  ['bind', 'bind'],
  ['login', 'bind'],
  ['绑定', 'bind'],
  ['登录', 'bind'],
  // unbind
  ['unbind', 'unbind'],
  ['logout', 'unbind'],
  ['解绑', 'unbind'],
  ['注销', 'unbind'],
  // me
  ['me', 'me'],
  ['info', 'me'],
  ['我的', 'me'],
  ['信息', 'me'],
  // b50
  ['b50', 'b50'],
  ['maimaib50', 'b50'],
  ['舞萌b50', 'b50'],
  ['成绩', 'b50'],
  // rks
  ['rks', 'rks'],
  ['phi', 'rks'],
  ['phigros', 'rks'],
  ['屁股肉', 'rks'],
  ['屁股肉rks', 'rks'],
  // best
  ['best', 'best'],
  ['最佳', 'best'],
  ['b', 'best'],
  // score
  ['score', 'score'],
  ['查分', 'score'],
  ['搜歌', 'score'],
  ['搜索', 'score'],
  ['s', 'score'],
  // status
  ['status', 'status'],
  ['状态', 'status'],
  ['状态查询', 'status'],
]);

export function createCommandRegistry(services: CommandServices): CommandRegistry {
  const canonicalNames = [...HANDLERS.keys()];
  return {
    resolve(token: string): ResolvedCommand | null {
      const key = token.trim().toLowerCase();
      if (key === '') return null;
      const canonical = ALIASES.get(key);
      if (canonical === undefined) return null;
      const handler = HANDLERS.get(canonical);
      if (handler === undefined) return null;
      return { name: canonical, handler };
    },
    commands(): readonly string[] {
      return canonicalNames;
    },
    close(): Promise<void> {
      return services.runtime.close();
    },
  };
}
