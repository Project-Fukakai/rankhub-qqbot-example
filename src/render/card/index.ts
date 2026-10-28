/**
 * `/me` 玩家名片渲染（账号头部 + 游戏图标条 + 3 张 App 1:1 游戏卡 + 可选二维码）。
 *
 * 使用方式：
 * ```ts
 * const renderer = createPlayerCardRenderer();
 * try {
 *   const png = await renderer.renderPlayerCard(input);
 * } finally {
 *   await renderer.close();
 * }
 * ```
 *
 * 素材分两类：
 * - **动态素材**（账号 banner/头像、游戏图标、maimai 头像/背景板、phigros 头像/曲绘、
 *   arcaea 头像/立绘、二维码）由调用方传 `Buffer`，渲染器只内联成 `data:` URL；
 * - **静态素材**（App 字体、arcaea bg_light/hidden/banner/rating 图标、phigros 课题徽章、
 *   maimai DX Rating 徽章与数字）从 `vendor/card/**` 读取，由 `scripts/fetch-assets-card.mjs`
 *   准备；缺失时降级渲染，不抛错。
 * 渲染器不解析 URL、不发网络请求。
 */
export {
  APP_CARD_HEIGHT,
  APP_CARD_WIDTH,
  CARD_CONTENT_WIDTH,
  CARD_CSS,
  CARD_HEIGHT,
  CARD_SCALE,
  CARD_WIDTH,
  PHIGROS_DIFFICULTY_COLORS,
  arcaeaPttStrokeColor,
  arcaeaRatingIndex,
  buildCardHtml,
  buildGameCardHtml,
  escapeHtml,
  formatSyncTime,
  imageMimeType,
  maimaiDxAssetIndex,
  toDataUrl,
} from './html.js';
export type { CardAssetBundle, CardHtmlBuildResult } from './html.js';
export {
  CARD_IMAGE_KEYS,
  DEFAULT_CARD_ASSETS_DIR,
  DEFAULT_CARD_FONTS_DIR,
  LEGACY_DISPLAY_FAMILY,
  ORBITRON_FAMILY,
  PHI_FAMILY,
  PHI_FONT_DIR,
  SAIRA_FAMILY,
  fontFamilies,
  fontFaceCss,
  hasDisplayFont,
  loadCardAssets,
  loadCardFonts,
  loadCardImages,
} from './assets.js';
export type { CardAssets, CardFontFace } from './assets.js';
export {
  CardRenderer,
  MAX_CARD_IMAGE_BYTES,
  createPlayerCardRenderer,
  describeCardAssets,
} from './renderer.js';
export type {
  PhigrosDifficulty,
  PlayerCardArcaeaCardData,
  PlayerCardGameCard,
  PlayerCardGameIcon,
  PlayerCardInput,
  PlayerCardMaimaiCardData,
  PlayerCardPhigrosCardData,
  PlayerCardRect,
  PlayerCardRenderResult,
  PlayerCardRenderer,
  PlayerCardRendererOptions,
  PlayerCardSummary,
} from './types.js';
