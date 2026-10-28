/**
 * /me /我的：渲染完整玩家名片（1:1 对齐 App「我的」页 `profileCardBuilder`）。
 *
 * ## 版式（由渲染层决定，本模块只负责数据装配）
 *
 * 1. 顶部：账号头像 / 背景板（`GET /v1/me/profile`）+ 显示名 + UID + bio；
 * 2. 已绑定游戏圆形图标横向排列；
 * 3. 每游戏 5:2 玩家卡（判别联合 `PlayerCardGameCard`）：
 *    - maimai：DX Rating + B35/B15 + 头像 + 最近同步；
 *    - phigros：B30 平均 RKS + 课题模式 + 当前难度达成统计 + 曲绘背景 + 头像；
 *    - arcaea：Potential + B50/B10 均值 + 头像/立绘；
 * 4. 底部：RankHub 用户二维码（仅账号公开时）。
 *
 * ## 数据来源与降级口径
 *
 * - 账号级：`GET /v1/me/profile`（含 `displayPreferences`，旧实例 404 时降级）；
 * - 偏好：`displayPreferences`（新后端一次拿全）→ 兜底 `GET /v1/me/display-preferences`
 *   → 再兜底契约默认值 `IN`（展示不该因为可选偏好失败而整页崩）；
 * - 游戏级：`/v1/games/{game}/profiles` + `describeProfile()`（资产 URL 规则镜像 App）；
 *   maimai/phigros 额外读 `/bests`，phigros 再读 `/statistics`；
 * - **任何单游戏失败只跳过该卡**（`logger.warn` 留痕）；全失败且无账号资料时回文字摘要；
 * - 渲染不可用 / 渲染抛错同样降级为文字摘要，不吞错。
 *
 * ## 指令（冻结契约 C，`docs/QQBOT-CARD-V2.md` §4）
 *
 * - `/me`：渲染名片，Phigros 难度 = 后端偏好（默认 IN）；
 * - `/me diff`：纯文本回当前难度与可选值；
 * - `/me diff <EZ|HD|IN|AT>`：PATCH 后端偏好并回执（大小写不敏感）；非法参数/写回失败都给明确文案。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCanvas } from '@napi-rs/canvas';

import { renderUserQr } from '../bot/qr.js';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  RankHubError,
  type DisplayPreferences,
  type GameBests,
  type GameProfile,
  type PhigrosDifficulty,
  type PlayerCardArcaeaCardData,
  type PlayerCardGameCard,
  type PlayerCardGameIcon,
  type PlayerCardMaimaiCardData,
  type PlayerCardPhigrosCardData,
} from '../contracts/index.js';
import { fetchImage } from '../rankhub/assets.js';
import {
  describeProfile,
  normalizePhigrosDifficulty,
  PHIGROS_DIFFICULTIES,
  type MeProfile,
  type PhigrosLevelStatistics,
  type PhigrosStatistics,
  type ProfileView,
} from '../rankhub/index.js';
import { formatTimeAgo } from '../util/timeago.js';

import type { CommandHandler, CommandServices } from './common.js';
import {
  formatDateTime,
  loadProfiles,
  pickLatestProfile,
  rankHubErrorText,
  replyRankHubError,
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

// ─────────────────────────────── /me diff 参数解析 ───────────────────────────────

/** `/me diff` 的可选难度（顺序与 App 卡片循环一致）。 */
export const ME_DIFF_OPTIONS = PHIGROS_DIFFICULTIES;

/** 非法用法提示（`/me diff xyz`、`/me diff IN AT` 等）。 */
export const ME_DIFF_USAGE_TEXT = [
  '/me diff 用法：',
  '· /me diff —— 查看 Phigros 卡片当前难度',
  `· /me diff <${ME_DIFF_OPTIONS.join('|')}> —— 切换 Phigros 卡片难度（大小写不敏感）`,
].join('\n');

/** `/me` 的子指令解析结果（纯函数，便于单测）。 */
export type MeArgs =
  | { kind: 'card' }
  | { kind: 'diff-show' }
  | { kind: 'diff-set'; difficulty: PhigrosDifficulty }
  | { kind: 'diff-invalid' };

/**
 * 解析 `/me` 后面的参数串。
 *
 * 只认首 token 为 `diff`（大小写不敏感）；其余参数一律按"渲染名片"处理，
 * 保持 `/me` 的历史行为不被奇怪参数打断。
 */
