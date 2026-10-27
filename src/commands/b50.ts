/**
 * /b50：maimai B50 图片。
 *
 * 档案选择：maimai profiles 里取 `updatedAt` 最新的一张（多档案用户）。
 * 渲染失败（模块/资源/浏览器不可用）**不吞掉**：日志 warn + 降级为文字成绩摘要。
 */
import type { CommandHandler } from './common.js';
import {
  loadProfiles,
  pickLatestProfile,
  sendImage,
  sendText,
  sendProcessing,
  summarizeBests,
  timed,
  withAuthorized,
} from './common.js';

export const b50Command: CommandHandler = async (services, ctx) => {
  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    const profiles = await loadProfiles(services, binding, accessToken, 'maimai');
    if (profiles.length === 0) {
      await sendText(
        services,
        ctx,
        '你还没有 maimai 档案。请先在 RankHub 上传 maimai 成绩后再试。',
      );
      return;
    }
    const profile = pickLatestProfile(profiles);
    if (profile === null) {
      await sendText(services, ctx, '没有找到可用的 maimai 档案。');
      return;
    }

    await sendProcessing(services, ctx, '生成 maimai B50');
    const bests = await timed(services, 'getBests(maimai)', () =>
      services.rankhub.getBests(accessToken, 'maimai', profile.profileId),
    );

    const totalItems = bests.buckets.reduce((sum, bucket) => sum + bucket.items.length, 0);
    if (totalItems === 0) {
      await sendText(services, ctx, '这个 maimai 档案里还没有成绩记录，无法生成 B50。');
      return;
    }

    const rating =
      typeof bests.totals.total === 'number' ? bests.totals.total : (profile.player.rating ?? 0);

    try {
      const image = await services.renderer.renderMaimaiB50({
        profileName: profile.player.name ?? 'Player',
        rating,
        buckets: bests.buckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          total: bucket.total,
          items: bucket.items,
        })),
        totals: bests.totals,
        computedAt: bests.computedAt,
      });
      await sendImage(services, ctx, image, `b50-${profile.profileId}.png`);
    } catch (error) {
      ctx.logger.warn('maimai B50 渲染失败，降级为文字摘要', {
        reason: error instanceof Error ? error.message : String(error),
      });
      const summary = summarizeBests('maimai', bests);
      await sendText(
        services,
        ctx,
        `图片渲染暂时不可用，先给你文字版：\n${summary}\n\n（Rating ${rating}）`,
      );
    }
  });
};
