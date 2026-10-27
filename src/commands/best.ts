/**
 * /best <game>：最佳成绩桶的纯文本列表（key/label/total + 前 5 条）。
 */
import type { CommandHandler } from './common.js';
import {
  GAME_HINT,
  loadProfiles,
  normalizeGame,
  pickLatestProfile,
  sendText,
  sendProcessing,
  summarizeBests,
  timed,
  withAuthorized,
} from './common.js';

export const bestCommand: CommandHandler = async (services, ctx) => {
  const game = normalizeGame(ctx.args);
  if (game === null) {
    await sendText(
      services,
      ctx,
      ctx.args === ''
        ? `用法：/best <游戏>。${GAME_HINT}`
        : `未知游戏「${ctx.args}」。${GAME_HINT}`,
    );
    return;
  }

  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    const profiles = await loadProfiles(services, binding, accessToken, game);
    if (profiles.length === 0) {
      await sendText(services, ctx, `你还没有 ${game} 档案，无法查询最佳成绩。`);
      return;
    }
    const profile = pickLatestProfile(profiles);
    if (profile === null) {
      await sendText(services, ctx, `没有找到可用的 ${game} 档案。`);
      return;
    }
    await sendProcessing(services, ctx, '查询最佳成绩');
    const bests = await timed(services, `getBests(${game})`, () =>
      services.rankhub.getBests(accessToken, game, profile.profileId),
    );
    await sendText(services, ctx, summarizeBests(game, bests, 5));
  });
};
