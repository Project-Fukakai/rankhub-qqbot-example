/**
 * 名片静态素材：可选字体 + App 卡片固定素材。
 *
 * 与动态素材（头像/曲绘/立绘/二维码，由调用方以 `Buffer` 传入）不同，这里读的是
 * **离线**文件，由 `scripts/fetch-assets-card.mjs` 准备到 `vendor/card/**`：
 *
 * - `fonts/`：Saira 四档（App `pubspec.yaml` 的 `Saira` family，ASCII 展示字体）、
 *   Orbitron（maimai B35/B15 数字）、phi（phi-plugin 的 Saira×思源黑体混合字体，
 *   体量大，默认不内联）、Aldrich（旧版展示字体，仅作 Saira 缺失时的兜底）。
 * - `arcaea/`：`bg_light.png`、`hidden.png`、`banner.png`、`rating-0..7.png`。
 * - `phigros/`：课题模式段位底图 `green/blue/red/yellow/rainbow/white.png`。
 * - `maimai/rating/UI_CMN_DXRating_01..12.png`：DX Rating 徽章；
 *   `maimai/num/0..9.png`：徽章上的数字（App `assets/maimai/ra_num/*.png`）。
 * - `backgrounds/maimai.png`：App 默认背景板（frame 455203）。
 *
 * 所有素材都是**可选**的：缺失时渲染器回退系统字体 / 纯色底 / 文字数字，不抛错；
 * 调用方通过 `CardAssets.missing` 与渲染诊断知道缺了哪些。
 * 素材一律以 `data:` URL 内联进 HTML（页面由 `setContent` 注入，base URL 为 about:blank）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { REPO_ROOT, findBrowserExecutable, type BrowserLaunchTarget } from '../phi/assets.js';
import { imageMimeType, toDataUrl } from './html.js';

/** 名片素材根目录（由 `scripts/fetch-assets-card.mjs` 准备，可缺省）。 */
export const DEFAULT_CARD_ASSETS_DIR = join(REPO_ROOT, 'vendor', 'card');
export const DEFAULT_CARD_FONTS_DIR = join(DEFAULT_CARD_ASSETS_DIR, 'fonts');
export const DEFAULT_CARD_BACKGROUNDS_DIR = join(DEFAULT_CARD_ASSETS_DIR, 'backgrounds');
/** phi-plugin 字体目录（phi / Aldrich 的离线来源）。 */
export const PHI_FONT_DIR = join(
  REPO_ROOT,
  'vendor',
  'phi',
  'resources',
  'html',
  'common',
  'font',
);
/** arcaea B50 海报素材目录（Saira 的离线兜底来源，通常已由 assets:arc 准备）。 */
const ARC_FONT_DIR = join(REPO_ROOT, 'vendor', 'arc', 'fonts');

export const SAIRA_FAMILY = 'Saira';
export const ORBITRON_FAMILY = 'Orbitron';
export const PHI_FAMILY = 'phi';
/** 旧版展示字体：Saira 缺失时的兜底（不是 App 字体，仅保证数字不至于太丑）。 */
export const LEGACY_DISPLAY_FAMILY = 'RankHub Display';

/** 字体 MIME / format 映射。 */
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

/** TrueType / OpenType 文件头校验（0x00010000 / 'true' / 'OTTO' / 'ttcf'）。 */
function looksLikeFont(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (buffer.readUInt32BE(0) === 0x00010000) return true;
  const tag = buffer.toString('ascii', 0, 4);
  return tag === 'true' || tag === 'OTTO' || tag === 'ttcf';
}

export interface CardFontFace {
  family: string;
  /** CSS font-weight；可变字体用 `100 900` 这样的区间。 */
  weight: string;
  /** 字体文件绝对路径。 */
  path: string;
  dataUrl: string;
  bytes: number;
}

interface FontSpec {
  family: string;
  weight: string;
  files: string[];
  /** 候选目录（按顺序尝试；第一个通常是 `<assetsDir>/fonts`）。 */
  fallbackDirs: string[];
}

