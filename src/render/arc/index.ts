/**
 * Arcaea B50 海报渲染（照搬 design 稿 best-posters 的 arcaea 版式）。
 *
 * 使用方式：
 * ```ts
 * const renderer = createArcaeaRenderer();
 * try {
 *   const png = await renderer.renderArcaeaB50({ profileName, potential, items });
 * } finally {
 *   await renderer.close();
 * }
 * ```
 *
 * 素材准备（首次/更新）：`node scripts/fetch-assets-arc.mjs`
 * （从 /Users/qianmo/personal/projects/designs/best-posters 复制曲绘/字体/logo → vendor/arc）
 */
export {
  ARC_FONT_FILES,
  ArcAssetError,
  DEFAULT_ARC_ASSETS_DIR,
  REPO_ROOT,
  describeArcAssets,
  findBrowserExecutable,
  listAvailableFonts,
  loadArcAssets,
  loadCoversIndex,
  lookupSong,
  resolveArcAssetsDir,
  resolveCoverFile,
  toFileUrl,
  type ArcAssets,
  type ArcCoverEntry,
  type ArcCoverLevel,
  type ArcCoversIndex,
  type ArcFontFile,
  type BrowserLaunchTarget,
} from './assets.js';
export {
  BEST_VISIBLE,
  DEFAULT_DIFFICULTY_COLOR,
  DIFFICULTY_COLORS,
  DIFFICULTY_NAMES,
  FORMULA_NOTE,
  arcaeaGrade,
  arcaeaPtt,
  buildArcTemplateData,
  deriveGrade,
  formatConstant,
  fromGameScore,
  isGameScore,
  formatDate,
  formatJudgements,
  formatPlayTime,
  formatPotential,
  formatRating,
  formatScore,
  normalizeScore,
  resolveDifficulty,
  sortArcaeaScores,
  type ArcGradeTone,
  type ArcTemplateCard,
  type ArcTemplateData,
  type ArcTemplateStat,
} from './data.js';
export {
  ARC_OVERRIDES_CSS,
  ArcaeaRenderer,
  MAX_IMAGE_BYTES,
  POSTER_WIDTH,
  createArcaeaRenderer,
  injectOverrides,
  type ArcRenderResult,
  type ArcaeaRendererOptions,
} from './renderer.js';
export { buildArcPosterHtml, escapeHtml } from './template.js';
export type { ArcaeaB50RenderInput, ArcaeaDifficultySlot, ArcaeaRenderItem, ArcaeaScore } from './types.js';
