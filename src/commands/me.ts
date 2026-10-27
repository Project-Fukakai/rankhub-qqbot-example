/**
 * /me /我的：渲染完整玩家名片（参考 App「我的二维码」卡片）。
 *
 * 版式（由上到下）：
 * 1. 顶部：账号头像 / 背景板（来自 `/v1/me/profile`，未部署时降级为无图）+ 显示名 + UID + bio；
 * 2. 已绑定游戏：圆形图标横向排列（替代 App 卡片里二维码的位置）；
 * 3. 每游戏玩家卡：maimai / phigros / arcaea（背景、头像、rating、游戏特定字段）；
 * 4. 底部：RankHub 用户二维码（仅账号公开时）。
 *
 * 数据来源：
 * - 账号级：`GET /v1/me/profile`（rankhub_net 新增，OAuth 可用；未部署时调用失败 → 降级）；
 * - 游戏级：`/v1/games/{game}/profiles` + `describeProfile()`（资产 URL 规则镜像 App）。
 *
 * 渲染不可用（无浏览器/模块缺失）时退回文字摘要，不吞错（logger.warn 留痕）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCanvas } from '@napi-rs/canvas';

import { renderUserQr } from '../bot/qr.js';
import type { GameProfile, PlayerCardGameIcon, PlayerCardGameSection } from '../contracts/index.js';
import { fetchImage } from '../rankhub/assets.js';
import { describeProfile } from '../rankhub/index.js';
import { formatTimeAgo } from '../util/timeago.js';

import type { CommandHandler, CommandServices } from './common.js';
import {
  formatDateTime,
  loadProfiles,
  pickLatestProfile,
  sendImage,
  sendProcessing,
  sendText,
  timed,
  withAuthorized,
} from './common.js';

const MAX_PROFILES_PER_GAME = 5;

/** 名片里支持的游戏（顺序即展示顺序）。 */
const CARD_GAMES = ['maimai', 'phigros', 'arcaea'] as const;
type CardGame = (typeof CARD_GAMES)[number];

interface GameMeta {
  name: string;
  /** 评分体系名（展示在 rating 下方）。 */
  ratingLabel: string;
  /** 图标候选路径（相对仓库根；缺省时用运行时生成的圆形字母图标）。 */
  iconPaths: string[];
  /** 主题色（生成兜底图标用）。 */
  color: [string, string];
}

const GAME_META: Record<CardGame, GameMeta> = {
  maimai: {
    name: 'maimai DX',
    ratingLabel: 'DX rating',
    iconPaths: ['vendor/card/icons/maimai-icon.png', 'vendor/mai/pic/logo.png'],
    color: ['#ff5fa2', '#7b2ff7'],
  },
  phigros: {
    name: 'Phigros',
    ratingLabel: 'Ranking Score',
    iconPaths: [
      'vendor/card/icons/phigros-icon.png',
      'vendor/phi/resources/html/otherimg/Phigros_Icon_4.0.0.png',
    ],
    color: ['#39c5ff', '#0a84ff'],
  },
  arcaea: {
    name: 'Arcaea',
    ratingLabel: 'Potential',
    iconPaths: ['vendor/card/icons/arcaea-icon.png'],
    color: ['#b388ff', '#6a3df5'],
  },
};

/** `/v1/me/profile` 的最小形状（服务端未部署时调用不到）。 */
interface MeProfileLike {
  uid: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  isPublic: boolean;
}

type RankHubWithMe = CommandServices['rankhub'] & {
  getMeProfile?: (accessToken: string) => Promise<MeProfileLike>;
};

function formatRating(game: CardGame, rating: number | null): string | null {
  if (rating === null || !Number.isFinite(rating)) return null;
  if (game === 'maimai') return String(Math.round(rating));
  if (game === 'phigros') return rating.toFixed(3);
  return rating.toFixed(2);
}

