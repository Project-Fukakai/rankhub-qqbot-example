/**
 * `/me` 玩家名片 HTML/CSS 生成：输入模型 → 单页 HTML（所有素材内联为 `data:` URL）。
 *
 * 三张游戏卡严格按 App「我的」页 `profileCardBuilder` 对应的组件还原
 * （`RankHub/lib/bootstrap/game_registry.dart:155,190,207`）：
 *
 * - maimai → `lib/modules/maimai/widgets/player_info_card.dart`（`PlayerInfoCard`）：
 *   背景板 cover、50% 起黑色渐变、左上方形头像、DX Rating 徽章 + 数字、白色名字条、
 *   右上最近同步、右下「往期版本 B35 / 当期版本 B15」。
 * - phigros → `lib/modules/phigros/widgets/phigros_player_card.dart`（`PhigrosPlayerCard`）：
 *   曲绘 fitWidth、50%→底部 60% 黑渐变、左上 720×140 头部（平行四边形 / 课题徽章 /
 *   RKS 白底 / 名字）、右下 60%×25% CLEAR·FC·PHI 平行四边形、难度平行四边形
 *   （`phigros_record_card.dart` 的 EZ/HD/IN/AT 颜色）。
 * - arcaea → `lib/modules/arcaea/widgets/arcaea_views.dart` 的 `ArcaeaPlayerInfoCard`（1194 起）：
 *   bg_light fitWidth、右侧 30% 黑渐变、hidden 75%、banner 20%、立绘、banner 右侧头像 +
 *   PTT 徽章、右上同步时间、banner 内名字、hidden 右侧 B50/B10 两列。
 *
 * **坐标系统**：App 卡片是 5:2，固定字号/偏移是逻辑像素，相对尺寸是卡片宽高的比例。
 * 我们以 App 参考卡 360×144 为「设计空间」逐值照抄 Dart 常量，再把整张卡用 CSS
 * `transform: scale(1120/360)` 放大到 1120×448。这样 Dart 里的 `height * 0.32`、
 * `fontSize: 13`、`skew: 32` 都能原样落在代码里，便于逐行对照。
 *
 * 约束：
 * - 页面固定 1200 宽（`body` 宽度即输出 PNG 宽度），卡片内容宽 1120、单卡 1120×448；
 * - 只引用内联 data URL，`setContent` 即可离线渲染，渲染器不发任何网络请求；
 * - 所有文案做 HTML 转义 + 长度截断，避免用户昵称/bio 注入标签或撑破版式；
 * - 需要「缩放文字以适应盒子」的地方（Flutter `FittedBox(scaleDown)`）由页面内联的
 *   `__cardFitText()` 在字体就绪后测量并缩放到设计空间内（不联网、无外部依赖）。
 */
import type {
  PhigrosDifficulty,
  PlayerCardArcaeaCardData,
  PlayerCardGameCard,
  PlayerCardInput,
  PlayerCardMaimaiCardData,
  PlayerCardPhigrosCardData,
  PlayerCardSummary,
} from './types.js';

/** 输出 PNG 的固定宽度（px）。 */
export const CARD_WIDTH = 1200;
/** 卡片内容宽度（页面左右各 40px 边距）。 */
export const CARD_CONTENT_WIDTH = 1120;
/** 单卡高度（5:2）。 */
export const CARD_HEIGHT = 448;
/** App 参考卡的设计空间尺寸（典型 360dp 屏宽 - 左右 16dp 边距 = 328，取整为 360 便于换算）。 */
export const APP_CARD_WIDTH = 360;
export const APP_CARD_HEIGHT = 144;
/** 设计空间 → 输出像素的缩放系数（1120 / 360 = 28/9）。 */
export const CARD_SCALE = CARD_CONTENT_WIDTH / APP_CARD_WIDTH;

/** App 深色主题取值（`RankHub/lib/application/theme.dart:26-34`）。 */
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

/** 防御异常输入：图标条 / 游戏卡都有上限，渲染层不会被无上限拉长。 */
const MAX_GAMES = 8;
const MAX_CARDS = 8;

/** Phigros 难度颜色（`phigros_record_card.dart:8-18`）。 */
export const PHIGROS_DIFFICULTY_COLORS: Record<PhigrosDifficulty, string> = {
  EZ: '#4CAF50',
  HD: '#2196F3',
  IN: '#F44336',
  AT: '#000000',
};

/** arcaea 评级徽章主体色（`arcaea_views.dart:1801-1810`，采样自 rating_{0-7}.png）。 */
const ARCAEA_RATING_BODY_COLORS = [
  '#323450',
  '#282E29',
  '#442C50',
  '#491F51',
  '#591738',
  '#591A44',
  '#6D2858',
  '#C07A99',
] as const;

/** maimai 未选背景板时的兜底（App `surfaceContainer` 近似值）。 */
const MAIMAI_FALLBACK_BG = '#1B1B1B';

/** Phigros 未选曲绘时的兜底：App `Colors.grey.shade900`（`phigros_player_card.dart:162`）。 */
const PHIGROS_FALLBACK_BG = '#212121';

/** 中文字体栈（Docker 镜像内置 fonts-noto-cjk；macOS 用 PingFang）。 */
const FONT_UI =
  '"PingFang SC","Noto Sans SC","Noto Sans CJK SC","Source Han Sans SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans JP","Helvetica Neue",Arial,sans-serif';
/** 展示字体栈：App 的 Saira 在前；缺失时回退旧版 Aldrich，再回退系统。 */
const FONT_DISPLAY = `"Saira","RankHub Display",${FONT_UI}`;

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
 * 识别 PNG / JPEG / GIF / WebP；识别不了按 PNG 交给浏览器（解码失败只会让该元素空白）。
 * 空 Buffer 视为没有素材。
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

