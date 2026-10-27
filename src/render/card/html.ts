/**
 * 名片 HTML/CSS 生成：输入模型 → 单页 HTML（所有素材内联为 `data:` URL）。
 *
 * 约束：
 * - 固定 1200px 宽（`body` 宽度即输出 PNG 宽度），高度由内容自然撑开；
 * - 深色主题 + 圆角卡片；不引用任何外部 CSS/JS/字体/图片，`setContent` 即可离线渲染；
 * - 所有文案做 HTML 转义 + 长度截断，避免用户昵称/bio 把版式撑破或注入标签。
 */
import type { PlayerCardInput } from './types.js';

/** 输出 PNG 的固定宽度（px）。 */
export const CARD_WIDTH = 1200;

/** 单张卡片最多展示的游戏数 / 字段数（防御异常输入，渲染层不无上限拉长）。 */
const MAX_GAMES = 8;
const MAX_CARDS = 8;
const MAX_FIELDS = 4;

/** 已知游戏的主题色（与各游戏社区视觉习惯一致）；其余走调色板轮转。 */
const GAME_ACCENTS: Record<string, string> = {
  maimai: '#ff6fae',
  phigros: '#4fd6ff',
  arcaea: '#a98bff',
  chunithm: '#ffc85e',
  ongelki: '#ff8d6b',
};

const FALLBACK_ACCENTS = ['#7c9cff', '#ffb257', '#5ee0b7', '#ff8d9a'] as const;

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

/** 归一化一行文本：合并空白、去首尾、按长度截断（超出用省略号）。 */
function normalizeText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 头像/图标占位字：取展示名第一个字符（处理代理对），没有就用 R。 */
function initialOf(name: string | null | undefined): string {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (normalized === '') return 'R';
  return Array.from(normalized)[0] ?? 'R';
}

function accentFor(game: string, index: number): string {
  const known = GAME_ACCENTS[game.trim().toLowerCase()];
  if (known) return known;
  const fallback = FALLBACK_ACCENTS[index % FALLBACK_ACCENTS.length];
  return fallback ?? FALLBACK_ACCENTS[0];
}

interface NormalizedField {
  label: string | null;
  value: string;
}

interface NormalizedCard {
  title: string;
  game: string;
  rating: string | null;
  subtitle: string | null;
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
  };
}

/** 名片全部样式（内联进 `<style>`，避免任何外部请求）。 */
export const CARD_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${CARD_WIDTH}px; }
body {
  width: ${CARD_WIDTH}px;
  background: #06070b;
  color: #eef2fb;
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  overflow: hidden;
}
:root {
  --font-ui: "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif;
  --font-display: "RankHub Display", "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif;
}
.page {
  width: ${CARD_WIDTH}px;
  padding: 22px;
  background:
    radial-gradient(1100px 560px at 16% -12%, rgba(64, 92, 190, .55), rgba(6, 7, 11, 0) 62%),
    radial-gradient(900px 520px at 96% 2%, rgba(150, 58, 128, .32), rgba(6, 7, 11, 0) 58%),
    #06070b;
}
.sheet {
  position: relative;
  border-radius: 40px;
  overflow: hidden;
  background: #101320;
  border: 1px solid rgba(255, 255, 255, .07);
  box-shadow: 0 44px 120px rgba(0, 0, 0, .55);
}

