/**
 * `/me` 玩家名片渲染（深色卡片 + 游戏图标条 + 各游戏卡片 + 可选二维码）。
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
 * 素材（banner / 头像 / 游戏图标 / 卡片背景 / 二维码）一律由调用方传 `Buffer`，
 * 渲染器只把它们内联成 `data:` URL，不解析 URL、不发网络请求，也不依赖 vendor 素材。
 * 展示字体可选：有 `vendor/card/fonts`（或 phi-plugin 的 Aldrich）就用，没有就回退系统字体。
 */
export { CARD_WIDTH, CARD_CSS, buildCardHtml, escapeHtml, imageMimeType, toDataUrl } from './html.js';
export type { CardHtmlBuildResult } from './html.js';
export {
  DEFAULT_CARD_FONTS_DIR,
  DISPLAY_FONT_FAMILY,
  PHI_FONT_DIR,
} from './assets.js';
export type { DisplayFontAsset } from './assets.js';
export {
  CardRenderer,
  MAX_CARD_IMAGE_BYTES,
  createPlayerCardRenderer,
  describeCardAssets,
} from './renderer.js';
export type {
  PlayerCardGameCard,
  PlayerCardGameField,
  PlayerCardGameIcon,
  PlayerCardInput,
  PlayerCardRenderResult,
  PlayerCardRenderer,
  PlayerCardRendererOptions,
} from './types.js';
