/**
 * phi-plugin b19 素材解析：模板、字体/图标目录、曲绘缓存、头像、Chromium 可执行文件。
 *
 * 素材由 `scripts/fetch-assets-phi.mjs` 生成到 `vendor/phi`（模板/字体/图标）与
 * `vendor/covers/phigros`（曲绘 + index.json），默认被 `.gitignore` 忽略。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** src/render/phi → 仓库根。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_PHI_RESOURCES_DIR = join(REPO_ROOT, 'vendor', 'phi', 'resources');
export const DEFAULT_COVERS_DIR = join(REPO_ROOT, 'vendor', 'covers', 'phigros');

/** phi-plugin 固定 commit（与 fetch 脚本保持一致，仅用于展示/追溯）。 */
export const PHI_PLUGIN_COMMIT = '6bb6fad1db8702d2c8d470930c31538581d16a31';
/** 上游插件版本（README 的 `插件版本-x.y.z`），用于模板底部 createdbox。 */
export const PHI_PLUGIN_VERSION = 'v1.0.3';
export const PHI_PLUGIN_DISPLAY_NAME = 'Phi-Plugin';

export interface PhiLevels {
  [level: string]: number;
}

export interface PhiSongEntry {
  /** 曲绘文件名（相对 coversDir）；下载失败为 null。 */
  file: string | null;
  ok: boolean;
  name?: string;
  levels?: PhiLevels;
}

export interface PhiSongsIndex {
  version: number;
  placeholder: string;
  songs: Record<string, PhiSongEntry>;
}

export interface PhiAssets {
  /** `.../vendor/phi/resources`（内含 html/）。 */
  resourcesDir: string;
  /** `.../vendor/covers/phigros`。 */
  coversDir: string;
  /** b19 模板绝对路径。 */
  b19Template: string;
  /**
   * 供模板 `{{_res_path}}` 使用的 `file://` 资源前缀（以 / 结尾）。
   * 模板里都写成 `{{_res_path}}html/...`，所以这里指向 resources 根目录而不是 html/。
   */
  resUrlPrefix: string;
  /** 默认布局模板绝对路径（`{{extend defaultLayout}}` 用）。 */
  defaultLayout: string;
  songs: PhiSongsIndex;
  /** 头像文件名（不含 .png）。 */
  avatar: string;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 解析 phi-plugin 资源目录：
 * 1. 显式参数（测试注入）；
 * 2. `PHI_PLUGIN_RES`（兼容指向 resources 或其父目录两种写法）；
 * 3. `vendor/phi/resources`。
 */
export function resolveResourcesDir(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const env = process.env.PHI_PLUGIN_RES?.trim();
  if (env) {
    candidates.push(env, join(env, 'resources'));
  }
  candidates.push(DEFAULT_PHI_RESOURCES_DIR);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'html', 'b19', 'b19.art'))) return resolve(candidate);
  }
  throw new Error(
    '未找到 phi-plugin b19 模板：请先运行 `node scripts/fetch-assets-phi.mjs`' +
      '（或通过 PHI_PLUGIN_RES 指向 phi-plugin 的 resources 目录）',
  );
}

export function resolveCoversDir(explicit?: string): string {
  const dir = explicit ?? process.env.PHI_COVERS_DIR?.trim() ?? DEFAULT_COVERS_DIR;
  if (!existsSync(join(dir, 'index.json'))) {
    throw new Error(
      `未找到曲绘索引 ${join(dir, 'index.json')}：请先运行 \`node scripts/fetch-assets-phi.mjs\``,
    );
  }
  return resolve(dir);
}

/** 读取曲绘索引；按 mtime 失效缓存，便于重新拉素材后无需重启进程。 */
const indexCache = new Map<string, { mtimeMs: number; index: PhiSongsIndex }>();

export function loadSongsIndex(coversDir: string): PhiSongsIndex {
  const indexPath = join(coversDir, 'index.json');
  const mtimeMs = statSync(indexPath).mtimeMs;
  const cached = indexCache.get(indexPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.index;
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as PhiSongsIndex;
  if (!index || typeof index !== 'object' || typeof index.songs !== 'object') {
    throw new Error(`曲绘索引格式异常: ${indexPath}`);
  }
  indexCache.set(indexPath, { mtimeMs, index });
  return index;
}

/** 从 `avatar/` 里挑一个固定默认头像，优先 phi-plugin 默认的 `-SURREALISM-`。 */
export function pickDefaultAvatar(resourcesDir: string): string {
  const avatarDir = join(resourcesDir, 'html', 'avatar');
  const preferred = '-SURREALISM-';
  if (existsSync(join(avatarDir, `${preferred}.png`))) return preferred;
  const files = existsSync(avatarDir)
    ? readdirSync(avatarDir)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`phi-plugin 头像目录为空: ${avatarDir}`);
  return files[0]!.replace(/\.png$/i, '');
}