/* ── 顶部 banner + 用户信息 ── */
.hero { position: relative; height: 286px; background: #151a28; overflow: hidden; }
.hero--bare { height: 236px; }
.hero-banner { position: absolute; inset: 0; }
.hero-banner img { display: block; width: 100%; height: 100%; object-fit: cover; }
.hero-mesh {
  position: absolute; inset: 0;
  background:
    radial-gradient(640px 380px at 14% 8%, rgba(88, 118, 255, .55), rgba(10, 13, 21, 0) 68%),
    radial-gradient(560px 340px at 82% -6%, rgba(255, 96, 168, .38), rgba(10, 13, 21, 0) 66%),
    linear-gradient(126deg, #1a2136 0%, #121624 52%, #0d101a 100%);
}
.hero-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(6, 7, 11, .34) 0%, rgba(6, 7, 11, .06) 42%, rgba(16, 19, 32, .94) 100%);
}
.hero-brand {
  position: absolute; left: 44px; top: 40px;
  display: inline-flex; align-items: center; gap: 13px;
  font-family: var(--font-display);
  font-size: 19px; letter-spacing: .42em; text-transform: uppercase;
  color: rgba(255, 255, 255, .78);
  text-shadow: 0 2px 14px rgba(0, 0, 0, .5);
}
.hero-brand::before {
  content: ''; width: 10px; height: 10px; border-radius: 50%;
  background: #7c9cff; box-shadow: 0 0 18px rgba(124, 156, 255, .9);
}
.profile {
  position: relative; display: flex; align-items: center; gap: 30px;
  padding: 0 52px; margin-top: -80px;
}
.avatar {
  flex: 0 0 auto; width: 156px; height: 156px; border-radius: 50%;
  border: 6px solid #101320; background: #1b2233; overflow: hidden;
  box-shadow: 0 20px 48px rgba(0, 0, 0, .5);
}
.avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.avatar-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 62px; font-weight: 700;
  color: #dfe6ff; background: linear-gradient(140deg, #3d4d82 0%, #1a2236 100%);
}
.ident { min-width: 0; flex: 1 1 auto; padding-top: 6px; }
.name {
  font-size: 46px; line-height: 1.18; font-weight: 700; letter-spacing: .01em;
  color: #f4f7ff;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uid { margin-top: 12px; font-size: 21px; letter-spacing: .06em; color: #98a2b8; }
.uid-value {
  font-family: var(--font-ui); font-size: 22px; font-weight: 600; color: #dfe6f8;
  letter-spacing: .1em; font-variant-numeric: tabular-nums;
}
.bio {
  margin-top: 16px; max-width: 880px; font-size: 21px; line-height: 1.6; color: #b7c0d4;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}

/* ── 已绑定游戏图标条 ── */
.strip { padding: 32px 52px 0; }
.strip-label {
  font-size: 14px; letter-spacing: .22em; text-transform: uppercase; color: #7f8aa3;
  margin-bottom: 16px;
}
.strip-list { display: flex; align-items: flex-start; gap: 26px; flex-wrap: wrap; }
.strip-item { display: flex; flex-direction: column; align-items: center; width: 112px; }
.strip-icon {
  width: 84px; height: 84px; border-radius: 50%; overflow: hidden;
  background: #1b2233; border: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .4), inset 0 0 0 4px rgba(255, 255, 255, .04);
}
.strip-icon img { display: block; width: 100%; height: 100%; object-fit: cover; }
.strip-icon-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 30px; color: #dfe6f8;
}
.strip-name {
  margin-top: 10px; max-width: 112px; font-size: 17px; color: #a8b2c7; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── 游戏档案卡片 ── */
.divider {
  height: 1px; margin: 30px 52px 0;
  background: linear-gradient(90deg, rgba(255, 255, 255, .14), rgba(255, 255, 255, .03));
}
.games { padding: 28px 52px 34px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; }
.section-title { font-size: 20px; font-weight: 600; letter-spacing: .16em; color: #dfe6f8; }
.section-count { font-size: 15px; letter-spacing: .12em; color: #7f8aa3; }
.game {
  position: relative; overflow: hidden; border-radius: 30px;
  background: linear-gradient(128deg, #1b2132 0%, #131725 58%, #10131d 100%);
  border: 1px solid rgba(255, 255, 255, .07);
  padding: 30px 34px 32px 40px;
  margin-bottom: 22px;
}
.game:last-child { margin-bottom: 0; }
.game::before {
  content: ''; position: absolute; left: 0; top: 26px; bottom: 26px; width: 6px;
  border-radius: 0 6px 6px 0;
  background: var(--accent); opacity: .95;
  box-shadow: 0 0 24px var(--accent);
  z-index: 3;
}
.game-bg { position: absolute; inset: 0; }
.game-bg img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: .62; }
.game-tint {
  position: absolute; inset: 0;
  background:
    linear-gradient(96deg, rgba(13, 16, 26, .95) 0%, rgba(13, 16, 26, .82) 44%, rgba(13, 16, 26, .58) 100%),
    radial-gradient(560px 220px at 0% 0%, rgba(255, 255, 255, .05), rgba(0, 0, 0, 0) 70%);
}
.game-content { position: relative; z-index: 2; }
.game-top { display: flex; align-items: center; gap: 24px; }
.game-avatar {
  flex: 0 0 auto; width: 92px; height: 92px; border-radius: 50%; overflow: hidden;
  background: #1b2233; border: 2px solid rgba(255, 255, 255, .16);
}
.game-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.game-avatar-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 38px; color: #e6ecff;
  background: linear-gradient(140deg, rgba(124, 156, 255, .5), rgba(20, 24, 38, .9));
}
.game-meta { flex: 1 1 auto; min-width: 0; }
.game-name {
  font-size: 36px; font-weight: 700; color: #f4f7ff; letter-spacing: .01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.game-sub {
  margin-top: 8px; font-size: 19px; color: #a7b1c6;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.game-rating { flex: 0 0 auto; text-align: right; padding-left: 24px; }
.rating-value {
  display: block; max-width: 420px;
  font-family: var(--font-display); font-size: 62px; line-height: 1.05; font-weight: 700;
  background: linear-gradient(180deg, #ffffff 12%, var(--accent) 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  letter-spacing: .02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rating-value--empty {
  background: none; -webkit-text-fill-color: #6f7a90; color: #6f7a90;
  font-size: 48px; font-weight: 500;
}
.rating-label {
  margin-top: 6px; font-size: 13px; letter-spacing: .26em; text-transform: uppercase;
  color: #8d97ad;
}
.fields { display: flex; gap: 14px; margin-top: 28px; }
.field {
  flex: 1 1 0; min-width: 0; padding: 16px 20px 17px; border-radius: 18px;
  background: rgba(255, 255, 255, .055); border: 1px solid rgba(255, 255, 255, .07);
}
.field-label {
  font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: #8d97ad;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.field-value {
  margin-top: 8px; font-family: var(--font-display); font-size: 27px; font-weight: 600;
  color: #eef3ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.empty {
  padding: 46px 40px; border-radius: 26px; text-align: center;
  border: 1px dashed rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .02);
}
.empty-title { font-size: 24px; font-weight: 600; color: #cdd6ea; }
.empty-hint { margin-top: 10px; font-size: 18px; color: #8a94a9; }

/* ── 底部二维码 ── */
.qr {
  position: relative; margin-top: 8px; padding: 36px 52px 48px;
  border-top: 1px solid rgba(255, 255, 255, .08);
  display: flex; flex-direction: column; align-items: center;
}
.qr-card {
  padding: 20px; border-radius: 34px; background: #ffffff;
  box-shadow: 0 26px 70px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .16);
}
.qr-img { display: block; width: 300px; height: 300px; border-radius: 14px; }
.qr-title { margin-top: 26px; font-size: 23px; letter-spacing: .06em; color: #dfe6f8; }
.qr-hint { margin-top: 9px; font-size: 18px; letter-spacing: .06em; color: #8d97ad; }
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
  const background = card.background
    ? `<div class="game-bg"><img src="${card.background}" alt=""></div>`
    : '';
  return `
      <article class="game" style="--accent: ${accent};">
${background}
        <div class="game-tint"></div>
        <div class="game-content">
          <div class="game-top">
            <div class="game-avatar">${avatar}</div>
            <div class="game-meta">
              <div class="game-name">${escapeHtml(card.title)}</div>
${card.subtitle ? `              <div class="game-sub">${escapeHtml(card.subtitle)}</div>` : ''}
            </div>
            <div class="game-rating">
              <span class="rating-value${card.rating === null ? ' rating-value--empty' : ''}">${escapeHtml(card.rating ?? '—')}</span>
              <div class="rating-label">rating</div>
            </div>
          </div>${renderFields(card.fields)}
        </div>
      </article>`;
}

function renderQr(qr: string | null): string {
  if (!qr) return '';
  return `
      <section class="qr">
        <div class="qr-card"><img class="qr-img" src="${qr}" alt="RankHub 二维码"></div>
        <div class="qr-title">RankHub 音游聚合平台</div>
        <div class="qr-hint">App 扫一扫 · 查看我的主页</div>
      </section>`;
}

/**
 * 把输入归一化成可渲染模型（截断超长文案、丢弃空素材、限制卡片/字段数量）。
 */
function normalize(input: PlayerCardInput): {
  displayName: string;
  uid: string | null;
  bio: string | null;
  banner: string | null;
  avatar: string | null;
  qr: string | null;
  games: NormalizedIcon[];
  cards: NormalizedCard[];
} {
  const games: NormalizedIcon[] = [];
  // 数组字段做一次防御性兜底：调用方误传 undefined 时仍然是「少图」而不是抛错。
  for (const game of (input.games ?? []).slice(0, MAX_GAMES)) {
    const name = normalizeText(game.name, 32);
    if (name === null) continue;
    games.push({ name, icon: toDataUrl(game.icon) });
  }

  const cards: NormalizedCard[] = [];
  for (const card of (input.cards ?? []).slice(0, MAX_CARDS)) {
    const title = normalizeText(card.title, 48) ?? normalizeText(card.game, 32) ?? '未知游戏';
    const fields: NormalizedField[] = [];
    for (const field of (card.fields ?? []).slice(0, MAX_FIELDS)) {
      const label = normalizeText(field.label, 24);
      const value = normalizeText(field.value, 40);
      if (label === null && value === null) continue;
      fields.push({ label, value: value ?? '—' });
    }
    cards.push({
      title,
      game: card.game,
      rating: normalizeText(card.rating, 24),
      subtitle: normalizeText(card.subtitle, 72),
      background: toDataUrl(card.background),
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
  };
}

/** 生成整页 HTML（`fontFaceCss` 由调用方按可用字体注入，可为空）。 */
export function buildCardHtml(
  input: PlayerCardInput,
  options: { fontFaceCss?: string } = {},
): CardHtmlBuildResult {
  const model = normalize(input);
  const displayName = model.displayName;
  const avatar = model.avatar
    ? `<img src="${model.avatar}" alt="">`
    : `<div class="avatar-fallback">${escapeHtml(initialOf(displayName))}</div>`;
  const heroBanner = model.banner
    ? `<div class="hero-banner"><img src="${model.banner}" alt=""></div>`
    : `<div class="hero-mesh"></div>`;

  const cardsHtml =
    model.cards.length > 0
      ? model.cards.map((card, index) => renderCard(card, index)).join('\n')
      : `<div class="empty">
          <div class="empty-title">还没有公开的游戏档案</div>
          <div class="empty-hint">在 RankHub App 上传档案后，这里会自动出现游戏卡片</div>
        </div>`;

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
      <header class="hero${model.banner ? '' : ' hero--bare'}">
${heroBanner}
        <div class="hero-scrim"></div>
        <div class="hero-brand">RankHub</div>
      </header>
      <section class="profile">
        <div class="avatar">${avatar}</div>
        <div class="ident">
          <div class="name">${escapeHtml(displayName)}</div>
${model.uid ? `          <div class="uid">UID · <span class="uid-value">${escapeHtml(model.uid)}</span></div>` : ''}
${model.bio ? `          <div class="bio">${escapeHtml(model.bio)}</div>` : ''}
        </div>
      </section>${renderIcons(model.games)}
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
    },
  };
}