/** 读本地图标；缺失返回 null（后续用生成的兜底图标）。 */
async function readIcon(paths: string[]): Promise<Buffer | null> {
  for (const rel of paths) {
    try {
      return await readFile(join(process.cwd(), rel));
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 兜底圆形图标：渐变底 + 游戏首字母。 */
function makeFallbackIcon(letter: string, color: [string, string]): Buffer {
  const size = 256;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, color[0]);
  gradient.addColorStop(1, color[1]);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = 'bold 120px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(letter.toUpperCase(), size / 2, size / 2 + 6);
  return canvas.toBuffer('image/png');
}

interface CollectedGame {
  game: CardGame;
  profile: GameProfile;
  display: ReturnType<typeof describeProfile>;
}

/** 收集三款游戏的最新档案与展示模型。 */
async function collectGames(
  services: CommandServices,
  binding: Parameters<typeof loadProfiles>[1],
  accessToken: string,
): Promise<CollectedGame[]> {
  const collected: CollectedGame[] = [];
  for (const game of CARD_GAMES) {
    try {
      const profiles = await loadProfiles(services, binding, accessToken, game);
      const profile = pickLatestProfile(profiles);
      if (profile === null) continue;
      collected.push({ game, profile, display: describeProfile(game, profile) });
    } catch (error) {
      services.logger.warn('名片读取游戏档案失败', {
        game,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return collected;
}

/** 文字降级：与原 /me 摘要一致。 */
async function textSummary(
  services: CommandServices,
  ctx: Parameters<CommandHandler>[1],
  binding: Parameters<typeof loadProfiles>[1],
  accessToken: string,
): Promise<void> {
  const games = await timed(services, 'listGames', () => services.rankhub.listGames(accessToken));
  const lines: string[] = [
    `RankHub 账号：${binding.rankhubName ?? '（未命名）'}`,
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
        lines.push(`- ${game.game}：${profiles.length} 个档案`);
        for (const profile of profiles.slice(0, MAX_PROFILES_PER_GAME)) {
          const rating =
            profile.player.rating === null || profile.player.rating === undefined
              ? ''
              : ` / rating ${profile.player.rating}`;
          lines.push(`  · ${profile.player.name ?? '（未命名）'}${rating}`);
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
}

export const meCommand: CommandHandler = async (services, ctx) => {
  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    await sendProcessing(services, ctx, '生成玩家名片');

    const renderPlayerCard = services.renderer.renderPlayerCard;
    if (renderPlayerCard === undefined) {
      await textSummary(services, ctx, binding, accessToken);
      return;
    }

    // 账号级资料（可选；服务端未部署时 404/网络失败都不阻断名片）。
    let me: MeProfileLike | null = null;
    const rankhub = services.rankhub as RankHubWithMe;
    const getMeProfile = rankhub.getMeProfile;
    if (typeof getMeProfile === 'function') {
      try {
        me = await timed(services, 'getMeProfile', () => getMeProfile.call(rankhub, accessToken));
      } catch (error) {
        ctx.logger.warn('账号资料不可用，名片降级为游戏信息', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const games = await collectGames(services, binding, accessToken);
    if (games.length === 0 && me === null) {
      await sendText(
        services,
        ctx,
        '你还没有 maimai / phigros / arcaea 档案，先在 RankHub 上传成绩后再试 /me。',
      );
      return;
    }

    const icons: PlayerCardGameIcon[] = [];
    const sections: PlayerCardGameSection[] = [];
    for (const item of games) {
      const meta = GAME_META[item.game];
      const icon = (await readIcon(meta.iconPaths)) ?? makeFallbackIcon(meta.name[0]!, meta.color);
      icons.push({ name: meta.name, icon });

      const [avatar, background] = await Promise.all([
        fetchImage(item.display.avatarUrl),
        fetchImage(item.display.backgroundUrl),
      ]);
      // App「我的」页卡片：玩家名大号 + 游戏名/评分体系小字 + 大号 rating + 统计小块。
      sections.push({
        game: item.game,
        title: item.profile.player.name?.trim() || meta.name,
        rating: formatRating(item.game, item.display.rating),
        subtitle: `${meta.name} · ${meta.ratingLabel}`,
        ...(avatar === null ? {} : { avatar }),
        ...(background === null ? {} : { background }),
        fields: item.display.fields.slice(0, 4),
      });
    }

    const [avatar, banner] = await Promise.all([
      me?.avatarUrl === null || me?.avatarUrl === undefined
        ? Promise.resolve(null)
        : fetchImage(me.avatarUrl),
      me?.bannerUrl === null || me?.bannerUrl === undefined
        ? Promise.resolve(null)
        : fetchImage(me.bannerUrl),
    ]);
    const qr = me !== null && me.isPublic && me.uid !== '' ? await renderUserQr(me.uid) : null;

    const displayName =
      me?.displayName?.trim() ||
      binding.rankhubName?.trim() ||
      games[0]?.profile.player.name?.trim() ||
      'RankHub 玩家';

    try {
      const image = await timed(services, 'renderPlayerCard', () =>
        renderPlayerCard.call(services.renderer, {
          displayName,
          uid: me?.uid ?? null,
          bio: me?.bio ?? null,
          ...(avatar === null ? {} : { avatar }),
          ...(banner === null ? {} : { banner }),
          games: icons,
          cards: sections,
          ...(qr === null ? {} : { qr }),
        }),
      );
      await sendImage(services, ctx, image, `me-${binding.id}.png`);
    } catch (error) {
      ctx.logger.warn('玩家名片渲染失败，降级为文字摘要', {
        reason: error instanceof Error ? error.message : String(error),
      });
      await textSummary(services, ctx, binding, accessToken);
    }
  });
};
