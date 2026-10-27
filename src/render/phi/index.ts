/**
 * phigros `/rks` 图片渲染（照搬 phi-plugin b19 版式）。
 *
 * 使用方式：
 * ```ts
 * const renderer = createPhigrosRenderer();
 * try {
 *   const png = await renderer.renderPhigrosRks(input);
 * } finally {
 *   await renderer.close();
 * }
 * ```
 *
 * 素材准备（首次/更新）：`node scripts/fetch-assets-phi.mjs`
 */
export {
  PHI_PLUGIN_COMMIT,
  PHI_PLUGIN_DISPLAY_NAME,
  PHI_PLUGIN_VERSION,
  DEFAULT_COVERS_DIR,
  DEFAULT_PHI_RESOURCES_DIR,
  REPO_ROOT,
  findBrowserExecutable,
  loadAssets,
  loadSongsIndex,
  resolveCoverFile,
  resolveCoversDir,
  resolveResourcesDir,
  type PhiAssets,
  type PhiSongEntry,
  type PhiSongsIndex,
} from './assets.js';
export {
  BEST_VISIBLE,
  LEVEL_KEYS,
  PHI_VISIBLE,
  buildPhiTemplateData,
  formatDate,
  normalizeLevelKey,
  phiRating,
  phiRks,
  resolveAcc,
  resolveScore,
  type PhiLevelKey,
  type PhiTemplateData,
  type PhiTemplateGameUser,
  type PhiTemplateSong,
} from './data.js';
export {
  MAX_IMAGE_BYTES,
  PHI_OVERRIDES_CSS,
  PhigrosRenderer,
  createPhigrosRenderer,
  describeAssets,
  injectOverrides,
  type PhiRenderResult,
  type PhiRendererOptions,
} from './renderer.js';
