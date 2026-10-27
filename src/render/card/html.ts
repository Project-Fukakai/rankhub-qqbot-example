/**
 * 名片 HTML/CSS 生成：输入模型 → 单页 HTML（所有素材内联为 `data:` URL）。
 *
 * 版式基准是 App 的「我的二维码」页（`RankHub/lib/pages/user/my_qr_code_page.dart`）：
 * 顶部 banner（banner 高度小于 hero，留出圆形头像压边）→ 头像叠在 banner 下沿
 * → 显示名/UID/bio → 分隔线 → 圆形游戏图标条（替代 App 里二维码的位置）→ 游戏卡
 * → 底部白底二维码。
 *
 * 游戏卡基准是 App「我的」页的 5:2 横向卡：
 * - maimai `player_info_card.dart`：背景框铺满 + 头像 + 大号 rating + 底部统计；
 * - phigros `phigros_player_card.dart`：曲绘背景 + 底部黑色渐变 + 统计块；
 * - arcaea `arcaea_views.dart` 的 `ArcaeaPlayerInfoCard`：背景 + 头像 + Potential + b50/b10。
 * 三者在名片里统一成同一套结构（玩家名大号、游戏名 · 评分体系小字、右侧大号 rating、
 * 底部一排统计小块），差异体现在游戏主题色与背景图。
 *
 * 约束：
 * - 固定 1200px 宽（`body` 宽度即输出 PNG 宽度），高度由内容自然撑开；
 * - 只引用内联 data URL，`setContent` 即可离线渲染；
 * - 所有文案做 HTML 转义 + 长度截断，避免用户昵称/bio 把版式撑破或注入标签。
 */
import type { PlayerCardInput } from './types.js';

/** 输出 PNG 的固定宽度（px）。 */
export const CARD_WIDTH = 1200;

/** 防御异常输入：图标条 / 游戏卡 / 每卡字段都有上限，渲染层不会被无上限拉长。 */
const MAX_GAMES = 8;
const MAX_CARDS = 8;
const MAX_FIELDS = 4;

/** App 深色主题的实际取值（`RankHub/lib/application/theme.dart:26-34`）。 */
export const APP_DARK = {
  surfaceBase: '#000000',
  surfaceLow: '#101010',
  surface: '#191919',
  surfaceHigh: '#202020',
  surfaceHighest: '#282828',
  outline: '#343434',
  outlineVariant: '#2A2A2A',
  onSurface: '#E7ECF4',
  onSurfaceVariant: '#B6C0CC',
} as const;

/** 游戏主题色（与 `src/commands/me.ts` 的 GAME_META 一致：maimai 粉 / phigros 蓝 / arcaea 紫）。 */
const GAME_ACCENTS: Record<string, string> = {
  maimai: '#ff5fa2',
  phigros: '#39c5ff',
  arcaea: '#b388ff',
};

const FALLBACK_ACCENTS = ['#7c9cff', '#ffc35e', '#5ee0b7', '#ff8d9a'] as const;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML 文本转义（属性与文本节点通用）。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * 从图片字节嗅探 MIME，拼成 `data:` URL。
 *
 * 识别 PNG / JPEG / GIF / WebP；识别不了按 PNG 交给浏览器（解码失败只会让该元素空白，
 * 不影响其余版式）。空 Buffer 视为没有素材。
 */
