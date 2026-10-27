#!/usr/bin/env node
/**
 * maimaiDX 静态资源准备脚本（b50 渲染所需最小集）。
 *
 * 数据来源（固定版本，勿随意升级）：
 *   - 资源包 Resource CN1.55（约 467MB）+ Resource CN1.56 UPDATE（约 22KB），
 *     由 maimaiDX 上游发布页提供：https://cloud.yuzuchan.moe/f/34s7/... 、 /f/Jvhl/...
 *   - 曲目 notes/定数缓存：https://maimai.lxns.net/api/v0/maimai/song/list?notes=true
 *
 * 行为：
 *   1. 若 env MAIMAIDX_STATIC 指向一个「已经解压好的 maimaiDX static 目录」
 *      （即包含 mai/pic、mai/cover、font/ 的目录），直接复用，跳过下载与解压。
 *   2. 否则把 7z 下载到缓存目录（默认 /tmp/mai-res），用 .venv-ref 的 py7zr 解压。
 *   3. 裁剪出 b50 渲染真正需要的文件到 vendor/mai：
 *        vendor/mai/pic/         UI_* / b50_score_* / SD.png / DX.png / Name.png / logo.png
 *                                + prism_plus/ + circle/ 两个主题目录
 *        vendor/mai/cover/       全部曲绘（<songId % 10000>.png，缺图回落 0.png）
 *        vendor/mai/plate/       0.png（默认名牌，等价于 pic/UI_Plate_550101.png）
 *        vendor/mai/shougou/     称号条底图（5 张）
 *        vendor/mai/font/        ResourceHanRoundedCN-Bold / Torus SemiBold /
 *                                FOT-NewRodin Pro EB / ShangguMonoSC-Regular
 *   4. 校验关键文件存在；缺失则非 0 退出。
 *
 * 幂等：已存在的产物直接跳过；--force 重新裁剪；--refresh-data 重新拉曲目数据。
 *
 * 用法：
 *   node scripts/fetch-assets-mai.mjs
 *   MAIMAIDX_STATIC=/path/to/static node scripts/fetch-assets-mai.mjs
 *   node scripts/fetch-assets-mai.mjs --force --refresh-data
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_MAI = join(ROOT, 'vendor', 'mai');
const VENV_REF = join(ROOT, '.venv-ref');
const PYTHON = join(VENV_REF, 'bin', 'python');

const CACHE_DIR = process.env.MAI_ASSET_CACHE
  ? resolve(process.env.MAI_ASSET_CACHE)
  : '/tmp/mai-res';

/** 固定资源包（上游 maimaiDX 发布页的 1.55 全量 + 1.56 UPDATE 覆盖层）。 */
const ARCHIVES = [
  {
    name: 'Resource CN1.55.7z',
    url: 'https://cloud.yuzuchan.moe/f/34s7/Resource%20CN1.55.7z',
    bytes: 467150820,
    extractDir: 'Resource CN1.55',
  },
  {
    name: 'Resource CN1.56 UPDATE.7z',
    url: 'https://cloud.yuzuchan.moe/f/Jvhl/Resource%20CN1.56%20UPDATE.7z',
    bytes: 22679,
    extractDir: 'Resource CN1.56 UPDATE',
  },
];

const SONG_LIST_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list?notes=true';

/** b50 需要的 pic/ 根目录文件（其余 UI_* 也一并保留，便于后续扩展）。 */
const PIC_ROOT_EXTRA = new Set(['SD.png', 'DX.png', 'Name.png', 'logo.png']);
const THEME_DIRS = ['prism_plus', 'circle'];
const FONTS = [
  'ResourceHanRoundedCN-Bold.ttf',
  'Torus SemiBold.otf',
  'FOT-NewRodin Pro EB.otf',
  'ShangguMonoSC-Regular.otf',
];

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const REFRESH_DATA = args.has('--refresh-data');

function log(msg) {
  console.log(`[fetch-assets-mai] ${msg}`);
}