/** 数字格式化：固定小数位；非有限数回退 '--'。 */
function fixed(value: number | null | undefined, digits: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

function intOrNull(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

/** 用「当前设计空间内的 px」输出 CSS 数值（保留 4 位，避免浮点噪声）。 */
function px(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * 最近同步时间：App 用 `DateTime.tryParse(...).toLocal()` + `yyyy-MM-dd HH:mm`
 * （`player_info_card.dart:372`、`arcaea_views.dart:2757`）。
 * 机器人无用户设备时区，这里固定用产品主要用户所在的 Asia/Shanghai，保证输出稳定。
 */
export function formatSyncTime(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: 'year' | 'month' | 'day' | 'hour' | 'minute'): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 头像缺失时的 Material `Icons.person` 近似（内联 SVG，不联网）。 */
const PERSON_ICON_SVG = `<svg class="person-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z"/></svg>`;

// ─────────────────────────────── 素材查找 ───────────────────────────────

export interface CardAssetBundle {
  /** 由 `assets.ts` 生成的 `@font-face` 片段（可为空）。 */
  fontFaceCss?: string;
  /** 固定素材 key → data URL（`arcaea:banner` 等，见 `assets.ts`）。 */
  images?: Record<string, string>;
}

class AssetLookup {
  readonly used = new Set<string>();
  readonly missing = new Set<string>();

  constructor(private readonly images: Record<string, string>) {}

  /** 查询可用性（不计入 used/missing）。 */
  has(key: string): boolean {
    return typeof this.images[key] === 'string' && this.images[key] !== '';
  }

  /** 记录缺失但不使用（用于按档位回退的徽章）。 */
  noteMissing(key: string): void {
    this.missing.add(key);
  }

  /** 取素材；缺失时记入 missing 并返回 null。 */
  get(key: string): string | null {
    const value = this.images[key];
    if (typeof value === 'string' && value !== '') {
      this.used.add(key);
      return value;
    }
    this.missing.add(key);
    return null;
  }
}

// ─────────────────────────────── 页面样式 ───────────────────────────────

const SCALE_LITERAL = CARD_SCALE.toFixed(10);

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
  --font-ui: ${FONT_UI};
  --font-system: "Helvetica Neue","Segoe UI",Arial,"PingFang SC","Noto Sans SC","Noto Sans CJK SC",sans-serif;
  --font-display: ${FONT_DISPLAY};
  --font-orbitron: "Orbitron","Saira",${FONT_UI};
  --font-saira: "Saira",${FONT_UI};
  --surface-base: ${APP_DARK.surfaceBase};
  --surface-low: ${APP_DARK.surfaceLow};
  --surface: ${APP_DARK.surface};
  --surface-high: ${APP_DARK.surfaceHigh};
  --outline: ${APP_DARK.outline};
  --outline-variant: ${APP_DARK.outlineVariant};
  --on-surface: ${APP_DARK.onSurface};
  --on-surface-variant: ${APP_DARK.onSurfaceVariant};
  --card-scale: ${SCALE_LITERAL};
}

/* ── 页面骨架（沿用 v1 名片：账号 banner / 头像 / 名字 / 图标条 / 二维码） ── */
.page { width: ${CARD_WIDTH}px; padding: 40px; background: var(--surface-base); }
.sheet { position: relative; width: ${CARD_CONTENT_WIDTH}px; border-radius: 34px; overflow: hidden; background: #0b0b0c; }
.hero { position: relative; height: 500px; background: #0b0b0c; }
.hero-banner { position: absolute; left: 0; right: 0; top: 0; height: 420px; overflow: hidden; background: #272727; }
.hero-banner img { display: block; width: 100%; height: 100%; object-fit: cover; }
.hero-scrim { position: absolute; left: 0; right: 0; top: 0; height: 420px; background: rgba(0, 0, 0, .12); }
.hero-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  background: #272727; font-size: 64px; font-weight: 700; color: var(--on-surface);
}
.hero-avatar {
  position: absolute; left: 40px; bottom: 0; width: 208px; height: 208px;
  border-radius: 50%; border: 8px solid #0b0b0c; overflow: hidden;
  background: #1b1b1b; box-shadow: 0 18px 44px rgba(0, 0, 0, .55);
}
.hero-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.avatar-fallback {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
  font-family: var(--font-display); font-size: 82px; font-weight: 700;
  color: #f2f6ff; background: linear-gradient(140deg, #3a4459 0%, #171b26 100%);
}
.profile { padding: 26px 40px 36px; }
.name {
  font-size: 62px; line-height: 1.2; font-weight: 700; letter-spacing: .005em;
  color: var(--on-surface); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.uid { margin-top: 14px; font-size: 32px; letter-spacing: .01em; color: var(--on-surface-variant); }
.uid-value {
  font-variant-numeric: tabular-nums; color: var(--on-surface); font-weight: 600; letter-spacing: .04em;
}
.bio {
  margin-top: 18px; max-width: 1000px; font-size: 30px; line-height: 1.6;
  color: var(--on-surface-variant);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.divider { height: 1px; margin: 0 40px; background: var(--outline-variant); }
.strip { padding: 30px 40px 34px; text-align: center; }
.strip-label {
  font-size: 20px; letter-spacing: .16em; color: var(--on-surface-variant); margin-bottom: 22px;
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

/* ── 游戏卡：内容宽 1120、单卡 1120×448；内部按 App 设计空间 360×144 缩放 ── */
.games { padding: 34px 0 40px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 26px; }
.section-title { font-size: 24px; font-weight: 600; letter-spacing: .06em; color: var(--on-surface); }
.section-count { font-size: 18px; letter-spacing: .06em; color: var(--on-surface-variant); }
.game-wrap { position: relative; margin-bottom: 34px; }
.game-wrap:last-child { margin-bottom: 0; }
.game-card {
  position: relative; width: ${CARD_CONTENT_WIDTH}px; height: ${CARD_HEIGHT}px;
  overflow: hidden; border-radius: ${px(12 * CARD_SCALE)}px;
  background: #000; isolation: isolate;
}
.card-inner {
  position: absolute; left: 0; top: 0;
  width: ${APP_CARD_WIDTH}px; height: ${APP_CARD_HEIGHT}px;
  transform: scale(${SCALE_LITERAL}); transform-origin: top left;
  font-family: var(--font-ui);
}
.card-inner img { display: block; }

/* Flutter FittedBox(scaleDown) 的通用容器：测量后由 __cardFitText 缩放内层文字。 */
.fit-box { display: flex; align-items: center; overflow: hidden; }
.fit-box[data-fit-origin="left"] { justify-content: flex-start; }
.fit-box[data-fit-origin="center"] { justify-content: center; }
.fit-text { display: inline-block; white-space: nowrap; transform-origin: center center; min-width: max-content; }
.fit-box[data-fit-origin="left"] .fit-text { transform-origin: left center; }

/* ── maimai PlayerInfoCard（player_info_card.dart:107-195） ── */
.m-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.m-bg-fallback { position: absolute; inset: 0; background: ${MAIMAI_FALLBACK_BG}; }
.m-overlay {
  position: absolute; left: 0; right: 0; top: 72px; bottom: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, .8) 100%);
}
.m-avatar {
  position: absolute; border-radius: 8px; overflow: hidden;
  background: rgba(255, 255, 255, .18);
  border: 1px solid rgba(255, 255, 255, .75);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .22);
}
.m-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 7px; }
.m-avatar .person-icon { width: 58%; height: 58%; margin: 21% auto; color: #fff; }
.m-rating { position: absolute; }
.m-rating-badge { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.m-digit { position: absolute; object-fit: contain; }
.m-rating-text {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-family: var(--font-orbitron); font-weight: 700; font-size: 27px; color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .54);
}
.m-name {
  position: absolute; background: rgba(255, 255, 255, .94); border-radius: 4px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .2); padding: 0 8px; display: flex; align-items: center;
}
.m-name .fit-text { font-family: var(--font-system); font-size: 13px; font-weight: 700; color: #252525; }
.m-sync {
  position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column;
  align-items: flex-end; text-align: right; color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .54);
  font-family: var(--font-system);
}
.m-sync-date { font-size: 10px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.m-sync-label { font-size: 8px; font-weight: 600; line-height: 1.3; }
.m-versions {
  position: absolute; right: 8px; bottom: 8px; display: flex; align-items: flex-start; gap: 24px;
  color: #fff; text-shadow: 0 1px 4px rgba(0, 0, 0, .54);
  font-family: var(--font-system);
}
.m-stat { display: flex; flex-direction: column; align-items: flex-start; }
.m-stat-label { font-size: 12px; font-weight: 600; line-height: 1.2; }
.m-stat-value {
  font-family: var(--font-orbitron); font-size: 24px; font-weight: 700; line-height: 1.2;
}

/* ── phigros PhigrosPlayerCard（phigros_player_card.dart:134-281） ── */
.p-bg { position: absolute; left: 0; top: 50%; width: 100%; height: auto; transform: translateY(-50%); }
.p-bg-fallback { position: absolute; inset: 0; background: ${PHIGROS_FALLBACK_BG}; }
.p-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 50%, rgba(0, 0, 0, .6) 100%);
}
.p-header {
  position: absolute; left: -8px; top: 0; width: 720px; height: 140px;
  transform: scale(.36); transform-origin: top left;
}
.p-panel {
  position: absolute; left: 200px; top: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, .5);
  clip-path: polygon(32px 0, 100% 0, calc(100% - 32px) 100%, 0 100%);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .4));
}
.p-panel-content { position: absolute; inset: 6px 20px 6px 8px; display: flex; }
.p-left { position: relative; flex: 1 1 auto; min-width: 0; }
.p-challenge { position: absolute; left: 40px; top: 12px; }
.p-challenge-img { position: absolute; object-fit: fill; }
.p-challenge-text {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-family: var(--font-saira); font-weight: 700; color: #fff;
}
.p-rks {
  position: absolute; left: 8px; bottom: 8px; background: #fff;
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .4));
  padding: 6px 16px; display: flex; align-items: center;
}
.p-rks-text {
  font-family: var(--font-saira); font-size: 26px; font-weight: 700; color: #000; line-height: 1.15;
  white-space: nowrap;
}
.p-name-col {
  flex: 0 0 auto; max-width: 300px; margin-right: 16px;
  display: flex; align-items: center; justify-content: flex-end; min-width: 0;
}
.p-name {
  font-family: var(--font-saira); font-size: 32px; font-weight: 700; color: #fff;
  line-height: 1.2; max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: right;
}
.p-avatar {
  position: absolute; left: 0; top: 0; width: 240px; height: 140px; background: #fff;
  clip-path: polygon(24px 0, 100% 0, calc(100% - 24px) 100%, 0 100%);
  filter: drop-shadow(0 3px 6px rgba(0, 0, 0, .5));
}
.p-avatar img { width: 100%; height: 100%; object-fit: cover; }
.p-stats {
  position: absolute; right: -8px; bottom: 0; width: 216px; height: 36px;
  background: rgba(0, 0, 0, .5);
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .4));
  padding: 4px 12px; display: flex;
}
.p-stat { flex: 1 1 0; min-width: 0; }
.p-stat { display: flex; align-items: center; justify-content: center; }
.p-stat-inner { display: flex; flex-direction: column; align-items: center; }
.p-stat-row {
  display: flex; align-items: baseline; justify-content: center;
  font-family: var(--font-system); white-space: nowrap; line-height: 1.15;
}
.p-stat-value { font-size: 16px; font-weight: 700; color: #fff; }
.p-stat-total { font-size: 10px; color: rgba(255, 255, 255, .72); }
.p-stat-label {
  font-family: var(--font-system); font-size: 9px; font-weight: 600;
  color: rgba(255, 255, 255, .72); text-align: center; line-height: 1.2;
}
.p-difficulty {
  position: absolute; right: 198px; bottom: 0; width: 72px; height: 43.2px;
  display: flex; align-items: center; justify-content: center;
  clip-path: polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .4));
  padding: 4px 8px;
}
.p-difficulty-text {
  font-family: var(--font-saira); font-size: 14px; font-weight: 700; color: #fff; line-height: 1;
}