export function imageMimeType(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/** `Buffer → data:` URL；空/缺省返回 null。 */
export function toDataUrl(buffer: Buffer | null | undefined): string | null {
  if (!buffer || buffer.length === 0) return null;
  return `data:${imageMimeType(buffer)};base64,${buffer.toString('base64')}`;
}

/** 归一化一行文本：合并空白、去首尾、按字符长度截断（超出用省略号）。 */
function normalizeText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 头像占位字：取展示名第一个字符（处理代理对），没有就用 R。 */
function initialOf(name: string | null | undefined): string {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (normalized === '') return 'R';
  return Array.from(normalized)[0] ?? 'R';
}

function accentFor(game: string, index: number): string {
  const known = GAME_ACCENTS[game.trim().toLowerCase()];
  if (known) return known;
  return FALLBACK_ACCENTS[index % FALLBACK_ACCENTS.length] ?? FALLBACK_ACCENTS[0];
}

interface NormalizedField {
  label: string | null;
  value: string;
}

interface NormalizedCard {
  game: string;
  /** 玩家名（App「我的」页卡片里的大号名字；契约里 `title` 就是这个语义）。 */
  title: string;
  /** 游戏名 · 评分体系（小字，如 `maimai DX · DX rating`）。 */
  subtitle: string | null;
  rating: string | null;
  background: string | null;
  avatar: string | null;
  fields: NormalizedField[];
}

interface NormalizedIcon {
  name: string;
  icon: string | null;
}

export interface CardHtmlBuildResult {
  html: string;
  summary: {
    hasBanner: boolean;
    hasAvatar: boolean;
    hasQr: boolean;
    games: number;
    cards: number;
    fields: number;
    /** 调用方没有提供背景图的卡片数（由 App 默认背景素材或纯色兜底）。 */
    fallbackBackgrounds: number;
  };
  /** 用上了 App 默认背景素材的游戏（诊断用，依赖 vendor/card/backgrounds 是否就绪）。 */
  defaultBackgroundGames: string[];
}

/** 名片全部样式（内联进 `<style>`，避免任何外部请求）。 */
export const CARD_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${CARD_WIDTH}px; }
body {
  width: ${CARD_WIDTH}px;
  background: ${APP_DARK.surfaceBase};
  color: ${APP_DARK.onSurface};
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  overflow: hidden;
}
:root {
  --font-ui: "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif;
  --font-display: "RankHub Display", "Saira", "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif;
  --surface-base: ${APP_DARK.surfaceBase};
  --surface-low: ${APP_DARK.surfaceLow};
  --surface: ${APP_DARK.surface};
  --surface-high: ${APP_DARK.surfaceHigh};
  --outline: ${APP_DARK.outline};
  --outline-variant: ${APP_DARK.outlineVariant};
  --on-surface: ${APP_DARK.onSurface};
  --on-surface-variant: ${APP_DARK.onSurfaceVariant};
}
.page {
  width: ${CARD_WIDTH}px;
  padding: 24px;
  background: var(--surface-base);
}
.sheet {
  position: relative;
  border-radius: 34px;
  overflow: hidden;
  background: #0b0b0c;
  border: 1px solid var(--outline-variant);
}

/* ── 顶部 banner + 叠压头像（App my_qr_code_page.dart:274-308） ── */
.hero { position: relative; height: 520px; background: #0b0b0c; }
.hero-banner {
  position: absolute; left: 0; right: 0; top: 0; height: 430px;
  overflow: hidden; background: #272727;
}
.hero-banner img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* App 在 banner 上叠 12% 黑（my_qr_code_page.dart:400）。 */
.hero-scrim { position: absolute; left: 0; right: 0; top: 0; height: 430px; background: rgba(0, 0, 0, .12); }
.hero-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  background: #272727;
  font-size: 64px; font-weight: 700; color: var(--on-surface);
}
.hero-avatar {
  position: absolute; left: 56px; bottom: 0; width: 216px; height: 216px;
  border-radius: 50%; border: 8px solid #0b0b0c; overflow: hidden;
  background: #1b1b1b; box-shadow: 0 18px 44px rgba(0, 0, 0, .55);
}
.hero-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.avatar-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 84px; font-weight: 700;
  color: #f2f6ff; background: linear-gradient(140deg, #3a4459 0%, #171b26 100%);
}