export function resolveMeArgs(args: string): MeArgs {
  const tokens = args.trim().split(/\s+/u).filter((token) => token !== '');
  if (tokens.length === 0) return { kind: 'card' };
  const head = (tokens[0] ?? '').toLowerCase();
  if (head !== 'diff') return { kind: 'card' };
  if (tokens.length === 1) return { kind: 'diff-show' };
  if (tokens.length > 2) return { kind: 'diff-invalid' };
  const difficulty = normalizePhigrosDifficulty(tokens[1]);
  return difficulty === null ? { kind: 'diff-invalid' } : { kind: 'diff-set', difficulty };
}

// ───────────────────────────────── 通用工具 ─────────────────────────────────

/** 读有限数字；其它一律 `null`（不把 `NaN` 画到卡片上）。 */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 按候选键顺序从 `player.native` 读有限数字（v1 adapter 输出 camelCase 在前）。 */
function readNativeNumber(
  native: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  if (native === null) return null;
  for (const key of keys) {
    const value = finiteNumber(native[key]);
    if (value !== null) return value;
  }
  return null;
}

function playerName(profile: GameProfile, meta: GameMeta): string {
  return profile.player.name?.trim() || meta.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** 游戏图标（本地素材优先，缺失用生成的兜底图标）。 */
async function gameIcon(game: CardGame): Promise<PlayerCardGameIcon> {
  const meta = GAME_META[game];
  const icon = (await readIcon(meta.iconPaths)) ?? makeFallbackIcon(meta.name[0] ?? '?', meta.color);
  return { name: meta.name, icon };
}

// ─────────────────────────────── phigros B30 平均 ───────────────────────────────

/**
 * B30 平均 RKS——镜像 App `_b30Average`（`phigros_player_card.dart:293-301`）：
 * `(phi 桶全部 rks + best 桶全部 rks 之和) / 30`，**不做去重**（phi 曲目可同时出现在 best 桶，
 * 这是 phi-plugin / App 的既有口径）。
 *
 * - `bests === null`（接口失败）⇒ `null`（渲染层画占位，而不是谎报 0）；
 * - 桶存在但为空 ⇒ `0`（与 App `all.isEmpty` 返回 `0.0` 一致）；
 * - 结果按契约保留 4 位小数。
 */
export function computeB30Average(bests: GameBests | null): number | null {
  if (bests === null) return null;
  const byKey = new Map(bests.buckets.map((bucket) => [bucket.key, bucket]));
  const phi = byKey.get('phi')?.items ?? [];
  const best = byKey.get('best30')?.items ?? byKey.get('best')?.items ?? [];
  const records = [...phi, ...best];
  if (records.length === 0) return 0;
  let sum = 0;
  for (const record of records) {
    sum += finiteNumber(record.rating) ?? 0;
  }
  return Math.round((sum / 30) * 10_000) / 10_000;
}

/** 某难度的达成统计（缺失按 0/0/0/0，卡片不空转）。 */
export function achievementsFor(
  statistics: PhigrosStatistics | null,
  difficulty: PhigrosDifficulty,
): PhigrosLevelStatistics {
  return statistics?.levels[difficulty] ?? { played: 0, clear: 0, fc: 0, phi: 0 };
}

// ───────────────────────────────── 卡片装配 ─────────────────────────────────

/** 一张卡的数据装配上下文。 */
interface CardDeps {
  services: CommandServices;
  accessToken: string;
  preferences: DisplayPreferences;
}

interface CollectedGame {
  game: CardGame;
  profile: GameProfile;
  view: ProfileView;
}

/**
 * 读某游戏的最佳成绩桶；失败返回 `null`（卡片降级为"只有 rating/头像"，不整卡丢弃）。
 */
async function safeBests(
  services: CommandServices,
  accessToken: string,
  game: CardGame,
  profile: GameProfile,
): Promise<GameBests | null> {
  try {
    return await timed(services, `getBests(${game})`, () =>
      services.rankhub.getBests(accessToken, game, profile.profileId),
    );
  } catch (error) {
    services.logger.warn('读取最佳成绩失败，卡片降级', {
      game,
      profileId: profile.profileId,
      reason: errorMessage(error),
    });
    return null;
  }
}

/** 读 phigros 逐难度统计；失败返回 `null`（达成统计画 0，不整卡丢弃）。 */
async function safeStatistics(
  services: CommandServices,
  accessToken: string,
  profile: GameProfile,
): Promise<PhigrosStatistics | null> {
  try {
    return await timed(services, 'getPhigrosStatistics', () =>
      services.rankhub.getPhigrosStatistics(accessToken, profile.profileId),
    );
  } catch (error) {
    services.logger.warn('读取 phigros 逐难度统计失败，达成统计降级为 0', {
      profileId: profile.profileId,
      reason: errorMessage(error),
    });
    return null;
  }
}

async function buildMaimaiCard(
  item: CollectedGame,
  deps: CardDeps,
): Promise<PlayerCardMaimaiCardData> {
  const { profile, view } = item;
  const native = profile.player.native;
  const bests = await safeBests(deps.services, deps.accessToken, 'maimai', profile);
  const totals = bests?.totals ?? {};

  // DX Rating：native 优先（adapter 目前只放展示字段，不放 rating），回落 player.rating，
  // 再回落 B50 合计（极端情况下 bests 才是最新值）。
  const rating =
    readNativeNumber(native, ['rating', 'dxRating']) ??
    profile.player.rating ??
    finiteNumber(totals['total']);
  // 头像 / 背景板：`describeProfile()` 已按「v1 assets 优先 → 老实例 native.avatarUrl」归一。
  const [avatar, frame] = await Promise.all([
    fetchImage(view.avatarUrl),
    // 用户背景板（v1 `assets.backgroundUrl` = maimai frame URL）。拉取失败返回 null ⇒ 省略，
    // 渲染器回退默认 vendor 背景板（App 默认 frame 455203）。
    fetchImage(view.backgroundUrl),
  ]);

  return {
    game: 'maimai',
    name: playerName(profile, GAME_META.maimai),
    rating,
    // B35 = 往期（archive）、B15 = 当期（latest）——与后端 maimai adapter 的 totals 键一致。
    b35Rating: finiteNumber(totals['archive']),
    b15Rating: finiteNumber(totals['latest']),
    ...(avatar === null ? {} : { avatar }),
    ...(frame === null ? {} : { frame }),
    lastSyncedAt: profile.lastSyncedAt,
  };
}

async function buildPhigrosCard(
  item: CollectedGame,
  deps: CardDeps,
): Promise<PlayerCardPhigrosCardData> {
  const { profile, view } = item;
  const difficulty = deps.preferences.phigrosDifficulty;
  const [bests, statistics, avatar, background] = await Promise.all([
    safeBests(deps.services, deps.accessToken, 'phigros', profile),
    safeStatistics(deps.services, deps.accessToken, profile),
    fetchImage(view.avatarUrl),
    fetchImage(view.backgroundUrl),
  ]);

  const native = profile.player.native;
  const challengeRaw =
    readNativeNumber(native, ['challengeModeRank', 'challenge_mode_rank']) ??
    statistics?.challengeModeRank ??
    null;
  // App `_challengeMode`：rank > 0 才画徽章（0 = 未参与课题模式）。
  const challengeModeRank =
    challengeRaw !== null && challengeRaw > 0 ? Math.trunc(challengeRaw) : null;

  return {
    game: 'phigros',
    name: playerName(profile, GAME_META.phigros),
    rks: computeB30Average(bests),
    challengeModeRank,
    difficulty,
    achievements: { ...achievementsFor(statistics, difficulty) },
    ...(avatar === null ? {} : { avatar }),
    ...(background === null ? {} : { background }),
  };
}

async function buildArcaeaCard(
  item: CollectedGame,
  deps: CardDeps,
): Promise<PlayerCardArcaeaCardData> {
  const { profile, view } = item;
  const native = profile.player.native;

  const [avatar, characterArtwork] = await Promise.all([
    // 档案头像 → 回落搭档图标（`describeProfile` 已按「assets 优先 → App 本地规则」归一）。
    fetchImage(view.avatarUrl),
    // 搭档 1080px 立绘（assets.characterArtworkUrl 优先，老实例回退 App 的 char/1080 规则）。
    fetchImage(view.characterArtworkUrl),
  ]);

  return {
    game: 'arcaea',
    name: playerName(profile, GAME_META.arcaea),
    potential: profile.player.rating,
    b50Avg: readNativeNumber(native, ['b50Avg', 'b50_avg']),
    b10Avg: readNativeNumber(native, ['b10Avg', 'b10_avg']),
    ...(avatar === null ? {} : { avatar }),
    ...(characterArtwork === null ? {} : { characterArtwork }),
    lastSyncedAt: profile.lastSyncedAt,
  };
}

/** 按游戏分派到具体卡片装配（类型上保证三款游戏都有实现）。 */
async function buildGameCard(item: CollectedGame, deps: CardDeps): Promise<PlayerCardGameCard> {
  switch (item.game) {
    case 'maimai':
      return buildMaimaiCard(item, deps);
    case 'phigros':
      return buildPhigrosCard(item, deps);
    case 'arcaea':
      return buildArcaeaCard(item, deps);
  }
}

// ───────────────────────────────── 数据收集 ─────────────────────────────────

/** 收集三款游戏的最新档案 + 展示模型；失败的游戏只计数，不中断其它游戏。 */
async function collectGames(
  services: CommandServices,
  binding: Parameters<typeof loadProfiles>[1],
  accessToken: string,
): Promise<{ items: CollectedGame[]; failures: number }> {
  const items: CollectedGame[] = [];
  let failures = 0;
  for (const game of CARD_GAMES) {
    try {
      const profiles = await loadProfiles(services, binding, accessToken, game);
      const profile = pickLatestProfile(profiles);
      if (profile === null) continue;
      items.push({ game, profile, view: describeProfile(game, profile) });
    } catch (error) {
      failures += 1;
      services.logger.warn('名片读取游戏档案失败，跳过该卡', { game, reason: errorMessage(error) });
    }
  }
  return { items, failures };
}

/** 账号资料（可选；服务端未部署时 404/网络失败都不阻断名片）。 */
async function loadMeProfile(
  services: CommandServices,
  ctx: Parameters<CommandHandler>[1],
  accessToken: string,
): Promise<MeProfile | null> {
  try {
    return await timed(services, 'getMeProfile', () =>
      services.rankhub.getMeProfile(accessToken),
    );
  } catch (error) {
    ctx.logger.warn('账号资料不可用，名片降级为游戏信息', { reason: errorMessage(error) });
    return null;
  }
}

/**
 * 当前显示偏好：`/v1/me/profile` 的字段优先（省一次往返），否则单独 GET，最后回退默认 IN。
 *
 * 展示路径**不因偏好失败而报错**：卡片按默认 IN 画，用户仍能看到其余数据。
 */
async function resolvePreferences(
  services: CommandServices,
  ctx: Parameters<CommandHandler>[1],
  accessToken: string,
  me: MeProfile | null,
): Promise<DisplayPreferences> {
  if (me !== null) return me.displayPreferences;
  try {
    return await timed(services, 'getDisplayPreferences', () =>
      services.rankhub.getDisplayPreferences(accessToken),
    );
  } catch (error) {
    ctx.logger.warn('读取显示偏好失败，回退默认难度', {
      fallback: DEFAULT_DISPLAY_PREFERENCES.phigrosDifficulty,
      reason: errorMessage(error),
    });
    return DEFAULT_DISPLAY_PREFERENCES;
  }
}

// ───────────────────────────────── 文字降级 ─────────────────────────────────

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
          const synced =
            profile.lastSyncedAt === null
              ? ''
              : ` / 同步于 ${formatTimeAgo(profile.lastSyncedAt) ?? profile.lastSyncedAt}`;
          lines.push(`  · ${profile.player.name ?? '（未命名）'}${rating}${synced}`);
        }
      } catch (error) {
        ctx.logger.warn('读取档案失败', { game: game.game, reason: errorMessage(error) });
        lines.push(`- ${game.game}：查询失败，请稍后重试`);
      }
    }
  }
  await sendText(services, ctx, lines.join('\n'));
}

