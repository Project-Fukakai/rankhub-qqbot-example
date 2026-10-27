/**
 * /rks：Phigros RKS（b19）图片。
 *
 * 取 `buckets.phi` / `buckets.best30` 与 `totals.rks` / `totals.officialRks`，
 * 渲染失败同样降级为文字摘要（warn 留痕，不吞错）。
 */
import type { CommandHandler } from './common.js';
import {
  loadProfiles,
  pickLatestProfile,
  sendImage,
  sendText,
  summarizeBests,
  timed,
  withAuthorized,
} from './common.js';

export const rksCommand: CommandHandler = async (services, ctx) => {
  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    const profiles = await loadProfiles(services, binding, accessToken, 'phigros');
    if (profiles.length === 0) {
      await sendText(
        services,
        ctx,
        '你还没有 phigros 档案。请先在 RankHub 上传 phigros 成绩后再试。',
      );
      return;
    }
    const profile = pickLatestProfile(profiles);
    if (profile === null) {
      await sendText(services, ctx, '没有找到可用的 phigros 档案。');
      return;
    }

    const bests = await timed(services, 'getBests(phigros)', () =>
      services.rankhub.getBests(accessToken, 'phigros', profile.profileId),
    );

    const bucketByKey = new Map(bests.buckets.map((bucket) => [bucket.key, bucket]));
    const phi = bucketByKey.get('phi')?.items ?? [];
    const best = bucketByKey.get('best30')?.items ?? [];

    if (phi.length === 0 && best.length === 0) {
      await sendText(services, ctx, '这个 phigros 档案里还没有成绩记录，无法生成 RKS 图。');
      return;
    }

    const rks =
      typeof bests.totals.rks === 'number' ? bests.totals.rks : (profile.player.rating ?? 0);
    const official =
      typeof bests.totals.officialRks === 'number' ? bests.totals.officialRks : null;

    try {
      const image = await services.renderer.renderPhigrosRks({
        profileName: profile.player.name ?? 'Player',
        rks,
        officialRks: official,
        phi,
        best,
        computedAt: bests.computedAt,
      });
      await sendImage(services, ctx, image, `rks-${profile.profileId}.png`);
    } catch (error) {
      ctx.logger.warn('Phigros RKS 渲染失败，降级为文字摘要', {
        reason: error instanceof Error ? error.message : String(error),
      });
      await sendText(
        services,
        ctx,
        `图片渲染暂时不可用，先给你文字版：\n${summarizeBests('phigros', bests)}\n\n（RKS ${rks}${
          official === null ? '' : `，官方 RKS ${official}`
        }）`,
      );
    }
  });
};
