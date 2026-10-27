/**
 * Arcaea 海报素材访问层：`vendor/arc` 下的曲绘、字体、logo 与曲绘索引。
 *
 * 素材由 `scripts/fetch-assets-arc.mjs` 从 design 稿 best-posters 复制/裁剪生成
 * （`vendor/` 整个目录在 .gitignore 内，换机/CI 需重新跑一次脚本）。
 *
 * 目录结构：
 *   vendor/arc/covers/    <sha256(sourceCoverUrl) 前 16 位>.jpg + index.json + placeholder.svg
 *   vendor/arc/fonts/     Saira-{Regular,Medium,SemiBold,Bold}.ttf + 阿里妈妈数黑体.ttf
 *   vendor/arc/logos/     arcaea.svg（hero 字标）、rankhub.svg（页脚品牌标）
 *
 * 降级原则：**单个**曲绘/字体/logo 缺失都只是视觉降级（占位图 / 系统字体 / 文字标题），
 * 只有整套素材（index.json）缺失才抛错——因为那时海报已经画不出来，报错必须带可执行提示。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findBrowserExecutable, type BrowserLaunchTarget } from '../phi/assets.js';

/** src/render/arc → 仓库根。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_ARC_ASSETS_DIR = join(REPO_ROOT, 'vendor', 'arc');

export type { BrowserLaunchTarget };
export { findBrowserExecutable };

/** 曲绘索引里的一条难度记录（来自 best-posters 曲库快照）。 */
export interface ArcCoverLevel {
  difficulty: string;
  level: string | null;
  constant: number | null;
  difficultyIndex: number | null;
}

/** 曲绘索引里的一首歌。 */
export interface ArcCoverEntry {
  /** 曲绘文件名（相对 coversDir）。 */
  file: string;
  title: string;
  artist: string;
  /** 难度名 → 等级/定数。 */
  levels: Record<string, ArcCoverLevel>;
}

export interface ArcCoversIndex {
  version: number;
  generatedAt?: string;
  source?: string;
  /** 占位图文件名（相对 coversDir）。 */
  placeholder: string;
  songs: Record<string, ArcCoverEntry>;
}

/** 字体：文件名 → CSS 家族/字重（与 best-posters `css/base.css:1-5` 的 @font-face 对齐）。 */
export interface ArcFontFile {
  file: string;
  family: string;
  weight: number;
}

export const ARC_FONT_FILES: readonly ArcFontFile[] = [
  { file: 'Saira-Regular.ttf', family: 'Saira', weight: 400 },
  { file: 'Saira-Medium.ttf', family: 'Saira', weight: 500 },
  { file: 'Saira-SemiBold.ttf', family: 'Saira', weight: 600 },
  { file: 'Saira-Bold.ttf', family: 'Saira', weight: 700 },
  { file: '阿里妈妈数黑体.ttf', family: 'Alimama', weight: 700 },
];

/** 已就绪的素材集合（路径都是绝对路径）。 */
export interface ArcAssets {
  /** `vendor/arc`。 */
  assetsDir: string;
  coversDir: string;
  fontsDir: string;
  logosDir: string;
  index: ArcCoversIndex;
  /** 实际存在的字体文件（缺的不会出现在这里，模板只给存在的声明 @font-face）。 */
  fonts: ArcFontFile[];
  /** hero 字标 `arcaea.svg` 的 file:// URL；缺失为 null（hero 回退文字标题）。 */
  gameLogoUrl: string | null;
  /** 页脚/顶栏 RankHub 标记的 file:// URL；缺失为 null。 */
  rankhubMarkUrl: string | null;
  /** 缺曲绘占位图的 file:// URL。 */
  placeholderUrl: string;
}

/** 素材缺失时抛的错误：消息里带可执行的修复命令。 */
export class ArcAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArcAssetError';
  }
}

const MISSING_ASSETS_HINT =
  '请先运行 `node scripts/fetch-assets-arc.mjs`（从 design 稿 best-posters 复制曲绘/字体/logo），' +
  '或通过 ARC_ASSETS_DIR 指向已生成的 vendor/arc 目录。';

/**
 * 解析素材根目录：
 * 1. 显式参数（测试注入）；
 * 2. `ARC_ASSETS_DIR`；
 * 3. `vendor/arc`。
 */
export function resolveArcAssetsDir(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const env = process.env.ARC_ASSETS_DIR?.trim();
  if (env) candidates.push(env);
  candidates.push(DEFAULT_ARC_ASSETS_DIR);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'covers', 'index.json'))) return resolve(candidate);
  }
  throw new ArcAssetError(
    `未找到 arcaea 素材目录（缺 covers/index.json）：已查找 ${candidates.join('、')}。${MISSING_ASSETS_HINT}`,
  );
}

/** 读取曲绘索引；按 mtime 失效缓存，重跑 fetch 脚本后无需重启进程。 */
const indexCache = new Map<string, { mtimeMs: number; index: ArcCoversIndex }>();