/** 可选难度展示串（`/me diff` 与写回回执共用）。 */
function difficultyOptionsText(): string {
  return ME_DIFF_OPTIONS.join(' / ');
}

// ───────────────────────────────── 指令入口 ─────────────────────────────────

export const meCommand: CommandHandler = async (services, ctx) => {
  const args = resolveMeArgs(ctx.args);

  if (args.kind === 'diff-invalid') {
    // 参数解析是纯本地操作：未绑定用户也能先看到正确用法。
    await sendText(services, ctx, ME_DIFF_USAGE_TEXT);
    return;
  }

  if (args.kind === 'diff-show' || args.kind === 'diff-set') {
    await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
      if (args.kind === 'diff-show') {
        let preferences: DisplayPreferences;
        try {
          preferences = await timed(services, 'getDisplayPreferences', () =>
            services.rankhub.getDisplayPreferences(accessToken),
          );
        } catch (error) {
          if (await replyRankHubError(services, ctx, error, binding)) return;
          throw error;
        }
        await sendText(
          services,
          ctx,
          [
            `Phigros 卡片当前难度：${preferences.phigrosDifficulty}`,
            `可选难度：${difficultyOptionsText()}`,
            '切换：/me diff <难度>（App 与机器人共享该偏好）',
          ].join('\n'),
        );
        return;
      }

      const target = args.difficulty;
      try {
        const updated = await timed(services, 'updateDisplayPreferences', () =>
          services.rankhub.updateDisplayPreferences(accessToken, { phigrosDifficulty: target }),
        );
        await sendText(
          services,
          ctx,
          [
            `✅ 已把 Phigros 卡片难度切换为 ${updated.phigrosDifficulty}（App 与机器人共享该偏好）。`,
            '发送 /me 查看新卡片。',
          ].join('\n'),
        );
      } catch (error) {
        // 授权失效走统一处理（要标记 binding revoked）；其余错误给明确文案，绝不静默。
        if (
          error instanceof RankHubError &&
          (error.code === 'invalid_grant' || error.code === 'unauthorized')
        ) {
          await replyRankHubError(services, ctx, error, binding);
          return;
        }
        const reason =
          error instanceof RankHubError ? rankHubErrorText(error) : errorMessage(error);
        ctx.logger.warn('切换 Phigros 难度失败', {
          difficulty: target,
          code: error instanceof RankHubError ? error.code : null,
          reason: errorMessage(error),
        });
        await sendText(
          services,
          ctx,
          `切换 Phigros 难度失败：${reason}\n当前难度保持不变；稍后可重试 /me diff ${target}。`,
        );
      }
    });
    return;
  }

  // /me：渲染玩家名片。
  await withAuthorized(services, ctx, async ({ binding, accessToken }) => {
    await sendProcessing(services, ctx, '生成玩家名片');

    const renderPlayerCard = services.renderer.renderPlayerCard;
    if (renderPlayerCard === undefined) {
      await textSummary(services, ctx, binding, accessToken);
      return;
    }

    const me = await loadMeProfile(services, ctx, accessToken);
    const preferences = await resolvePreferences(services, ctx, accessToken, me);
    const { items, failures } = await collectGames(services, binding, accessToken);

    if (items.length === 0) {
      if (me === null && failures === CARD_GAMES.length) {
        // 全失败且无账号资料：文字摘要（保留可诊断的降级，而不是只说"没有档案"）。
        await textSummary(services, ctx, binding, accessToken);
        return;
      }
      if (me === null) {
        await sendText(
          services,
          ctx,
          '你还没有 maimai / phigros / arcaea 档案，先在 RankHub 上传成绩后再试 /me。',
        );
        return;
      }
      // 有账号资料但没有任何游戏卡：继续渲染（只有账号头部 + 图标条）。
    }

    const deps: CardDeps = { services, accessToken, preferences };
    const icons: PlayerCardGameIcon[] = [];
    const cards: PlayerCardGameCard[] = [];
    for (const item of items) {
      icons.push(await gameIcon(item.game));
      try {
        cards.push(await buildGameCard(item, deps));
      } catch (error) {
        // 单卡装配失败（意外）只跳过该卡，其余游戏照常展示。
        services.logger.warn('名片卡片装配失败，跳过该卡', {
          game: item.game,
          profileId: item.profile.profileId,
          reason: errorMessage(error),
        });
      }
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
      items[0]?.profile.player.name?.trim() ||
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
          cards,
          ...(qr === null ? {} : { qr }),
        }),
      );
      await sendImage(services, ctx, image, `me-${binding.id}.png`);
    } catch (error) {
      ctx.logger.warn('玩家名片渲染失败，降级为文字摘要', { reason: errorMessage(error) });
      await textSummary(services, ctx, binding, accessToken);
    }
  });
};
