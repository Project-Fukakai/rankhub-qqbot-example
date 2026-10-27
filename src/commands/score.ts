/**
 * /score [game] <关键词>：按曲名模糊搜索成绩（默认 maimai）。
 *
 * - listScores 分页：limit=100、sortBy=rating、最多 10 页（1000 条）；
 * - 5 分钟内存缓存（按 binding/game/档案隔离），避免每次搜索都翻全量；
 * - 按 songName 不区分大小写包含匹配，取前 10 条。
 */
import type { GameScore, ScorePage, ScoresQuery } from '../contracts/index.js';

import type { CommandHandler } from './common.js';
import {
  GAME_HINT,
  formatAchievement,
  loadProfiles,
  normalizeGame,
  pickLatestProfile,
  sendText,
  timed,
  withAuthorized,
} from './common.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const MAX_RESULTS = 10;

function splitArgs(
  args: string,
): { game: string; keyword: string } | { error: string } {
  const trimmed = args.trim();
  if (trimmed === '') {
    return { error: `用法：/score [游戏] <关键词>。${GAME_HINT}` };
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const first = match?.[1] ?? '';
  const rest = (match?.[2] ?? '').trim();
  const gameByFirst = normalizeGame(first);
  if (gameByFirst !== null) {
    if (rest === '') {
      return { error: `用法：/score [游戏] <关键词>。例如 /score ${gameByFirst} 1000。` };
    }
    return { game: gameByFirst, keyword: rest };
  }
  return { game: 'maimai', keyword: trimmed };
}

function formatScoreLine(score: GameScore): string {
  const name = score.songName ?? `#${score.songId}`;
  const difficulty = [score.type, score.level ?? score.difficulty]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
  const rating = score.rating === null || score.rating === undefined ? '-' : String(score.rating);
  return `${name}${difficulty === '' ? '' : ` [${difficulty}]`} ${formatAchievement(
    score.achievements,
  )} → ${rating}`;
}

export const scoreCommand: CommandHandler = async (services, ctx) => {
  const parsed = splitArgs(ctx.args);
  if ('error' in parsed) {
    await sendText(services, ctx, parsed.error);
    return;
  }
  const { game, keyword } = parsed;

  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    const profiles = await loadProfiles(services, binding, accessToken, game);
    if (profiles.length === 0) {
      await sendText(services, ctx, `你还没有 ${game} 档案，无法查询成绩。`);
      return;
    }
    const profile = pickLatestProfile(profiles);
    if (profile === null) {
      await sendText(services, ctx, `没有找到可用的 ${game} 档案。`);
      return;
    }

    let all = services.runtime.getScores(binding.id, game, profile.profileId);
    if (all === null) {
      const collected: GameScore[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query: ScoresQuery = {
          limit: PAGE_LIMIT,
          sortBy: 'rating',
          order: 'desc',
        };
        if (cursor !== null) query.cursor = cursor;
        const result: ScorePage = await timed(services, `listScores(${game})`, () =>
          services.rankhub.listScores(accessToken, game, profile.profileId, query),
        );
        collected.push(...result.items);
        if (!result.hasMore || result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      services.runtime.setScores(binding.id, game, profile.profileId, collected);
      all = collected;
    }

    const needle = keyword.toLowerCase();
    const matched = all
      .filter((score) => (score.songName ?? '').toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS);

    if (matched.length === 0) {
      await sendText(
        services,
        ctx,
        `没有找到曲名包含「${keyword}」的 ${game} 成绩（已检索 ${all.length} 条）。`,
      );
      return;
    }

    const lines = [
      `在 ${game} 档案「${profile.player.name ?? '(未命名)'}」中找到 ${matched.length} 条包含「${keyword}」的成绩：`,
      ...matched.map((score) => `· ${formatScoreLine(score)}`),
    ];
    await sendText(services, ctx, lines.join('\n'));
  });
};
