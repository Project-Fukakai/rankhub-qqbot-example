#!/usr/bin/env node
/**
 * 拉取 phigros `/rks` 渲染所需素材（幂等，可重复执行）。
 *
 * 1) phi-plugin（固定 commit）稀疏检出：
 *      resources/html/b19、common、otherimg、avatar + LICENSE
 *    → vendor/phi/resources/html/...、vendor/phi/LICENSE
 *    做法：git init + fetch --depth 1 --filter=blob:none + sparse-checkout set，
 *    只下载白名单目录的 blob（整仓 642MB，白名单约 52MB）。
 * 2) 曲库 + 曲绘：
 *      https://static.rankhub.cc/phigros/info/songs.json
 *      https://static.rankhub.cc/phigros/asset/Assets/Tracks/<id>/IllustrationLowRes.jpg.jpg
 *    → vendor/covers/phigros/<sha1(songId)>.jpg + index.json
 *
 * 用法：node scripts/fetch-assets-phi.mjs [--force] [--skip-covers] [--skip-phi]
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHI_DIR = join(ROOT, 'vendor', 'phi');
const PHI_HTML = join(PHI_DIR, 'resources', 'html');
const COVER_DIR = join(ROOT, 'vendor', 'covers', 'phigros');

const PHI_PLUGIN_REPO = 'https://github.com/Catrong/phi-plugin.git';
/** 固定 commit：模板 / CSS / 图标均为该版本快照。 */
const PHI_PLUGIN_COMMIT = '6bb6fad1db8702d2c8d470930c31538581d16a31';
const PHI_SPARSE_PATHS = [
  'resources/html/b19',
  'resources/html/common',
  'resources/html/otherimg',
  'resources/html/avatar',
  'LICENSE',
];

const SONGS_URL = 'https://static.rankhub.cc/phigros/info/songs.json';
const COVER_URL = (id) =>
  `https://static.rankhub.cc/phigros/asset/Assets/Tracks/${encodeURIComponent(id)}/IllustrationLowRes.jpg.jpg`;

const CACHE_VERSION = 1;
const COVER_CONCURRENCY = 4;
const COVER_RETRIES = 3;

/**
 * 曲绘占位图：512x512 深灰底 + 「曲绘缺失」字样。
 * 用 @napi-rs/canvas（项目已有依赖）生成，避免模板里出现被拉伸的 1x1 像素。
 */
async function buildPlaceholderJpeg() {
  const { createCanvas } = await import('@napi-rs/canvas');
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#1b1f2a');
  gradient.addColorStop(1, '#2c3444');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, size - 24, size - 24);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('曲绘缺失', size / 2, size / 2 - 18);
  ctx.font = '20px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('NO ILLUSTRATION', size / 2, size / 2 + 34);
  return canvas.toBuffer('image/jpeg', 90);
}

/** canvas 不可用时的兜底：1x1 灰色 JPEG，保证模板 <img> 永远可解码。 */
const PLACEHOLDER_JPEG_FALLBACK = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

const log = (...args) => console.log('[fetch-assets-phi]', ...args);

function parseArgs(argv) {
  const flags = { force: false, skipCovers: false, skipPhi: false };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') flags.force = true;
    else if (arg === '--skip-covers') flags.skipCovers = true;
    else if (arg === '--skip-phi') flags.skipPhi = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/fetch-assets-phi.mjs [--force] [--skip-covers] [--skip-phi]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return flags;
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 用 git 稀疏检出 phi-plugin 固定 commit 到临时目录，再只拷出白名单内容。 */
async function fetchPhiPlugin() {
  const marker = join(PHI_DIR, '.phi-plugin-commit');
  const b19Art = join(PHI_HTML, 'b19', 'b19.art');
  if (!FLAGS.force && (await fileExists(b19Art)) && (await fileExists(marker))) {
    log('phi-plugin 素材已存在，跳过（--force 可强制重取）');
    return;
  }

  const work = await mkdtemp(join(tmpdir(), 'phi-plugin-'));
  log(`稀疏检出色 ${PHI_PLUGIN_COMMIT.slice(0, 12)} → ${work}`);
  const git = async (args) => {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: work,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (stderr.trim()) log(`git ${args[0]}: ${stderr.trim().split('\n').at(-1)}`);
    return stdout;
  };

  try {
    await git(['init', '--quiet']);
    await git(['remote', 'add', 'origin', PHI_PLUGIN_REPO]);
    await git(['sparse-checkout', 'init', '--cone']);
    await git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', PHI_PLUGIN_COMMIT]);
    await git(['sparse-checkout', 'set', ...PHI_SPARSE_PATHS]);
    await git(['checkout', '--quiet', 'FETCH_HEAD']);

    await mkdir(PHI_HTML, { recursive: true });
    for (const name of ['b19', 'common', 'otherimg', 'avatar']) {
      const src = join(work, 'resources', 'html', name);
      if (!(await dirExists(src))) throw new Error(`稀疏检出缺少目录: ${src}`);
      const dest = join(PHI_HTML, name);
      await rm(dest, { recursive: true, force: true });
      await execFileAsync('cp', ['-R', src, dest]);
    }
    await copyFile(join(work, 'LICENSE'), join(PHI_DIR, 'LICENSE'));
    await writeFile(
      marker,
      `${JSON.stringify(
        { repo: PHI_PLUGIN_REPO, commit: PHI_PLUGIN_COMMIT, sparse: PHI_SPARSE_PATHS },
        null,
        2,
      )}\n`,
    );
    log('phi-plugin 素材就位:', PHI_HTML);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function fetchBuffer(url, { timeoutMs = 20000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function withRetry(label, fn, retries = COVER_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }
  throw new Error(`${label} 失败（${retries} 次）: ${lastErr?.message ?? lastErr}`);
}

/** 并发池：限制同时在跑的任务数。 */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const results = [];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      results.push(await worker(next));
    }
  });
  await Promise.all(runners);
  return results;
}