const FONT_SPECS: FontSpec[] = [
  { family: SAIRA_FAMILY, weight: '400', files: ['Saira-Regular.ttf'], fallbackDirs: [ARC_FONT_DIR] },
  { family: SAIRA_FAMILY, weight: '500', files: ['Saira-Medium.ttf'], fallbackDirs: [ARC_FONT_DIR] },
  {
    family: SAIRA_FAMILY,
    weight: '600',
    files: ['Saira-SemiBold.ttf'],
    fallbackDirs: [ARC_FONT_DIR],
  },
  { family: SAIRA_FAMILY, weight: '700', files: ['Saira-Bold.ttf'], fallbackDirs: [ARC_FONT_DIR] },
  {
    family: SAIRA_FAMILY,
    weight: '100 900',
    files: ['Saira-VariableFont_wght.ttf'],
    fallbackDirs: [],
  },
  {
    family: ORBITRON_FAMILY,
    weight: '100 900',
    files: ['Orbitron-VariableFont_wght.ttf', 'Orbitron-Regular.ttf'],
    fallbackDirs: [],
  },
  { family: PHI_FAMILY, weight: '400', files: ['phi.ttf'], fallbackDirs: [PHI_FONT_DIR] },
  {
    family: LEGACY_DISPLAY_FAMILY,
    weight: '400',
    files: ['Aldrich-Regular.ttf'],
    fallbackDirs: [PHI_FONT_DIR],
  },
];

function readFontFace(path: string, family: string, weight: string): CardFontFace | null {
  try {
    const bytes = readFileSync(path);
    if (!looksLikeFont(bytes)) return null;
    return {
      family,
      weight,
      path: resolve(path),
      dataUrl: `data:${fontMimeType(path)};base64,${bytes.toString('base64')}`,
      bytes: bytes.length,
    };
  } catch {
    return null;
  }
}