/* ── arcaea ArcaeaPlayerInfoCard（arcaea_views.dart:1457-1712） ── */
.a-bg { position: absolute; left: 0; top: 50%; width: 100%; height: auto; transform: translateY(-50%); }
.a-bg-fallback {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, #1a1d2b 0%, #2a2036 55%, #101018 100%);
}
.a-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0) 50%, rgba(0, 0, 0, .3) 100%);
}
.a-hidden { position: absolute; left: -14px; bottom: -14px; height: 108px; width: auto; }
.a-char { position: absolute; left: 52px; bottom: 12px; width: 108px; height: 144px; }
.a-char-box {
  position: absolute; left: 0; top: 28.8px; width: 108px; height: 108px;
  transform: scale(3); transform-origin: 50% 15%;
}
.a-char-box img { width: 100%; height: 100%; object-fit: fill; }
.a-banner {
  position: absolute; left: 12px; top: 0; height: 28.8px;
  filter: drop-shadow(0 6px 20px rgba(0, 0, 0, .4));
}
.a-banner img { height: 100%; width: auto; }
.a-name {
  position: absolute; top: 0; display: flex; align-items: center; justify-content: flex-end;
  padding-right: 8px;
}
.a-name .fit-text {
  font-family: var(--font-saira); font-weight: 300; font-size: 13px; color: #fff;
  line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 2px 8px #000, 0 0 16px rgba(0, 0, 0, .54);
}
.a-avatar { position: absolute; }
.a-avatar-img { width: 100%; height: 100%; object-fit: cover; filter: drop-shadow(0 2px 6px rgba(0, 0, 0, .4)); }
.a-avatar-fallback {
  width: 100%; height: 100%; background: rgba(0, 0, 0, .26);
  display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, .7);
}
.a-avatar-fallback .person-icon { width: 62%; height: 62%; }
.a-ptt { position: absolute; right: -16px; bottom: -8px; }
.a-ptt-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
.a-ptt-fallback { position: absolute; inset: 0; border-radius: 50%; background: rgba(0, 0, 0, .55); }
.a-ptt-text {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  transform: translateY(-2px); overflow: hidden;
}
.a-ptt-value {
  font-family: var(--font-saira); font-weight: 700; font-size: 18px; line-height: 1;
  color: #fff; white-space: nowrap;
}
.a-ptt-dec { font-size: 10px; font-weight: 600; }
.a-sync {
  position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column;
  align-items: flex-end; text-align: right; color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, .54);
}
.a-sync-date { font-family: var(--font-saira); font-size: 10px; font-weight: 700; line-height: 1.2; }
.a-sync-label { font-family: var(--font-system); font-size: 8px; font-weight: 600; line-height: 1.3; }
.a-bests {
  position: absolute; display: flex; align-items: flex-start; gap: 18px;
  color: #fff; text-shadow: 0 1px 4px rgba(0, 0, 0, .54);
}
.a-stat { display: flex; flex-direction: column; align-items: flex-start; }
.a-stat-label { font-family: var(--font-saira); font-size: 10px; font-weight: 600; line-height: 1.2; }
.a-stat-value { font-family: var(--font-saira); font-size: 24px; line-height: 1.2; }
.a-stat-value--large { font-weight: 700; }
.a-stat-value--small { font-weight: 600; }

