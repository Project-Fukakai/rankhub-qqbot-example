/**
 * 名片渲染的素材解析：
 * 1. Chromium 可执行文件（复用 `src/render/phi` 的探测逻辑，避免两套查找规则漂移）；
 * 2. 可选的数字展示字体（`vendor/card/fonts`，缺失时回退 phi-plugin 自带的 Aldrich）；
 * 3. 可选的 **App 默认卡片背景**（`vendor/card/backgrounds/<game>.<ext>`）：
 *    - maimai：App `player_info_card.dart:47` 的默认背景板（`getFrameUrl(455203)`）；
 *    - arcaea：App 内置的 `assets/arcaea/bg_light.png`；
 *    - phigros：App 没有默认背景（未选曲绘时用 grey900），所以不提供素材，走纯色兜底。
 *    这些文件由 `scripts/fetch-assets-card.mjs` 准备；调用方显式传了 `background` 时优先用调用方的图。
 *
 * 所有素材都以 `data:` URL 内联进 HTML，原因与图片一致：页面由 `setContent` 注入、
 * base URL 是 `about:blank`，任何相对路径/file:// 资源都不可靠，而 `data:` 不触网。
 * 素材缺失不是错误：字体回退系统字体，背景回退 App 的纯色 surface。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { REPO_ROOT, findBrowserExecutable, type BrowserLaunchTarget } from '../phi/assets.js';
import { toDataUrl } from './html.js';

/** 名片专用素材目录（由 `scripts/fetch-assets-card.mjs` 准备，可缺省）。 */
export const DEFAULT_CARD_FONTS_DIR = join(REPO_ROOT, 'vendor', 'card', 'fonts');
/** App 默认卡片背景目录（`<game>.png|jpg|jpeg|webp`，可缺省）。 */
export const DEFAULT_CARD_BACKGROUNDS_DIR = join(REPO_ROOT, 'vendor', 'card', 'backgrounds');
/** phi-plugin 字体目录（字体可选来源，仓库里通常已通过 fetch-assets-phi 准备好）。 */
export const PHI_FONT_DIR = join(
  REPO_ROOT,
  'vendor',
  'phi',
  'resources',
  'html',
  'common',
  'font',
);
/** 内联字体的 family 名（CSS 变量 --display 使用）。 */
export const DISPLAY_FONT_FAMILY = 'RankHub Display';

/** 按优先级尝试的展示字体文件名（数字/字母用的几何无衬线体）。 */
const DISPLAY_FONT_FILES = ['Aldrich-Regular.ttf', 'Aldrich-Regular.otf', 'Aldrich-Regular.woff2'];
const BACKGROUND_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export interface DisplayFontAsset {
  /** 字体文件绝对路径。 */
  path: string;
  family: string;
  /** 直接可用的 `data:` URL。 */
  dataUrl: string;
  bytes: number;
}

/** 字体 MIME：Chromium 也接受 font/ttf，但用标准类型更稳。 */
function fontMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.otf')) return 'font/otf';
  return 'font/ttf';
}

function fontFormat(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.woff2')) return 'woff2';
  if (lower.endsWith('.woff')) return 'woff';
  if (lower.endsWith('.otf')) return 'opentype';
  return 'truetype';
}

/**
 * 定位展示字体文件：
 * 1. `fontsDir`（默认 `vendor/card/fonts`）里的 Aldrich；
 * 2. phi-plugin 字体目录里的 Aldrich（离线可用，不额外下载）。
 */
export function findDisplayFontFile(fontsDir?: string): string | null {
  const dirs = [fontsDir ?? DEFAULT_CARD_FONTS_DIR, PHI_FONT_DIR];
  for (const dir of dirs) {
    for (const name of DISPLAY_FONT_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  return null;
}

let fontCache: { path: string; mtimeMs: number; asset: DisplayFontAsset } | null = null;

/** 读取字体（按 mtime 缓存），没有字体返回 null。 */
export function loadDisplayFont(fontsDir?: string): DisplayFontAsset | null {
  const path = findDisplayFontFile(fontsDir);
  if (!path) return null;
  const mtimeMs = statSync(path).mtimeMs;
  if (fontCache && fontCache.path === path && fontCache.mtimeMs === mtimeMs) return fontCache.asset;
  const bytes = readFileSync(path);
  const asset: DisplayFontAsset = {
    path,
    family: DISPLAY_FONT_FAMILY,
    dataUrl: `data:${fontMimeType(path)};base64,${bytes.toString('base64')}`,
    bytes: bytes.length,
  };
  fontCache = { path, mtimeMs, asset };
  return asset;
}

/** 生成 `@font-face` 片段；没有字体时返回空串。 */
export function displayFontFaceCss(font: DisplayFontAsset | null): string {
  if (!font) return '';
  return `@font-face {
  font-family: '${font.family}';
  src: url(${font.dataUrl}) format('${fontFormat(font.path)}');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
`;
}

/**
 * 找某个游戏的默认背景文件：`vendor/card/backgrounds/<game>.<ext>`（game 只允许安全字符，防路径穿越）。
 */
export function findDefaultBackgroundFile(
  game: string,
  dir: string = DEFAULT_CARD_BACKGROUNDS_DIR,
): string | null {
  const key = game.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(key)) return null;
  for (const extension of BACKGROUND_EXTENSIONS) {
    const candidate = join(dir, `${key}${extension}`);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

let backgroundCache: { dir: string; signature: string; data: Record<string, string> } | null = null;

/**
 * 读取全部默认背景（game → data URL），按目录 mtime 缓存，便于重新抓素材后无需重启进程。
 *
 * 目录不存在时返回空对象（渲染器继续用纯色兜底），不是错误。
 */
export function loadDefaultBackgrounds(
  dir: string = DEFAULT_CARD_BACKGROUNDS_DIR,
): Record<string, string> {
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir)
    .filter((file) => BACKGROUND_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension)))
    .sort();
  const signature = files
    .map((file) => `${file}:${statSync(join(dir, file)).mtimeMs}`)
    .join('|');
  if (backgroundCache && backgroundCache.dir === dir && backgroundCache.signature === signature) {
    return backgroundCache.data;
  }

  const data: Record<string, string> = {};
  for (const file of files) {
    const game = file.replace(/\.(png|jpe?g|webp)$/i, '').toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(game)) continue;
    const dataUrl = toDataUrl(readFileSync(join(dir, file)));
    if (dataUrl) data[game] = dataUrl;
  }
  backgroundCache = { dir, signature, data };
  return data;
}

export { REPO_ROOT, findBrowserExecutable, type BrowserLaunchTarget };
