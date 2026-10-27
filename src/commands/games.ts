/**
 * /games /能力：展示当前 RankHub 账号可用的游戏（不写死游戏列表）。
 */
import type { CommandHandler } from './common.js';
import { sendText, timed, withAuthorized } from './common.js';

export const gamesCommand: CommandHandler = async (services, ctx) => {
  await withAuthorized(services, ctx, async ({ accessToken }) => {
    const games = await timed(services, 'listGames', () =>
      services.rankhub.listGames(accessToken),
    );
    if (games.length === 0) {
      await sendText(services, ctx, '当前账号没有任何可用的游戏权限。');
      return;
    }
    const lines = ['RankHub 账号可用的游戏：'];
    for (const game of games) {
      const mark = game.read ? '✓' : '✗';
      const extras: string[] = [];
      if (game.pushProfile) extras.push('可上传档案');
      if (game.pushScores) extras.push('可上传成绩');
      if (game.deletionRequest) extras.push('可申请删除');
      lines.push(
        `${mark} ${game.game}：${game.read ? '可查询' : '无读取权限'}${
          extras.length > 0 ? `（${extras.join('、')}）` : ''
        }`,
      );
    }
    lines.push('使用 /me 查看档案摘要，/b50、/rks 生成成绩图。');
    await sendText(services, ctx, lines.join('\n'));
  });
};