function coverName(songId) {
  return `${createHash('sha1').update(songId).digest('hex')}.jpg`;
}

function levelsOf(song) {
  const out = {};
  const levels = song?.levels ?? {};
  for (const key of ['EZ', 'HD', 'IN', 'AT', 'Legacy']) {
    const value = levels[key];
    if (value && typeof value.difficulty === 'number') out[key] = value.difficulty;
  }
  return out;
}

async function fetchCovers() {
  const indexPath = join(COVER_DIR, 'index.json');
  const placeholderPath = join(COVER_DIR, 'placeholder.jpg');
  await mkdir(COVER_DIR, { recursive: true });
  if (!(await fileExists(placeholderPath)) || FLAGS.force) {
    let placeholder;
    try {
      placeholder = await buildPlaceholderJpeg();
    } catch (err) {
      log(`占位图 canvas 生成失败，退回 1x1：${err?.message ?? err}`);
      placeholder = PLACEHOLDER_JPEG_FALLBACK;
    }
    await writeFile(placeholderPath, placeholder);
  }

  log('拉取曲库', SONGS_URL);
  const songs = JSON.parse((await withRetry('曲库', () => fetchBuffer(SONGS_URL), 3)).toString('utf8'));
  if (!Array.isArray(songs)) throw new Error('songs.json 不是数组');
  log(`曲库 ${songs.length} 首`);

  /** @type {Record<string, {file: string|null, ok: boolean, name?: string, levels?: Record<string,number>}>} */
  const index = {};
  const tasks = [];
  let reused = 0;

  for (const song of songs) {
    const id = song?.id;
    if (typeof id !== 'string' || !id) continue;
    const file = coverName(id);
    const target = join(COVER_DIR, file);
    const existed = await fileExists(target);
    if (existed && !FLAGS.force) reused += 1;
    index[id] = { file: existed ? file : null, ok: existed, name: song.name, levels: levelsOf(song) };
    if (!existed || FLAGS.force) tasks.push({ id, file, target, song });
  }

  log(`曲绘：已存在 ${reused}，待下载 ${tasks.length}`);
  let downloaded = 0;
  let failed = 0;
  const failures = [];

  await runPool(tasks, COVER_CONCURRENCY, async ({ id, file, target, song }) => {
    try {
      const bytes = await withRetry(`曲绘 ${id}`, () => fetchBuffer(COVER_URL(id)), COVER_RETRIES);
      if (bytes.length < 128) throw new Error(`响应过小 ${bytes.length}B`);
      await writeFile(target, bytes);
      index[id] = { file, ok: true, name: song.name, levels: levelsOf(song) };
      downloaded += 1;
      if (downloaded % 25 === 0) log(`  已下载 ${downloaded}/${tasks.length}`);
    } catch (err) {
      failed += 1;
      failures.push({ id, error: String(err?.message ?? err) });
      index[id] = { file: null, ok: false, name: song?.name, levels: levelsOf(song) };
    }
  });

  const payload = {
    version: CACHE_VERSION,
    source: { songs: SONGS_URL, cover: 'https://static.rankhub.cc/phigros/asset/Assets/Tracks/<id>/IllustrationLowRes.jpg.jpg' },
    phiPluginCommit: PHI_PLUGIN_COMMIT,
    fetchedAt: new Date().toISOString(),
    placeholder: 'placeholder.jpg',
    songs: index,
  };
  await writeFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`);
  log(`曲绘完成：新增 ${downloaded}、复用 ${reused}、失败 ${failed}，index → ${indexPath}`);
  if (failures.length) {
    log(`失败样例：${failures.slice(0, 5).map((f) => f.id).join(', ')}`);
  }
  return payload;
}

const FLAGS = parseArgs(process.argv.slice(2));

async function main() {
  await mkdir(PHI_DIR, { recursive: true });
  if (!FLAGS.skipPhi) await fetchPhiPlugin();
  if (!FLAGS.skipCovers) await fetchCovers();
  log('完成');
}

main().catch((err) => {
  console.error('[fetch-assets-phi] 失败:', err);
  process.exitCode = 1;
});