/* ── 显示名 / UID / bio（App my_qr_code_page.dart:309-340） ── */
.profile { padding: 26px 56px 36px; }
.name {
  font-size: 62px; line-height: 1.2; font-weight: 700; letter-spacing: .005em;
  color: var(--on-surface);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.uid { margin-top: 14px; font-size: 32px; letter-spacing: .01em; color: var(--on-surface-variant); }
.uid-value {
  font-variant-numeric: tabular-nums; color: var(--on-surface); font-weight: 600;
  letter-spacing: .04em;
}
.bio {
  margin-top: 18px; max-width: 1000px; font-size: 30px; line-height: 1.6;
  color: var(--on-surface-variant);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.divider { height: 1px; margin: 0 56px; background: var(--outline-variant); }

/* ── 圆形游戏图标条（替代 App 卡片里二维码的位置，App :343-350） ── */
.strip { padding: 30px 56px 34px; text-align: center; }
.strip-label {
  font-size: 20px; letter-spacing: .16em; color: var(--on-surface-variant);
  margin-bottom: 22px;
}
.strip-list { display: flex; align-items: flex-start; justify-content: center; gap: 30px; flex-wrap: wrap; }
.strip-item { display: flex; flex-direction: column; align-items: center; width: 120px; }
.strip-icon {
  width: 96px; height: 96px; border-radius: 50%; overflow: hidden;
  background: var(--surface-low); border: 2px solid rgba(255, 255, 255, .14);
  box-shadow: 0 10px 24px rgba(0, 0, 0, .45);
}
.strip-icon img { display: block; width: 100%; height: 100%; object-fit: cover; }
.strip-icon-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 38px; font-weight: 700; color: #eef2ff;
  background: linear-gradient(140deg, #2f3648 0%, #161a24 100%);
}
.strip-name {
  margin-top: 12px; max-width: 120px; font-size: 20px; color: var(--on-surface-variant);
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── 游戏卡（App「我的」页 5:2 横向卡） ── */
.games { padding: 34px 56px 40px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22px; }
.section-title { font-size: 24px; font-weight: 600; letter-spacing: .06em; color: var(--on-surface); }
.section-count { font-size: 18px; letter-spacing: .06em; color: var(--on-surface-variant); }
.game-wrap { position: relative; margin-bottom: 30px; }
.game-wrap:last-child { margin-bottom: 0; }
.game {
  position: relative; overflow: hidden; border-radius: 28px;
  height: 416px; /* 5:2（内容宽 1040） */
  background: var(--surface-low);
  border: 1px solid var(--outline-variant);
}
.game-bg { position: absolute; inset: 0; }
.game-bg img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* 底部压暗 + 左侧轻压暗：保证玩家名/统计在任意背景上可读（phigros 卡 :166-176 的渐变思路）。 */
.game-scrim {
  position: absolute; inset: 0;
  background:
    radial-gradient(620px 380px at 92% 2%, var(--accent-soft, rgba(255, 255, 255, .08)), rgba(0, 0, 0, 0) 70%),
    linear-gradient(180deg, rgba(0, 0, 0, 0) 32%, rgba(0, 0, 0, .58) 72%, rgba(0, 0, 0, .86) 100%),
    linear-gradient(90deg, rgba(0, 0, 0, .42) 0%, rgba(0, 0, 0, .10) 42%, rgba(0, 0, 0, 0) 62%);
}
.game-content {
  position: relative; z-index: 2; display: flex; flex-direction: column; justify-content: space-between;
  height: 100%; padding: 40px 46px 32px 168px;
}
.game-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 28px; }
.game-meta { min-width: 0; flex: 1 1 auto; }
.game-title {
  font-size: 56px; line-height: 1.16; font-weight: 700; color: #ffffff;
  text-shadow: 0 2px 14px rgba(0, 0, 0, .55);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.game-sub {
  margin-top: 12px; font-size: 26px; letter-spacing: .02em; color: rgba(231, 236, 244, .82);
  text-shadow: 0 1px 10px rgba(0, 0, 0, .6);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.game-rating { flex: 0 0 auto; text-align: right; }
.rating-value {
  display: block; max-width: 460px;
  font-family: var(--font-display); font-size: 96px; line-height: 1; font-weight: 700;
  letter-spacing: .005em;
  background: linear-gradient(180deg, #ffffff 6%, var(--accent) 128%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 3px 16px rgba(0, 0, 0, .45));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rating-value--empty {
  background: none; -webkit-text-fill-color: rgba(231, 236, 244, .55);
  filter: none; font-size: 68px; font-weight: 500;
}
.rating-label {
  margin-top: 10px; font-size: 15px; letter-spacing: .32em; text-transform: uppercase;
  color: rgba(231, 236, 244, .55);
}
.fields { display: flex; gap: 18px; }
.field {
  flex: 1 1 0; min-width: 0; padding: 16px 22px 18px; border-radius: 18px;
  background: rgba(0, 0, 0, .42); border: 1px solid rgba(255, 255, 255, .12);
}
.field-label {
  font-size: 18px; letter-spacing: .05em; color: rgba(231, 236, 244, .72);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.field-value {
  margin-top: 8px; font-family: var(--font-display); font-size: 36px; font-weight: 700;
  color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 2px 10px rgba(0, 0, 0, .45);
}
/* 圆形头像压住卡片左缘（App maimai 卡左上角头像的变体）。 */
.game-avatar {
  position: absolute; left: -48px; top: 40px; z-index: 3;
  width: 180px; height: 180px; border-radius: 50%; overflow: hidden;
  border: 6px solid #0b0b0c; background: #1b1b1b;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .12), 0 18px 40px rgba(0, 0, 0, .6);
}
.game-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.game-avatar-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 68px; font-weight: 700; color: #ffffff;
  background: linear-gradient(140deg, var(--accent) 0%, #1a1a1e 100%);
}
.empty {
  padding: 52px 40px; border-radius: 24px; text-align: center;
  background: var(--surface-low); border: 1px dashed var(--outline);
}
.empty-title { font-size: 26px; font-weight: 600; color: var(--on-surface); }
.empty-hint { margin-top: 12px; font-size: 20px; color: var(--on-surface-variant); }

/* ── 底部二维码（App my_qr_code_page.dart:341-360） ── */
.qr {
  margin: 0 56px; padding: 40px 0 56px;
  border-top: 1px solid var(--outline-variant);
  display: flex; flex-direction: column; align-items: center;
}
.qr-card {
  padding: 26px; border-radius: 24px; background: #ffffff;
  box-shadow: 0 22px 56px rgba(0, 0, 0, .5);
}
.qr-img { display: block; width: 520px; height: 520px; border-radius: 8px; }
.qr-title { margin-top: 30px; font-size: 24px; letter-spacing: .04em; color: var(--on-surface); }
.qr-hint { margin-top: 10px; font-size: 20px; letter-spacing: .04em; color: var(--on-surface-variant); }
`.trim();

function renderIcons(games: NormalizedIcon[]): string {
  if (games.length === 0) return '';
  const items = games
    .map((game) => {
      const icon = game.icon
        ? `<img src="${game.icon}" alt="">`
        : `<div class="strip-icon-fallback">${escapeHtml(initialOf(game.name))}</div>`;
      return `        <div class="strip-item">
          <div class="strip-icon">${icon}</div>
          <div class="strip-name">${escapeHtml(game.name)}</div>
        </div>`;
    })
    .join('\n');
  return `
      <section class="strip">
        <div class="strip-label">已绑定游戏</div>
        <div class="strip-list">
${items}
        </div>
      </section>`;
}

function renderFields(fields: NormalizedField[]): string {
  if (fields.length === 0) return '';
  const items = fields
    .map((field) => {
      const label = field.label
        ? `<div class="field-label">${escapeHtml(field.label)}</div>`
        : '';
      return `          <div class="field">${label}<div class="field-value">${escapeHtml(field.value)}</div></div>`;
    })
    .join('\n');
  return `
        <div class="fields">
${items}
        </div>`;
}

function renderCard(card: NormalizedCard, index: number): string {
  const accent = accentFor(card.game, index);
  const avatar = card.avatar
    ? `<img src="${card.avatar}" alt="">`
    : `<div class="game-avatar-fallback">${escapeHtml(initialOf(card.title))}</div>`;
  // 背景只可能来自「调用方传入的图」或「App 默认背景素材」；都没有时不造假图，
  // 直接露出卡片自身的 surface 纯色（与 App 未选曲绘时的 grey900 行为一致）。
  const background = card.background
    ? `<div class="game-bg"><img src="${card.background}" alt=""></div>`
    : '';
  return `
      <div class="game-wrap" style="--accent: ${accent}; --accent-soft: ${hexToRgba(accent, .22)};">
        <article class="game">
${background}
          <div class="game-scrim"></div>
          <div class="game-content">
            <div class="game-top">
              <div class="game-meta">
                <div class="game-title">${escapeHtml(card.title)}</div>
${card.subtitle ? `                <div class="game-sub">${escapeHtml(card.subtitle)}</div>` : ''}
              </div>
              <div class="game-rating">
                <span class="rating-value${card.rating === null ? ' rating-value--empty' : ''}">${escapeHtml(card.rating ?? '—')}</span>
                <div class="rating-label">rating</div>
              </div>
            </div>${renderFields(card.fields)}
          </div>
        </article>
        <div class="game-avatar">${avatar}</div>
      </div>`;
}

function renderQr(qr: string | null): string {
  if (!qr) return '';
  return `
      <section class="qr">
        <div class="qr-card"><img class="qr-img" src="${qr}" alt="RankHub 二维码"></div>
        <div class="qr-title">RankHub 音游聚合平台</div>
        <div class="qr-hint">App 扫一扫，看我主页</div>
      </section>`;
}

/**
 * 把输入归一化成可渲染模型（截断超长文案、丢弃空素材、限制卡片/字段数量）。
 */
function normalize(
  input: PlayerCardInput,
  defaultBackgrounds: Record<string, string>,
): {
  displayName: string;
  uid: string | null;
  bio: string | null;
  banner: string | null;
  avatar: string | null;
  qr: string | null;
  games: NormalizedIcon[];
  cards: NormalizedCard[];
  fallbackBackgrounds: number;
  defaultBackgroundGames: string[];
} {
  const games: NormalizedIcon[] = [];
  // 数组字段做一次防御性兜底：调用方误传 undefined 时仍然是「少图」而不是抛错。
  for (const game of (input.games ?? []).slice(0, MAX_GAMES)) {
    const name = normalizeText(game.name, 32);
    if (name === null) continue;
    games.push({ name, icon: toDataUrl(game.icon) });
  }

  const cards: NormalizedCard[] = [];
  const defaultBackgroundGames: string[] = [];
  let fallbackBackgrounds = 0;
  for (const card of (input.cards ?? []).slice(0, MAX_CARDS)) {
    // 契约约定：title = 玩家名，subtitle =「游戏名 · 评分体系」（见 src/commands/me.ts）。
    const title = normalizeText(card.title, 48) ?? normalizeText(card.subtitle, 32) ?? '未知游戏';
    const fields: NormalizedField[] = [];
    for (const field of (card.fields ?? []).slice(0, MAX_FIELDS)) {
      const label = normalizeText(field.label, 24);
      const value = normalizeText(field.value, 40);
      if (label === null && value === null) continue;
      fields.push({ label, value: value ?? '—' });
    }
    // 优先调用方传入的背景；否则用 App 同名默认背景（maimai 背景板 / arcaea bg_light）；
    // 两者都没有就留空，由卡片 surface 纯色兜底。
    const gameKey = card.game.trim().toLowerCase();
    const callerBackground = toDataUrl(card.background);
    const defaultBackground = callerBackground === null ? defaultBackgrounds[gameKey] : undefined;
    if (callerBackground === null) {
      fallbackBackgrounds += 1;
      if (defaultBackground !== undefined) defaultBackgroundGames.push(gameKey);
    }
    cards.push({
      game: card.game,
      title,
      subtitle: normalizeText(card.subtitle, 72),
      rating: normalizeText(card.rating, 24),
      background: callerBackground ?? defaultBackground ?? null,
      avatar: toDataUrl(card.avatar),
      fields,
    });
  }

  return {
    displayName: normalizeText(input.displayName, 64) ?? 'RankHub 账号',
    uid: normalizeText(input.uid, 48),
    bio: normalizeText(input.bio, 240),
    banner: toDataUrl(input.banner),
    avatar: toDataUrl(input.avatar),
    qr: toDataUrl(input.qr),
    games,
    cards,
    fallbackBackgrounds,
    defaultBackgroundGames,
  };
}

/** 生成整页 HTML（`fontFaceCss` 由调用方按可用字体注入，可为空）。 */
export function buildCardHtml(
  input: PlayerCardInput,
  options: { fontFaceCss?: string; defaultBackgrounds?: Record<string, string> } = {},
): CardHtmlBuildResult {
  const model = normalize(input, options.defaultBackgrounds ?? {});
  const displayName = model.displayName;
  const avatar = model.avatar
    ? `<img src="${model.avatar}" alt="">`
    : `<div class="avatar-fallback">${escapeHtml(initialOf(displayName))}</div>`;
  const banner = model.banner
    ? `<div class="hero-banner"><img src="${model.banner}" alt=""></div>
        <div class="hero-scrim"></div>`
    : `<div class="hero-banner"><div class="hero-fallback">RankHub</div></div>
        <div class="hero-scrim"></div>`;

  const cardsHtml =
    model.cards.length > 0
      ? model.cards.map((card, index) => renderCard(card, index)).join('\n')
      : `<div class="empty">
          <div class="empty-title">还没有公开的游戏档案</div>
          <div class="empty-hint">在 RankHub App 上传档案后，这里会自动出现游戏卡片</div>
        </div>`;

  // App：UID 缺失显示「UID 暂不可用」，bio 缺失显示默认简介（my_qr_code_page.dart:322-339）。
  const uidLine = model.uid
    ? `          <div class="uid">UID: <span class="uid-value">${escapeHtml(model.uid)}</span></div>`
    : `          <div class="uid">UID 暂不可用</div>`;
  const bioLine = `          <div class="bio">${escapeHtml(model.bio ?? '这个人很神秘，还没有填写个人简介。')}</div>`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
${options.fontFaceCss ?? ''}${CARD_CSS}
</style>
</head>
<body>
  <div class="page">
    <div class="sheet">
      <header class="hero">
${banner}
        <div class="hero-avatar">${avatar}</div>
      </header>
      <section class="profile">
        <div class="name">${escapeHtml(displayName)}</div>
${uidLine}
${bioLine}
      </section>
      <div class="divider"></div>${renderIcons(model.games)}
      <div class="divider"></div>
      <section class="games">
        <div class="section-head">
          <div class="section-title">游戏档案</div>
          <div class="section-count">${model.cards.length} 个游戏</div>
        </div>
${cardsHtml}
      </section>${renderQr(model.qr)}
    </div>
  </div>
</body>
</html>`;

  return {
    html,
    summary: {
      hasBanner: model.banner !== null,
      hasAvatar: model.avatar !== null,
      hasQr: model.qr !== null,
      games: model.games.length,
      cards: model.cards.length,
      fields: model.cards.reduce((total, card) => total + card.fields.length, 0),
      fallbackBackgrounds: model.fallbackBackgrounds,
    },
    defaultBackgroundGames: model.defaultBackgroundGames,
  };
}
