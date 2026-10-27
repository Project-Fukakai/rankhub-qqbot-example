/**
 * /me /我的：RankHub 账号信息 + 各游戏档案摘要（60s 缓存，按 binding 隔离）。
 */
import type { CommandHandler } from './common.js';
import {
  formatCount,
  formatDateTime,
  loadProfiles,
  sendProcessing,
  sendText,
  timed,
  withAuthorized,
} from './common.js';

const MAX_PROFILES_PER_GAME = 5;

export const meCommand: CommandHandler = async (services, ctx) => {
  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    const identity = await timed(services, 'userinfo', () =>
      services.rankhub.userinfo(accessToken),
    );
    await sendProcessing(services, ctx, '读取账号与档案');
    const games = await timed(services, 'listGames', () =>
      services.rankhub.listGames(accessToken),
    );

    const lines: string[] = [
      `RankHub 账号：${identity.name ?? identity.subject}`,
      `绑定时间：${formatDateTime(new Date(binding.createdAt).toISOString())}`,
    ];

    if (games.length === 0) {
      lines.push('可读游戏：无');
    } else {
      lines.push('档案摘要：');
      for (const game of games) {
        if (!game.read) {
          lines.push(`- ${game.game}：无读取权限`);
          continue;
        }
        try {
          const profiles = await loadProfiles(services, binding, accessToken, game.game);
          lines.push(`- ${game.game}：${formatCount(profiles.length)} 个档案`);
          if (profiles.length === 0) {
            lines.push('  （还没有上传过档案）');
          }
          for (const profile of profiles.slice(0, MAX_PROFILES_PER_GAME)) {
            const rating =
              profile.player.rating === null || profile.player.rating === undefined
                ? ''
                : ` / rating ${profile.player.rating}`;
            lines.push(
              `  · ${profile.player.name ?? '（未命名）'}${rating}（更新 ${formatDateTime(profile.updatedAt)}）`,
            );
          }
          if (profiles.length > MAX_PROFILES_PER_GAME) {
            lines.push(`  · … 其余 ${profiles.length - MAX_PROFILES_PER_GAME} 个档案`);
          }
        } catch (error) {
          ctx.logger.warn('读取档案失败', {
            game: game.game,
            reason: error instanceof Error ? error.message : String(error),
          });
          lines.push(`- ${game.game}：查询失败，请稍后重试`);
        }
      }
    }

    await sendText(services, ctx, lines.join('\n'));
  });
};