export function loadCoversIndex(coversDir: string): ArcCoversIndex {
  const indexPath = join(coversDir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new ArcAssetError(`未找到曲绘索引 ${indexPath}。${MISSING_ASSETS_HINT}`);
  }
  const mtimeMs = statSync(indexPath).mtimeMs;
  const cached = indexCache.get(indexPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.index;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw new ArcAssetError(
      `曲绘索引 JSON 解析失败 ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const index = parsed as ArcCoversIndex;
  if (!index || typeof index !== 'object' || typeof index.songs !== 'object' || index.songs === null) {
    throw new ArcAssetError(`曲绘索引格式异常（缺 songs）: ${indexPath}`);
  }
  indexCache.set(indexPath, { mtimeMs, index });
  return index;
}

function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** 目录里实际存在的字体（保持 ARC_FONT_FILES 的顺序，利于 CSS 字节稳定）。 */
export function listAvailableFonts(fontsDir: string): ArcFontFile[] {
  if (!existsSync(fontsDir)) return [];
  const present = new Set(readdirSync(fontsDir));
  return ARC_FONT_FILES.filter((font) => present.has(font.file));
}

/**
 * 载入素材集合。
 *
 * 只对 `covers/index.json` 做硬校验；字体/logo/占位图缺失都降级不抛错，
 * 这样"素材没同步全"时仍能出一张能看的海报。
 */
export function loadArcAssets(options: { assetsDir?: string } = {}): ArcAssets {
  const assetsDir = resolveArcAssetsDir(options.assetsDir);
  const coversDir = join(assetsDir, 'covers');
  const fontsDir = join(assetsDir, 'fonts');
  const logosDir = join(assetsDir, 'logos');
  const index = loadCoversIndex(coversDir);

  const placeholderName = index.placeholder || 'placeholder.svg';
  const placeholderPath = join(coversDir, placeholderName);
  if (!existsSync(placeholderPath)) {
    throw new ArcAssetError(`缺少曲绘占位图 ${placeholderPath}。${MISSING_ASSETS_HINT}`);
  }

  const gameLogoPath = join(logosDir, 'arcaea.svg');
  const rankhubMarkPath = join(logosDir, 'rankhub.svg');

  return {
    assetsDir,
    coversDir,
    fontsDir,
    logosDir,
    index,
    fonts: listAvailableFonts(fontsDir),
    gameLogoUrl: existsSync(gameLogoPath) ? toFileUrl(gameLogoPath) : null,
    rankhubMarkUrl: existsSync(rankhubMarkPath) ? toFileUrl(rankhubMarkPath) : null,
    placeholderUrl: toFileUrl(placeholderPath),
  };
}

const COVER_FILE_PATTERN = /^[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)$/i;

/**
 * 解析一条成绩的曲绘：
 * 1. `coverFile`（显式指定，限制在 coversDir 内）；
 * 2. 曲绘索引里 `songId` 的文件名。
 *
 * 返回绝对路径；文件不存在返回 null（调用方用占位图，不抛异常）。
 */
/** 归一化曲名/曲 id 用于匹配：小写、去掉空白与标点（保留中日韩字符）。 */
export function normalizeSongKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s'`"!?.,:;()\[\]{}\-_/\\&+~@#$%^*=<>.|]/g, '');
}

/** 按曲名在索引里找条目（RankHub 的 `song_id` 可能是 uuid，与 Arcaea 官方字符串 id 不一致）。 */
export function lookupEntryByTitle(assets: ArcAssets, title: string): ArcCoverEntry | undefined {
  const target = normalizeSongKey(title);
  if (target === '') return undefined;
  for (const entry of Object.values(assets.index.songs)) {
    if (entry.title && normalizeSongKey(entry.title) === target) return entry;
  }
  return undefined;
}

export function resolveCoverFile(
  assets: ArcAssets,
  input: { songId: string; title?: string | null; coverFile?: string | null },
): string | null {
  const candidates: string[] = [];
  const explicit = input.coverFile?.trim();
  if (explicit && COVER_FILE_PATTERN.test(explicit)) candidates.push(explicit);
  const direct = assets.index.songs[input.songId] ?? assets.index.songs[normalizeSongKey(input.songId)];
  const entry = direct ?? (input.title ? lookupEntryByTitle(assets, input.title) : undefined);
  if (entry?.file && COVER_FILE_PATTERN.test(entry.file)) candidates.push(entry.file);
  for (const name of candidates) {
    const full = join(assets.coversDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/** 索引里的曲目信息（曲名/等级/定数兜底用）；没有则 undefined。 */
export function lookupSong(assets: ArcAssets, songId: string): ArcCoverEntry | undefined {
  return assets.index.songs[songId];
}

/** 素材概况，供日志与测试断言。 */
export function describeArcAssets(options: { assetsDir?: string } = {}): {
  assetsDir: string;
  songs: number;
  covers: number;
  fonts: number;
  hasGameLogo: boolean;
  hasRankhubMark: boolean;
} {
  const assets = loadArcAssets(options);
  const covers = existsSync(assets.coversDir)
    ? readdirSync(assets.coversDir).filter((name) => /\.(jpe?g|png|webp)$/i.test(name)).length
    : 0;
  return {
    assetsDir: assets.assetsDir,
    songs: Object.keys(assets.index.songs).length,
    covers,
    fonts: assets.fonts.length,
    hasGameLogo: assets.gameLogoUrl !== null,
    hasRankhubMark: assets.rankhubMarkUrl !== null,
  };
}

export { toFileUrl };
