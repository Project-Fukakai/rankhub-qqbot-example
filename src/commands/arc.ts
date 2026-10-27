/**
 * /arc（别名 /arcaea /b50a）：Arcaea B50 海报。
 *
 * 版式照搬 best-posters 的 arcaea 分支（`src/render/arc`，Playwright 截图）。
 * 成绩来自 `GET /v1/games/arcaea/profiles/{id}/bests`；条目直接传 `GameScore`，
 * 渲染层会从 `native` 摊平 song_id/score/potential/clear_type 等字段。
 */
import type { CommandHandler } from './common.js';
import {
  loadProfiles,
  pickLatestProfile,
  sendImage,
  sendProcessing,
  sendText,
  summarizeBests,
  timed,
  withAuthorized,
} from './common.js';

const MAX_ITEMS = 50;

export const arcCommand: CommandHandler = async (services, ctx) => {
  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    const render = services.renderer.renderArcaeaB50;
    const profiles = await loadProfiles(services, binding, accessToken, 'arcaea');
    if (profiles.length === 0) {
      await sendText(services, ctx, '你还没有 arcaea 档案。请先在 RankHub 上传 arcaea 成绩后再试。');
      return;
    }
    const profile = pickLatestProfile(profiles);
    if (profile === null) {
      await sendText(services, ctx, '没有找到可用的 arcaea 档案。');
      return;
    }

    await sendProcessing(services, ctx, '生成 Arcaea B50');
    const bests = await timed(services, 'getBests(arcaea)', () =>
      services.rankhub.getBests(accessToken, 'arcaea', profile.profileId),
    );

    const items = bests.buckets
      .flatMap((bucket) => bucket.items)
      .slice(0, MAX_ITEMS);
    if (items.length === 0) {
      await sendText(services, ctx, '这个 arcaea 档案里还没有成绩记录，无法生成 B50。');
      return;
    }
    if (render === undefined) {
      await sendText(
        services,
        ctx,
        `arcaea 图片渲染暂不可用，先给你文字版：\n${summarizeBests('arcaea', bests, 10)}`,
      );
      return;
    }

    const potential =
      typeof bests.totals.potential === 'number'
        ? bests.totals.potential
        : (profile.player.rating ?? null);

    try {
      const image = await timed(services, 'renderArcaeaB50', () =>
        render.call(services.renderer, {
          profileName: profile.player.name ?? 'Player',
          potential,
          items,
          computedAt: bests.computedAt,
        }),
      );
      await sendImage(services, ctx, image, `arcaea-b50-${profile.profileId}.png`);
    } catch (error) {
      ctx.logger.warn('Arcaea B50 渲染失败，降级为文字摘要', {
        reason: error instanceof Error ? error.message : String(error),
      });
      await sendText(
        services,
        ctx,
        `图片渲染暂时不可用，先给你文字版：\n${summarizeBests('arcaea', bests, 10)}`,
      );
    }
  });
};