export function loadAssets(options: { resourcesDir?: string; coversDir?: string } = {}): PhiAssets {
  const resourcesDir = resolveResourcesDir(options.resourcesDir);
  const coversDir = resolveCoversDir(options.coversDir);
  const b19Template = join(resourcesDir, 'html', 'b19', 'b19.art');
  if (!existsSync(b19Template)) throw new Error(`未找到 b19 模板: ${b19Template}`);
  return {
    resourcesDir,
    coversDir,
    b19Template,
    resUrlPrefix: `${pathToFileURL(resourcesDir).href}/`,
    defaultLayout: join(resourcesDir, 'html', 'common', 'layout', 'default.art'),
    songs: loadSongsIndex(coversDir),
    avatar: pickDefaultAvatar(resourcesDir),
  };
}

/** `vendor/covers/...` 下的曲绘绝对路径；不存在返回 null。 */
export function resolveCoverFile(coversDir: string, entry: PhiSongEntry | undefined): string | null {
  if (!entry?.file) return null;
  const file = join(coversDir, entry.file);
  return existsSync(file) ? file : null;
}

export function placeholderCoverPath(coversDir: string, index: PhiSongsIndex): string {
  const name = index.placeholder || 'placeholder.jpg';
  const file = join(coversDir, name);
  if (!existsSync(file)) {
    throw new Error(`缺少曲绘占位图 ${file}：请重新运行 \`node scripts/fetch-assets-phi.mjs\``);
  }
  return file;
}

export interface BrowserLaunchTarget {
  executablePath: string;
  /** 供日志/测试断言使用的来源说明。 */
  source: 'env' | 'playwright-cache' | 'path';
}

function buildNumber(name: string): number {
  const match = /-(\d+)$/.exec(name);
  return match ? Number(match[1]) : 0;
}

/**
 * 找到本机 Chromium：
 * 1. `RENDER_BROWSER_PATH`；
 * 2. `~/Library/Caches/ms-playwright/chromium_headless_shell-<build>/...`（取 build 最大）；
 * 3. `~/Library/Caches/ms-playwright/chromium-<build>/...`；
 * 4. PATH 里的 chrome-headless-shell / chromium / google-chrome。
 */
export function findBrowserExecutable(explicit?: string): BrowserLaunchTarget {
  const env = explicit ?? process.env.RENDER_BROWSER_PATH?.trim();
  if (env) {
    if (!existsSync(env)) throw new Error(`RENDER_BROWSER_PATH 指向的文件不存在: ${env}`);
    return { executablePath: env, source: 'env' };
  }

  const cacheDir = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cacheDir)) {
    const entries = readdirSync(cacheDir).sort((a, b) => buildNumber(b) - buildNumber(a));
    const headless = entries.filter((name) => name.startsWith('chromium_headless_shell-'));
    for (const name of headless) {
      const dir = join(cacheDir, name);
      // chrome-headless-shell-mac-arm64 / -mac-x64 / -linux64 ...
      const subdirs = readdirSync(dir).filter((sub) => sub.startsWith('chrome-headless-shell'));
      for (const sub of subdirs) {
        const candidate = join(dir, sub, 'chrome-headless-shell');
        if (existsSync(candidate)) return { executablePath: candidate, source: 'playwright-cache' };
      }
    }
    const full = entries.filter((name) => name.startsWith('chromium-'));
    for (const name of full) {
      const dir = join(cacheDir, name);
      for (const candidate of [
        join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(dir, 'chrome-linux', 'chrome'),
      ]) {
        if (existsSync(candidate)) return { executablePath: candidate, source: 'playwright-cache' };
      }
    }
  }

  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const bin of ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome']) {
    for (const dir of pathDirs) {
      const candidate = join(dir, bin);
      if (existsSync(candidate)) return { executablePath: candidate, source: 'path' };
    }
  }
  throw new Error(
    '未找到可用 Chromium：请设置 RENDER_BROWSER_PATH，或安装 playwright 的 chromium 缓存' +
      '（~/Library/Caches/ms-playwright/chromium_headless_shell-*）',
  );
}
