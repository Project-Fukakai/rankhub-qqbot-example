/**
 * /arc（别名 /arcaea /b50a）：Arcaea B50 海报。
 *
 * 版式照搬 best-posters 的 arcaea 分支（`src/render/arc`，Playwright 截图）。
 * 成绩来自 `GET /v1/games/arcaea/profiles/{id}/bests`；条目直接传 `GameScore`，
 * 渲染层会从 `native` 摊平 song_id/score/potential/clear_type 等字段。
 */
import { prefetchArcaeaCovers } from '../rankhub/arc-assets.js';
import { ArcaeaSongTitleCache, fetchArcaeaSongTitles } from '../rankhub/arc-songlist.js';

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

/**
 * 曲名目录缓存（进程级）：v1 的 arcaea 成绩没有 `songName`，用公开的官方 songlist 补。
 * 见 `src/rankhub/arc-songlist.ts`。
 */
let titleCache: ArcaeaSongTitleCache | null = null;

function getTitleCache(services: Parameters<CommandHandler>[0]): ArcaeaSongTitleCache {
  if (titleCache === null) {
    titleCache = new ArcaeaSongTitleCache(() =>
      fetchArcaeaSongTitles({
        apiBase: services.config.RANKHUB_API_BASE,
        logger: services.logger,
      }),
    );
  }
  return titleCache;
}

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

    // 曲名来自官方 songlist（v1 不返回 songName）；先补标题再预取曲绘。
    const songTitles = await timed(services, 'fetchArcaeaSongTitles', () => getTitleCache(services).get());

    // 曲绘来源对齐 App：按 song_id 从 RankHub 资源 CDN 取官方 jacket（本地 best-posters 仅兜底）。
    const covers = await timed(services, 'prefetchArcaeaCovers', () =>
      prefetchArcaeaCovers(items.map((item) => item.songId)),
    );
    const itemsWithCovers = items.map((item) => ({
      ...item,
      songName: item.songName ?? songTitles.titles.get(item.songId) ?? null,
      coverUrl: covers.get(item.songId) ?? null,
    }));

    services.logger.info('Arcaea 曲目映射采样（排查曲名/曲绘）', {
      sample: itemsWithCovers.slice(0, 5).map((item) => ({
        songId: item.songId,
        songName: item.songName,
        hasCover: typeof item.coverUrl === 'string' && item.coverUrl.startsWith('data:'),
      })),
      titles: songTitles.titles.size,
      covers: covers.size,
      total: items.length,
    });

    const potential =
      typeof bests.totals.potential === 'number'
        ? bests.totals.potential
        : (profile.player.rating ?? null);

    try {
      const image = await timed(services, 'renderArcaeaB50', () =>
        render.call(services.renderer, {
          profileName: profile.player.name ?? 'Player',
          potential,
          items: itemsWithCovers,
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