/** 包一层 mtime 签名缓存：重新抓素材后同一进程也能看到新文件。 */
function fileSignature(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const info = statSync(path);
        return `${path}:${info.size}:${info.mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join('|');
}

let fontCache: { key: string; faces: CardFontFace[] } | null = null;

/** 加载字体 face（按解析到的文件签名缓存）；没有任何字体时返回空数组。 */
export function loadCardFonts(assetsDir: string = DEFAULT_CARD_ASSETS_DIR): CardFontFace[] {
  const fontsDir = join(assetsDir, 'fonts');
  const resolved: { path: string; family: string; weight: string }[] = [];
  for (const spec of FONT_SPECS) {
    const dirs = [fontsDir, ...spec.fallbackDirs];
    let found: string | null = null;
    for (const dir of dirs) {
      for (const file of spec.files) {
        const candidate = join(dir, file);
        if (existsSync(candidate)) {
          found = candidate;
          break;
        }
      }
      if (found !== null) break;
    }
    if (found !== null) resolved.push({ path: found, family: spec.family, weight: spec.weight });
  }
  const key = fileSignature(resolved.map((item) => item.path));
  if (fontCache && fontCache.key === key) return fontCache.faces;

  const faces: CardFontFace[] = [];
  for (const item of resolved) {
    const face = readFontFace(item.path, item.family, item.weight);
    if (face !== null) faces.push(face);
  }
  fontCache = { key, faces };
  return faces;
}

/** 生成 `@font-face` 片段（一个 family 可以有多个 weight）；没有字体时返回空串。 */
export function fontFaceCss(faces: CardFontFace[]): string {
  if (faces.length === 0) return '';
  return faces
    .map(
      (face) => `@font-face {
  font-family: '${face.family}';
  src: url(${face.dataUrl}) format('${fontFormat(face.path)}');
  font-weight: ${face.weight};
  font-style: normal;
  font-display: block;
}
`,
    )
    .join('');
}

/** 字体 family 列表（去重，顺序稳定；用于 CSS 栈与诊断）。 */
export function fontFamilies(faces: CardFontFace[]): string[] {
  const seen = new Set<string>();
  const families: string[] = [];
  for (const face of faces) {
    if (seen.has(face.family)) continue;
    seen.add(face.family);
    families.push(face.family);
  }
  return families;
}

// ─────────────────────────────── 固定图片素材 ───────────────────────────────

export interface CardImageKey {
  /** 诊断用的稳定 key（如 `arcaea:banner`）。 */
  key: string;
  /** 候选相对路径（按顺序尝试）。 */
  paths: string[];
}

/** phigros 课题模式段位等级 → 底图（App `phigrosChallengeBadgeAsset`）。 */
export const PHIGROS_BADGE_FILES: Record<number, string> = {
  1: 'green.png',
  2: 'blue.png',
  3: 'red.png',
  4: 'yellow.png',
  5: 'rainbow.png',
};

/** 名片会用到 / 尝试使用的全部固定图片（缺失只计数，不报错）。 */
export const CARD_IMAGE_KEYS: CardImageKey[] = [
  { key: 'bg:maimai', paths: [join('backgrounds', 'maimai.png')] },
  {
    key: 'arcaea:bg',
    paths: [join('arcaea', 'bg_light.png'), join('backgrounds', 'arcaea.png')],
  },
  { key: 'arcaea:hidden', paths: [join('arcaea', 'hidden.png')] },
  { key: 'arcaea:banner', paths: [join('arcaea', 'banner.png')] },
  ...Array.from({ length: 8 }, (_, index) => ({
    key: `arcaea:rating:${index}`,
    paths: [join('arcaea', `rating-${index}.png`)],
  })),
  ...[1, 2, 3, 4, 5].map((level) => ({
    key: `phigros:badge:${level}`,
    paths: [join('phigros', PHIGROS_BADGE_FILES[level] ?? 'white.png')],
  })),
  { key: 'phigros:badge:white', paths: [join('phigros', 'white.png')] },
  ...Array.from({ length: 12 }, (_, index) => {
    const assetIndex = index + 1;
    const padded = String(assetIndex).padStart(2, '0');
    return {
      key: `maimai:rating:${assetIndex}`,
      paths: [
        join('maimai', 'rating', `UI_CMN_DXRating_${padded}.png`),
        join('maimai', 'rating', `${padded}.png`),
      ],
    };
  }),
  ...Array.from({ length: 10 }, (_, digit) => ({
    key: `maimai:num:${digit}`,
    paths: [join('maimai', 'num', `${digit}.png`)],
  })),
];

/** PNG / JPEG 文件头校验，避免把残缺文件当素材内联。 */
function imageBytesValid(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const mime = imageMimeType(buffer);
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

export interface CardAssets {
  fonts: CardFontFace[];
  families: string[];
  /** key → data URL（只含真实存在的素材）。 */
  images: Record<string, string>;
  /** 尝试过但不存在的 key（稳定排序）。 */
  missing: string[];
}

/** 读取全部固定图片（按目录签名缓存）。 */
export function loadCardImages(
  assetsDir: string = DEFAULT_CARD_ASSETS_DIR,
): { images: Record<string, string>; missing: string[] } {
  const resolved: { key: string; path: string | null }[] = CARD_IMAGE_KEYS.map((item) => {
    for (const relative of item.paths) {
      const candidate = join(assetsDir, relative);
      if (existsSync(candidate)) return { key: item.key, path: candidate };
    }
    return { key: item.key, path: null };
  });
  const key = fileSignature(
    resolved.flatMap((item) => (item.path === null ? [] : [item.path])),
  ) + resolved.map((item) => item.key).join(',');
  if (imageCache && imageCache.key === key) {
    return { images: imageCache.images, missing: imageCache.missing };
  }

  const images: Record<string, string> = {};
  const missing: string[] = [];
  for (const item of resolved) {
    if (item.path === null) {
      missing.push(item.key);
      continue;
    }
    try {
      const bytes = readFileSync(item.path);
      if (!imageBytesValid(bytes)) {
        missing.push(item.key);
        continue;
      }
      images[item.key] = toDataUrl(bytes) as string;
    } catch {
      missing.push(item.key);
    }
  }
  imageCache = { key, images, missing };
  return { images, missing };
}

let imageCache: { key: string; images: Record<string, string>; missing: string[] } | null = null;

/** 一次加载渲染所需全部素材（字体 + 固定图片）。 */
export function loadCardAssets(assetsDir: string = DEFAULT_CARD_ASSETS_DIR): CardAssets {
  const fonts = loadCardFonts(assetsDir);
  const { images, missing } = loadCardImages(assetsDir);
  return { fonts, families: fontFamilies(fonts), images, missing };
}

/** 兼容旧 API：展示字体（Saira）是否可用。 */
export function hasDisplayFont(assetsDir?: string): boolean {
  return loadCardFonts(assetsDir).some((face) => face.family === SAIRA_FAMILY);
}

export { REPO_ROOT, findBrowserExecutable, type BrowserLaunchTarget };
