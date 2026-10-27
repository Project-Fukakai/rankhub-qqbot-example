/**
 * /help /帮助：指令清单 + 绑定说明。
 */
import type { CommandHandler } from './common.js';
import { sendText } from './common.js';

const HELP_TEXT = [
  'RankHub 查询机器人指令：',
  '/help 或 /帮助 —— 显示本帮助',
  '/games 或 /能力 —— 查看账号可用的游戏',
  '/bind [UID] 或 /绑定 —— 绑定 RankHub 账号（App 扫码确认）',
  '/unbind 或 /解绑 —— 解除绑定',
  '/me 或 /我的 —— 生成玩家名片（账号 + maimai/phigros/arcaea 档案 + 二维码）',
  '/b50 —— 生成 maimai B50 图片',
  '/arc 或 /arcaea —— 生成 Arcaea B50 图片',
  '/rks —— 生成 Phigros RKS 图片',
  '/best <游戏> —— 查看最佳成绩桶（maimai / phigros）',
  '/score [游戏] <关键词> —— 按曲名搜索成绩（默认 maimai）',
  '/status 或 /状态 —— 查看绑定与运行状态',
  '',
  '绑定说明：发送 /bind（群聊带 /bind <UID>）后机器人会回复二维码，用 RankHub App 扫码并在 App 内确认即可；10 分钟内有效。',
].join('\n');

export const helpCommand: CommandHandler = async (services, ctx) => {
  await sendText(services, ctx, HELP_TEXT);
};