function fail(msg) {
  console.error(`[fetch-assets-mai] ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ────────────────────────── 1. 定位 / 准备源 static 目录 ──────────────────────────

function isStaticRoot(dir) {
  return (
    !!dir &&
    existsSync(join(dir, 'mai', 'pic')) &&
    existsSync(join(dir, 'mai', 'cover')) &&
    existsSync(join(dir, 'font'))
  );
}

function download(url, dest, expectedBytes) {
  const have = fileSize(dest);
  if (have === expectedBytes) {
    log(`归档已存在，跳过下载：${basename(dest)} (${have} B)`);
    return;
  }
  ensureDir(dirname(dest));
  log(`下载 ${url}`);
  const r = spawnSync(
    'curl',
    ['-L', '--fail', '--retry', '3', '--connect-timeout', '30', '-o', dest, url],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) fail(`curl 下载失败：${url}`);
  const size = fileSize(dest);
  if (size !== expectedBytes) {
    fail(`下载体积不符：${basename(dest)} 期望 ${expectedBytes} 实得 ${size}`);
  }
  log(`下载完成：${basename(dest)} (${size} B)`);
}

function py7zrExtract() {
  if (!existsSync(PYTHON)) {
    fail(`缺少 .venv-ref（${PYTHON}）。先执行：uv venv .venv-ref --python 3.11 && uv pip install --python .venv-ref/bin/python py7zr pillow numpy pydantic`);
  }
  const script = `
import py7zr, sys, pathlib
cache = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for name in sys.argv[3:]:
    with py7zr.SevenZipFile(cache / name) as z:
        z.extractall(path=out)
print("extracted", ",".join(sys.argv[3:]))
`;
  log('用 py7zr 解压资源包（首次约 10~30s）');
  execFileSync(PYTHON, ['-c', script, CACHE_DIR, join(CACHE_DIR, 'extracted'), ...ARCHIVES.map((a) => a.name)], {
    stdio: 'inherit',
  });
}

function resolveSourceStatic() {
  const envStatic = process.env.MAIMAIDX_STATIC ? resolve(process.env.MAIMAIDX_STATIC) : '';
  if (envStatic) {
    if (isStaticRoot(envStatic)) {
      log(`复用 MAIMAIDX_STATIC=${envStatic}，跳过下载/解压`);
      return { root: envStatic, origin: 'env:MAIMAIDX_STATIC' };
    }
    if (existsSync(envStatic)) {
      // 允许直接指向 vendor/mai 这类「已裁剪」目录：此时无需再裁剪。
      if (existsSync(join(envStatic, 'pic')) && existsSync(join(envStatic, 'cover'))) {
        log(`MAIMAIDX_STATIC=${envStatic} 已是裁剪后的资源目录，跳过下载/裁剪`);
        return { root: envStatic, origin: 'env:MAIMAIDX_STATIC(cropped)', cropped: true };
      }
    }
    fail(`MAIMAIDX_STATIC=${envStatic} 不是有效的 maimaiDX static 目录（需含 mai/pic、mai/cover、font/）`);
  }

  const extracted = join(CACHE_DIR, 'extracted');
  const stampOk = ARCHIVES.every((a) => existsSync(join(extracted, a.extractDir)));
  if (!stampOk) {
    for (const a of ARCHIVES) download(a.url, join(CACHE_DIR, a.name), a.bytes);
    py7zrExtract();
  } else {
    log(`复用已解压缓存：${extracted}`);
  }
  const mainRoot = join(extracted, ARCHIVES[0].extractDir, 'static');
  if (!isStaticRoot(mainRoot)) fail(`解压目录结构异常：${mainRoot}`);

  // 1.56 UPDATE 是 pic/ 下的覆盖层（DX 数字牌）。
  const updateDir = join(extracted, ARCHIVES[1].extractDir);
  if (existsSync(updateDir)) {
    const picDir = join(mainRoot, 'mai', 'pic');
    for (const name of readdirSync(updateDir)) {
      if (!name.toLowerCase().endsWith('.png')) continue;
      copyFileSync(join(updateDir, name), join(picDir, name));
    }
    log(`应用 1.56 UPDATE 覆盖层：${readdirSync(updateDir).filter((n) => n.endsWith('.png')).length} 个文件`);
  }
  return { root: mainRoot, origin: `archive CN1.55 + CN1.56 UPDATE (cache=${CACHE_DIR})` };
}

// ────────────────────────────── 2. 裁剪到 vendor/mai ──────────────────────────────

function copyIfChanged(src, dest) {
  if (!FORCE && existsSync(dest) && fileSize(dest) === fileSize(src)) return false;
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  return true;
}

function crop(srcRoot) {
  const srcMai = join(srcRoot, 'mai');
  const srcFont = join(srcRoot, 'font');
  const outPic = join(VENDOR_MAI, 'pic');
  const counters = { pic: 0, cover: 0, shougou: 0, font: 0, plate: 0 };

  // pic/ 根：UI_*、b50_score_*、SD/DX/Name/logo
  for (const name of readdirSync(join(srcMai, 'pic'))) {
    const p = join(srcMai, 'pic', name);
    if (!statSync(p).isFile()) continue;
    const keep =
      name.startsWith('UI_') ||
      name.startsWith('b50_score_') ||
      PIC_ROOT_EXTRA.has(name);
    if (!keep) continue;
    if (copyIfChanged(p, join(outPic, name))) counters.pic++;
  }

  // pic/<theme>/：整个主题目录（b50.png / logo.png / title*.png / DXRating / Rank 图标）
  for (const theme of THEME_DIRS) {
    const dir = join(srcMai, 'pic', theme);
    if (!existsSync(dir)) fail(`缺少主题目录 pic/${theme}`);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!statSync(p).isFile()) continue;
      if (copyIfChanged(p, join(outPic, theme, name))) counters.pic++;
    }
  }

  // cover/：全量曲绘
  for (const name of readdirSync(join(srcMai, 'cover'))) {
    const p = join(srcMai, 'cover', name);
    if (!statSync(p).isFile()) continue;
    if (copyIfChanged(p, join(VENDOR_MAI, 'cover', name))) counters.cover++;
  }

  // shougou/：称号条底图
  for (const name of readdirSync(join(srcMai, 'shougou'))) {
    const p = join(srcMai, 'shougou', name);
    if (!statSync(p).isFile()) continue;
    if (copyIfChanged(p, join(VENDOR_MAI, 'shougou', name))) counters.shougou++;
  }

  // plate/：默认名牌 0.png（maimaiDX 默认名牌 = pic/UI_Plate_550101.png）
  const defaultPlate = join(srcMai, 'pic', 'UI_Plate_550101.png');
  if (!existsSync(defaultPlate)) fail('缺少默认名牌 pic/UI_Plate_550101.png');
  if (copyIfChanged(defaultPlate, join(VENDOR_MAI, 'plate', '0.png'))) counters.plate++;

  // font/
  for (const name of FONTS) {
    const p = join(srcFont, name);
    if (!existsSync(p)) fail(`缺少字体 font/${name}`);
    if (copyIfChanged(p, join(VENDOR_MAI, 'font', name))) counters.font++;
  }

  return counters;
}

// ──────────────────────────── 3. 曲目数据缓存（定数/notes） ────────────────────────────

async function syncSongData() {
  const out = join(VENDOR_MAI, 'data.json');
  if (!REFRESH_DATA && existsSync(out) && fileSize(out) > 1024) {
    log(`曲目数据已存在，跳过（--refresh-data 可强制刷新）：${out}`);
    return;
  }
  log(`拉取曲目数据 ${SONG_LIST_URL}`);
  const res = await fetch(SONG_LIST_URL, {
    headers: { 'user-agent': 'rankhub-qqbot/fetch-assets-mai' },
  });
  if (!res.ok) fail(`曲目数据拉取失败：HTTP ${res.status}`);
  const json = await res.json();
  const songs = Array.isArray(json?.songs) ? json.songs : [];
  if (songs.length < 1000) fail(`曲目数据异常：songs=${songs.length}`);
  // lxns 的 difficulties 是 { standard: [...], dx: [...] }，b50 的 song_id 约定：
  // standard 用曲目 id，dx 用 id + 10000（与 maimaiDX 一致）。
  // 只保留 b50 需要的字段（定数 + notes.total），控制体积。
  const compact = {
    fetchedAt: new Date().toISOString(),
    source: SONG_LIST_URL,
    songs: songs.map((s) => {
      const diffs = [];
      for (const chartType of ['standard', 'dx']) {
        const list = s.difficulties?.[chartType];
        if (!Array.isArray(list)) continue;
        for (const d of list) {
          diffs.push({
            type: chartType,
            difficulty: d.difficulty,
            level: d.level,
            level_value: d.level_value ?? null,
            notes_total: d.notes?.total ?? null,
          });
        }
      }
      return { id: s.id, title: s.title, difficulties: diffs };
    }),
  };
  ensureDir(VENDOR_MAI);
  writeFileSync(out, JSON.stringify(compact));
  log(`曲目数据已写入 ${out}（${songs.length} 首，${(fileSize(out) / 1024).toFixed(0)} KiB）`);
}

// ────────────────────────────────── 4. 校验 ──────────────────────────────────

const REQUIRED = [
  'pic/Name.png',
  'pic/logo.png',
  'pic/SD.png',
  'pic/DX.png',
  'pic/UI_Plate_550101.png',
  'pic/UI_Icon_509506.png',
  'pic/UI_NUM_Drating_0.png',
  'pic/UI_NUM_Drating_9.png',
  'pic/UI_DNM_DaniPlate_11.png',
  'pic/UI_FBR_Class_25.png',
  'pic/b50_score_basic.png',
  'pic/b50_score_advanced.png',
  'pic/b50_score_expert.png',
  'pic/b50_score_master.png',
  'pic/b50_score_remaster.png',
  'pic/UI_MSS_MBase_Icon_FSD.png',
  'pic/UI_GAM_Gauge_DXScoreIcon_05.png',
  'pic/prism_plus/b50.png',
  'pic/prism_plus/logo.png',
  'pic/prism_plus/UI_CMN_DXRating_11.png',
  'pic/prism_plus/UI_TTR_Rank_SSSp.png',
  'pic/circle/b50.png',
  'pic/circle/UI_CMN_DXRating_Star_01.png',
  'plate/0.png',
  'shougou/UI_CMN_Shougou_Rainbow.png',
  'cover/0.png',
  'font/ResourceHanRoundedCN-Bold.ttf',
  'font/Torus SemiBold.otf',
  'font/FOT-NewRodin Pro EB.otf',
  'font/ShangguMonoSC-Regular.otf',
];

function verify() {
  const missing = REQUIRED.filter((rel) => !existsSync(join(VENDOR_MAI, rel)));
  const covers = existsSync(join(VENDOR_MAI, 'cover')) ? readdirSync(join(VENDOR_MAI, 'cover')).length : 0;
  if (missing.length) fail(`产物缺文件：\n  - ${missing.join('\n  - ')}`);
  if (covers < 1000) fail(`曲绘数量异常：${covers}`);
  log(`校验通过：${REQUIRED.length} 个关键文件、${covers} 张曲绘`);
  return { covers };
}

// ─────────────────────────────────── main ───────────────────────────────────

async function main() {
  if (process.env.MAIMAIDX_STATIC && !process.env.MAIMAIDX_STATIC.trim()) {
    delete process.env.MAIMAIDX_STATIC;
  }

  const src = resolveSourceStatic();
  let counters = null;
  if (!src.cropped) {
    if (FORCE && existsSync(VENDOR_MAI)) {
      log('--force：清理 vendor/mai');
      rmSync(VENDOR_MAI, { recursive: true, force: true });
    }
    counters = crop(src.root);
    log(
      `裁剪完成：pic +${counters.pic}、cover +${counters.cover}、shougou +${counters.shougou}、plate +${counters.plate}、font +${counters.font}（相对上次跳过未变更文件）`,
    );
  }

  await syncSongData();
  const { covers } = verify();

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: src.origin,
    maimaidxCommit: '1154ad676238ab45a76a70c23648f7a6d881e53c',
    archives: ARCHIVES.map((a) => ({ name: a.name, url: a.url, bytes: a.bytes })),
    songData: existsSync(join(VENDOR_MAI, 'data.json')) ? sha256(join(VENDOR_MAI, 'data.json')).slice(0, 16) : null,
    covers,
    files: {
      pic: readdirSync(join(VENDOR_MAI, 'pic')).length,
      plate: readdirSync(join(VENDOR_MAI, 'plate')).length,
      shougou: readdirSync(join(VENDOR_MAI, 'shougou')).length,
      font: readdirSync(join(VENDOR_MAI, 'font')).length,
    },
  };
  writeFileSync(join(VENDOR_MAI, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`完成，产物目录：${VENDOR_MAI}`);
}

main().catch((err) => {
  console.error(`[fetch-assets-mai] 失败：${err.message}`);
  process.exit(1);
});