/* ── 底部二维码 ── */
.qr { margin: 0 40px; padding: 40px 0 56px; border-top: 1px solid var(--outline-variant); display: flex; flex-direction: column; align-items: center; }
.qr-card { padding: 26px; border-radius: 24px; background: #ffffff; box-shadow: 0 22px 56px rgba(0, 0, 0, .5); }
.qr-img { display: block; width: 520px; height: 520px; border-radius: 8px; }
.qr-title { margin-top: 30px; font-size: 24px; letter-spacing: .04em; color: var(--on-surface); }
.qr-hint { margin-top: 10px; font-size: 20px; letter-spacing: .04em; color: var(--on-surface-variant); }
.empty { margin: 0; padding: 52px 40px; border-radius: 24px; text-align: center; background: var(--surface-low); border: 1px dashed var(--outline); }
.empty-title { font-size: 26px; font-weight: 600; color: var(--on-surface); }
.empty-hint { margin-top: 12px; font-size: 20px; color: var(--on-surface-variant); }

/* ── 单卡导出页（测试/证据截图：只画一张 1120×448 卡片） ── */
body.card-export { width: ${CARD_CONTENT_WIDTH}px; background: #000; }
.card-export .game-card { margin: 0; }
`.trim();

/** 页面内联的 FittedBox 等价实现（字体就绪后测量并缩放）。 */
const FIT_SCRIPT = `
(function () {
  function fit(scope) {
    var nodes = (scope || document).querySelectorAll('[data-fit]');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var parent = el.parentElement;
      if (!parent) continue;
      el.style.transform = 'none';
      var style = getComputedStyle(parent);
      var availW = parent.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      var availH = parent.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
      // 注意：卡片内部有 transform: scale(...)，getBoundingClientRect 是缩放后的物理像素，
      // 而 clientWidth 是布局像素；两者混用会把文字缩得过小。这里统一用 offsetWidth/Height
      // （布局像素，忽略 transform）与 parent.clientWidth/Height 比较。
      var boxW = el.offsetWidth;
      var boxH = el.offsetHeight;
      if (boxW <= 0 || boxH <= 0) continue;
      var mode = el.getAttribute('data-fit');
      var scaleW = availW > 0 ? availW / boxW : 1;
      var scaleH = mode === 'both' && availH > 0 ? availH / boxH : 1;
      var scale = Math.min(1, scaleW, scaleH);
      if (scale < 0.999) {
        var origin = parent.getAttribute('data-fit-origin') === 'left' ? 'left center' : 'center center';
        el.style.transformOrigin = origin;
        el.style.transform = 'scale(' + scale + ')';
      }
    }
  }
  window.__cardFitText = fit;
  fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fit(); });
})();
`.trim();

// ─────────────────────────────── maimai ───────────────────────────────

/** App `_assetIndex`（`player_info_card.dart:473-486`）。 */
export function maimaiDxAssetIndex(rating: number): number {
  if (rating <= 999) return 1;
  if (rating <= 1999) return 2;
  if (rating <= 3999) return 3;
  if (rating <= 6999) return 4;
  if (rating <= 9999) return 5;
  if (rating <= 11999) return 6;
  if (rating <= 12999) return 7;
  if (rating <= 13999) return 8;
  if (rating <= 14499) return 9;
  if (rating <= 14999) return 10;
  if (rating <= 15999) return 11;
  return 12;
}

/** 选可用徽章：优先精确档位，缺失时退到不高于它的最大档位（再退到最小可用）。 */
function pickMaimaiBadge(lookup: AssetLookup, index: number): string | null {
  const available: number[] = [];
  for (let candidate = 1; candidate <= 12; candidate += 1) {
    if (lookup.has(`maimai:rating:${candidate}`)) available.push(candidate);
  }
  if (!available.includes(index)) lookup.noteMissing(`maimai:rating:${index}`);
  if (available.length === 0) {
    for (let candidate = 1; candidate <= 12; candidate += 1) {
      lookup.noteMissing(`maimai:rating:${candidate}`);
    }
    return null;
  }
  const fallback = available.filter((candidate) => candidate <= index).pop() ?? available[0];
  return lookup.get(`maimai:rating:${fallback}`);
}

function renderMaimaiCard(card: PlayerCardMaimaiCardData, lookup: AssetLookup): string {
  const width = APP_CARD_WIDTH;
  const height = APP_CARD_HEIGHT;
  // 以下常量逐行对应 player_info_card.dart:119-124。
  const contentPadding = Math.max(8, height * 0.055); // 8
  const avatarSize = height * 0.32; // 46.08
  const infoLeft = contentPadding + avatarSize + contentPadding; // 62.08
  const ratingHeight = avatarSize * 0.46; // 21.1968
  const infoGap = avatarSize * 0.08; // 3.6864
  const nameHeight = avatarSize * 0.46; // 21.1968

  const rating =
    typeof card.rating === 'number' && Number.isFinite(card.rating)
      ? Math.min(99999, Math.max(0, Math.trunc(card.rating)))
      : null;

  const frame = toDataUrl(card.frame) ?? lookup.get('bg:maimai');
  const avatar = toDataUrl(card.avatar);
  const syncTime = formatSyncTime(card.lastSyncedAt);
  const name = normalizeText(card.name, 48) ?? 'maimai Player';

  // 背景：App CachedNetworkImage(BoxFit.cover)；无素材时用 surfaceContainer 近似色。
  const background =
    frame === null
      ? '<div class="m-bg-fallback"></div>'
      : `<img class="m-bg" src="${frame}" alt="">`;

  // 头像：App 方形圆角 8 + 白色 75% 边框；无图回退 person 图标。
  const avatarHtml =
    avatar === null
      ? `<div class="m-avatar" style="left:${px(contentPadding)}px;top:${px(contentPadding)}px;width:${px(avatarSize)}px;height:${px(avatarSize)}px">${PERSON_ICON_SVG}</div>`
      : `<div class="m-avatar" style="left:${px(contentPadding)}px;top:${px(contentPadding)}px;width:${px(avatarSize)}px;height:${px(avatarSize)}px"><img src="${avatar}" alt=""></div>`;

  // DX Rating 徽章 + 数字（player_info_card.dart:409-471）。
  let ratingHtml = '';
  if (rating !== null) {
    const assetIndex = maimaiDxAssetIndex(rating);
    const badge = pickMaimaiBadge(lookup, assetIndex);
    const aspect = assetIndex >= 9 ? 600 / 126 : 662 / 128;
    const badgeWidth = ratingHeight * aspect;
    const style = `left:${px(infoLeft)}px;top:${px(contentPadding)}px;height:${px(ratingHeight)}px;width:${px(badgeWidth)}px`;
    if (badge === null) {
      ratingHtml = `<div class="m-rating" style="${style}"><div class="m-rating-text">${rating}</div></div>`;
    } else {
      const digits = String(rating).padStart(5, '0').split('');
      const digitHeight = ratingHeight * 0.32;
      const digitWidth = (digitHeight * 20) / 27;
      const digitAreaLeft = badgeWidth * (rating < 14000 ? 0.38 : 0.515);
      const digitAreaRight = badgeWidth * 0.085;
      const digitAreaWidth = badgeWidth - digitAreaLeft - digitAreaRight;
      const digitGap = badgeWidth * 0.039;
      const digitTotalWidth = digitWidth * digits.length + digitGap * (digits.length - 1);
      const digitStartLeft =
        digitAreaLeft + (digitAreaWidth - digitTotalWidth) / 2 + badgeWidth * 0.02;
      const digitNodes: string[] = [];
      for (let index = 0; index < digits.length; index += 1) {
        const digit = digits[index] ?? '0';
        const source = lookup.get(`maimai:num:${digit}`);
        if (source === null) continue;
        const left = digitStartLeft + (digitWidth + digitGap) * index;
        digitNodes.push(
          `<img class="m-digit" style="left:${px(left)}px;top:${px(ratingHeight * 0.36)}px;width:${px(digitWidth)}px;height:${px(digitHeight)}px" src="${source}" alt="">`,
        );
      }
      // 任一数字素材缺失时退回文字，避免徽章中间出现空洞。
      const digitsComplete = digitNodes.length === digits.length;
      ratingHtml = `<div class="m-rating" style="${style}">
          <img class="m-rating-badge" src="${badge}" alt="">
          ${digitsComplete ? digitNodes.join('') : `<div class="m-rating-text">${rating}</div>`}
        </div>`;
    }
  } else {
    // 没有 rating：不画徽章，保留文字占位，与 App 的 `--` 语义一致。
    const style = `left:${px(infoLeft)}px;top:${px(contentPadding)}px;height:${px(ratingHeight)}px;width:${px(120)}px`;
    ratingHtml = `<div class="m-rating" style="${style}"><div class="m-rating-text">--</div></div>`;
  }

  const nameWidth = width * 0.35; // 126
  return `
    ${background}
    <div class="m-overlay"></div>
    ${avatarHtml}
    ${ratingHtml}
    <div class="m-name fit-box" data-fit-origin="left" style="left:${px(infoLeft)}px;top:${px(contentPadding + ratingHeight + infoGap)}px;width:${px(nameWidth)}px;height:${px(nameHeight)}px">
      <span class="fit-text">${escapeHtml(name)}</span>
    </div>
    <div class="m-sync">
      ${syncTime === null ? '' : `<div class="m-sync-date">${escapeHtml(syncTime)}</div>`}
      <div class="m-sync-label">最近同步时间</div>
    </div>
    <div class="m-versions">
      <div class="m-stat">
        <div class="m-stat-label">往期版本 B35</div>
        <div class="m-stat-value">${card.b35Rating === null || card.b35Rating === undefined ? '--' : escapeHtml(String(Math.trunc(card.b35Rating)))}</div>
      </div>
      <div class="m-stat">
        <div class="m-stat-label">当期版本 B15</div>
        <div class="m-stat-value">${card.b15Rating === null || card.b15Rating === undefined ? '--' : escapeHtml(String(Math.trunc(card.b15Rating)))}</div>
      </div>
    </div>`;
}

// ─────────────────────────────── phigros ───────────────────────────────

/** 课题模式段位等级 → 底图 key（`phigros_challenge_badge.dart:18-33`）。 */
function phigrosBadgeKey(rankLevel: number | null): string {
  switch (rankLevel) {
    case 1:
      return 'phigros:badge:1';
    case 2:
      return 'phigros:badge:2';
    case 3:
      return 'phigros:badge:3';
    case 4:
      return 'phigros:badge:4';
    case 5:
      return 'phigros:badge:5';
    default:
      return 'phigros:badge:white';
  }
}

function renderPhigrosChallenge(
  rank: number,
  lookup: AssetLookup,
): string {
  // PhigrosChallengeBadge（fontSize=30，phigros_player_card.dart:382-390）。
  const fontSize = 30;
  const visibleHeight = fontSize * 0.85; // 25.5
  const imageHeight = visibleHeight / (100 / 192); // 48.96
  const imageWidth = imageHeight * (390 / 192); // 99.45
  const visibleWidth = imageWidth * (304 / 390); // 77.52
  const rankLevel = Math.floor(rank / 100);
  const text = String(rank % 100).padStart(2, '0');
  const badge = lookup.get(phigrosBadgeKey(rankLevel));
  const image =
    badge === null
      ? ''
      : `<img class="p-challenge-img" style="left:${px(-(imageWidth - visibleWidth) / 2)}px;top:${px(-(imageHeight - visibleHeight) / 2)}px;width:${px(imageWidth)}px;height:${px(imageHeight)}px" src="${badge}" alt="">`;
  return `<div class="p-challenge" style="width:${px(visibleWidth)}px;height:${px(visibleHeight)}px">
      ${image}
      <div class="p-challenge-text" style="transform:translateY(${px(-fontSize * 0.2)}px)">${escapeHtml(text)}</div>
    </div>`;
}

function renderPhigrosCard(card: PlayerCardPhigrosCardData, lookup: AssetLookup): string {
  const height = APP_CARD_HEIGHT;
  const background = toDataUrl(card.background);
  const avatar = toDataUrl(card.avatar);
  const rksValue = typeof card.rks === 'number' && Number.isFinite(card.rks) ? card.rks : 0;
  const rks = rksValue.toFixed(4);
  const name = normalizeText(card.name, 64) ?? 'Phigros Player';
  const rank = intOrNull(card.challengeModeRank) ?? 0;
  const challenge = rank > 0 ? renderPhigrosChallenge(rank, lookup) : '';
  const achievements = card.achievements ?? { played: 0, clear: 0, fc: 0, phi: 0 };
  const played = Math.max(0, Math.trunc(achievements.played ?? 0));
  const clear = Math.max(0, Math.trunc(achievements.clear ?? 0));
  const fc = Math.max(0, Math.trunc(achievements.fc ?? 0));
  const phi = Math.max(0, Math.trunc(achievements.phi ?? 0));
  const difficulty: PhigrosDifficulty =
    card.difficulty === 'EZ' || card.difficulty === 'HD' || card.difficulty === 'IN' || card.difficulty === 'AT'
      ? card.difficulty
      : 'IN';

  const stat = (label: string, achieved: number): string => `
      <div class="p-stat">
        <div class="fit-box" data-fit-origin="center" style="height:28px;width:100%">
          <span class="fit-text p-stat-inner">
            <span class="p-stat-row"><span class="p-stat-value">${achieved}</span><span class="p-stat-total">/${played}</span></span>
            <span class="p-stat-label">${label}</span>
          </span>
        </div>
      </div>`;

  const avatarHtml =
    avatar === null
      ? ''
      : `<div class="p-avatar"><img src="${avatar}" alt=""></div>`;

  return `
    ${background === null ? '<div class="p-bg-fallback"></div>' : `<img class="p-bg" src="${background}" alt="">`}
    <div class="p-overlay"></div>
    <div class="p-header">
      <div class="p-panel">
        <div class="p-panel-content">
          <div class="p-left">
            ${challenge}
            <div class="p-rks"><span class="p-rks-text">${escapeHtml(rks)}</span></div>
          </div>
          <div class="p-name-col"><div class="p-name">${escapeHtml(name)}</div></div>
        </div>
      </div>
      ${avatarHtml}
    </div>
    <div class="p-stats">
      ${stat('CLEAR', clear)}
      ${stat('FC', fc)}
      ${stat('PHI', phi)}
    </div>
    <div class="p-difficulty" style="background:${PHIGROS_DIFFICULTY_COLORS[difficulty]}" data-difficulty="${difficulty}">
      <span class="p-difficulty-text">${difficulty}</span>
    </div>`;
}

// ─────────────────────────────── arcaea ───────────────────────────────

/** Potential → rating 图标索引（`arcaea_views.dart:1746-1756`）。 */
export function arcaeaRatingIndex(potential: number): number {
  if (potential < 3.5) return 0;
  if (potential < 7.0) return 1;
  if (potential < 10.0) return 2;
  if (potential < 11.0) return 3;
  if (potential < 12.0) return 4;
  if (potential < 12.5) return 5;
  if (potential < 13.0) return 6;
  return 7;
}

/** 徽章主色 → 黑（65%）的描边色（`arcaea_views.dart:1814-1818` 的 Color.lerp）。 */
export function arcaeaPttStrokeColor(ratingIndex: number): string {
  const body = ARCAEA_RATING_BODY_COLORS[ratingIndex] ?? '#000000';
  const value = body.replace('#', '');
  const channel = (offset: number): string => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16);
    return Math.round(raw * 0.35)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

function renderArcaeaPtt(potential: number, avatarSize: number, lookup: AssetLookup): string {
  const text = potential.toFixed(3);
  const dot = text.indexOf('.');
  const intPart = dot >= 0 ? text.slice(0, dot) : text;
  const decPart = dot >= 0 ? text.slice(dot) : '';
  const ratingIndex = arcaeaRatingIndex(potential);
  const stroke = arcaeaPttStrokeColor(ratingIndex);
  const badge = lookup.get(`arcaea:rating:${ratingIndex}`);
  const overlay =
    badge === null
      ? '<div class="a-ptt-fallback"></div>'
      : `<img class="a-ptt-img" src="${badge}" alt="">`;
  return `<div class="a-ptt" style="width:${px(avatarSize * 0.7)}px;height:${px(avatarSize * 0.7)}px">
      ${overlay}
      <div class="a-ptt-text fit-box" data-fit-origin="center">
        <span class="a-ptt-value fit-text" data-fit="both" style="-webkit-text-stroke:1px ${stroke}">${escapeHtml(intPart)}<span class="a-ptt-dec" style="-webkit-text-stroke:0.75px ${stroke}">${escapeHtml(decPart)}</span></span>
      </div>
    </div>`;
}

function renderArcaeaCard(card: PlayerCardArcaeaCardData, lookup: AssetLookup): string {
  const height = APP_CARD_HEIGHT;
  // arcaea_views.dart:1464-1483。
  const avatarSize = height * 0.4; // 57.6
  const bannerAspect = 564 / 74;
  const bannerWidth = height * 0.2 * bannerAspect; // 219.5027
  const bannerRight = 12 + bannerWidth; // 231.5027
  const avatarLeft = bannerRight - 40; // 191.5027
  const characterHeight = height * 0.75; // 108

  const name = normalizeText(card.name, 64) ?? '';
  const potential =
    typeof card.potential === 'number' && Number.isFinite(card.potential) ? card.potential : null;
  const b50 = fixed(card.b50Avg, 2);
  const b10 = fixed(card.b10Avg, 2);
  const syncTime = formatSyncTime(card.lastSyncedAt);

  const bg = lookup.get('arcaea:bg');
  const banner = lookup.get('arcaea:banner');
  const avatar = toDataUrl(card.avatar);
  const character = toDataUrl(card.characterArtwork);

  const layer = (key: string, className: string, alt = ''): string => {
    const source = lookup.get(key);
    return source === null ? '' : `<img class="${className}" src="${source}" alt="${alt}">`;
  };

  const avatarHtml =
    avatar === null
      ? `<div class="a-avatar-fallback">${PERSON_ICON_SVG}</div>`
      : `<img class="a-avatar-img" src="${avatar}" alt="">`;

  return `
    ${bg === null ? '<div class="a-bg-fallback"></div>' : `<img class="a-bg" src="${bg}" alt="">`}
    <div class="a-overlay"></div>
    ${layer('arcaea:hidden', 'a-hidden')}
    ${
      character === null
        ? ''
        : `<div class="a-char"><div class="a-char-box"><img src="${character}" alt=""></div></div>`
    }
    ${banner === null ? '' : `<div class="a-banner"><img src="${banner}" alt=""></div>`}
    <div class="a-name" style="left:-28px;width:${px(bannerWidth)}px;height:${px(height * 0.2)}px">
      <span class="fit-text">${escapeHtml(name)}</span>
    </div>
    <div class="a-avatar" style="left:${px(avatarLeft)}px;top:-10px;width:${px(avatarSize)}px;height:${px(avatarSize)}px">
      ${avatarHtml}
      ${potential === null ? '' : renderArcaeaPtt(potential, avatarSize, lookup)}
    </div>
    <div class="a-sync">
      ${syncTime === null ? '' : `<div class="a-sync-date">${escapeHtml(syncTime)}</div>`}
      <div class="a-sync-label">最近同步时间</div>
    </div>
    <div class="a-bests" style="left:${px(height * 1.6)}px;top:${px(height * 0.6)}px">
      <div class="a-stat">
        <div class="a-stat-label">B50 Avg</div>
        <div class="a-stat-value a-stat-value--large">${escapeHtml(b50)}</div>
      </div>
      <div class="a-stat">
        <div class="a-stat-label">B10 Avg</div>
        <div class="a-stat-value a-stat-value--small">${escapeHtml(b10)}</div>
      </div>
    </div>`;
}

// ─────────────────────────────── 组装 ───────────────────────────────

export interface CardHtmlBuildResult {
  html: string;
  summary: PlayerCardSummary;
  usedStaticAssets: string[];
  missingStaticAssets: string[];
}

function renderCardInner(card: PlayerCardGameCard, lookup: AssetLookup): string {
  switch (card.game) {
    case 'maimai':
      return renderMaimaiCard(card, lookup);
    case 'phigros':
      return renderPhigrosCard(card, lookup);
    case 'arcaea':
      return renderArcaeaCard(card, lookup);
    default: {
      // 判别联合已穷尽；运行期兜底（旧调用方/未来游戏）不崩。
      const unknown = card as { game?: unknown };
      return `<div class="p-bg-fallback"></div><div class="m-sync"><div class="m-sync-label">未知游戏 ${escapeHtml(String(unknown.game ?? ''))}</div></div>`;
    }
  }
}

function renderGameCard(card: PlayerCardGameCard, lookup: AssetLookup, index: number): string {
  return `<div class="game-wrap" data-card-index="${index}" data-game="${card.game}">
      <article class="game-card" data-game="${card.game}">
        <div class="card-inner ${card.game}-card">${renderCardInner(card, lookup)}</div>
      </article>
    </div>`;
}

function renderIcons(games: { name: string; icon: string | null }[]): string {
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

function renderQr(qr: string | null): string {
  if (!qr) return '';
  return `
      <section class="qr">
        <div class="qr-card"><img class="qr-img" src="${qr}" alt="RankHub 二维码"></div>
        <div class="qr-title">RankHub 音游聚合平台</div>
        <div class="qr-hint">App 扫一扫，看我主页</div>
      </section>`;
}

/** 头像占位字：取展示名第一个字符（处理代理对），没有就用 R。 */
function initialOf(name: string | null | undefined): string {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (normalized === '') return 'R';
  return Array.from(normalized)[0] ?? 'R';
}

function pageShell(options: CardAssetBundle, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
${options.fontFaceCss ?? ''}${CARD_CSS}
</style>
</head>
<body>
${bodyHtml}
<script>
${FIT_SCRIPT}
</script>
</body>
</html>`;
}

/** 生成整页 `/me` 名片 HTML。 */
export function buildCardHtml(
  input: PlayerCardInput,
  options: CardAssetBundle = {},
): CardHtmlBuildResult {
  const lookup = new AssetLookup(options.images ?? {});

  const games: { name: string; icon: string | null }[] = [];
  for (const game of (input.games ?? []).slice(0, MAX_GAMES)) {
    const name = normalizeText(game.name, 32);
    if (name === null) continue;
    games.push({ name, icon: toDataUrl(game.icon) });
  }

  const cards = (input.cards ?? []).slice(0, MAX_CARDS);
  const cardsByGame: string[] = [];
  const cardHtml: string[] = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!card) continue;
    cardsByGame.push(String(card.game));
    cardHtml.push(renderGameCard(card, lookup, index));
  }

  const displayName = normalizeText(input.displayName, 64) ?? 'RankHub 账号';
  const uid = normalizeText(input.uid, 48);
  const bio = normalizeText(input.bio, 240);
  const banner = toDataUrl(input.banner);
  const avatar = toDataUrl(input.avatar);
  const qr = toDataUrl(input.qr);

  const heroBanner =
    banner === null
      ? `<div class="hero-banner"><div class="hero-fallback">RankHub</div></div>
        <div class="hero-scrim"></div>`
      : `<div class="hero-banner"><img src="${banner}" alt=""></div>
        <div class="hero-scrim"></div>`;
  const heroAvatar =
    avatar === null
      ? `<div class="hero-avatar"><div class="avatar-fallback">${escapeHtml(initialOf(displayName))}</div></div>`
      : `<div class="hero-avatar"><img src="${avatar}" alt=""></div>`;

  // App：UID 缺失显示「UID 暂不可用」，bio 缺失显示默认简介（my_qr_code_page.dart:322-339）。
  const uidLine = uid
    ? `          <div class="uid">UID: <span class="uid-value">${escapeHtml(uid)}</span></div>`
    : `          <div class="uid">UID 暂不可用</div>`;
  const bioLine = `          <div class="bio">${escapeHtml(bio ?? '这个人很神秘，还没有填写个人简介。')}</div>`;

  const cardsHtml =
    cardHtml.length > 0
      ? cardHtml.join('\n')
      : `<div class="empty">
          <div class="empty-title">还没有公开的游戏档案</div>
          <div class="empty-hint">在 RankHub App 上传档案后，这里会自动出现游戏卡片</div>
        </div>`;

  const body = `  <div class="page">
    <div class="sheet">
      <header class="hero">
${heroBanner}
        ${heroAvatar}
      </header>
      <section class="profile">
        <div class="name">${escapeHtml(displayName)}</div>
${uidLine}
${bioLine}
      </section>
      <div class="divider"></div>${renderIcons(games)}
      <div class="divider"></div>
      <section class="games">
        <div class="section-head">
          <div class="section-title">游戏档案</div>
          <div class="section-count">${cardsByGame.length} 个游戏</div>
        </div>
${cardsHtml}
      </section>${renderQr(qr)}
    </div>
  </div>`;

  return {
    html: pageShell(options, body),
    summary: {
      hasBanner: banner !== null,
      hasAvatar: avatar !== null,
      hasQr: qr !== null,
      games: games.length,
      cards: cardsByGame.length,
      cardsByGame,
      usedStaticAssets: lookup.used.size,
      missingStaticAssets: lookup.missing.size,
    },
    usedStaticAssets: [...lookup.used].sort(),
    missingStaticAssets: [...lookup.missing].sort(),
  };
}

/** 生成「只含一张卡」的页面（测试/证据截图用；输出 1120×448 卡片元素）。 */
export function buildGameCardHtml(
  card: PlayerCardGameCard,
  options: CardAssetBundle = {},
): CardHtmlBuildResult {
  const lookup = new AssetLookup(options.images ?? {});
  const body = `  <article class="game-card" data-game="${card.game}">
    <div class="card-inner ${card.game}-card">${renderCardInner(card, lookup)}</div>
  </article>`;
  return {
    html: pageShell(options, body).replace('<body>', '<body class="card-export">'),
    summary: {
      hasBanner: false,
      hasAvatar: false,
      hasQr: false,
      games: 0,
      cards: 1,
      cardsByGame: [String(card.game)],
      usedStaticAssets: lookup.used.size,
      missingStaticAssets: lookup.missing.size,
    },
    usedStaticAssets: [...lookup.used].sort(),
    missingStaticAssets: [...lookup.missing].sort(),
  };
}
