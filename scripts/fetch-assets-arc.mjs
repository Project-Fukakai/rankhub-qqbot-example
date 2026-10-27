#!/usr/bin/env node
/**
 * Arcaea B50 海报素材同步：把 design 稿 `best-posters` 里 arcaea 用到的
 * 曲绘 / 字体 / logo 复制（裁剪）到 `vendor/arc/`，并生成曲绘索引 `covers/index.json`。
 *
 * 用法：
 *   node scripts/fetch-assets-arc.mjs                 # 默认源 ../designs/best-posters
 *   node scripts/fetch-assets-arc.mjs --source <dir>  # 指定 best-posters 根目录
 *   ARC_DESIGN_DIR=<dir> node scripts/fetch-assets-arc.mjs
 *   node scripts/fetch-assets-arc.mjs --out vendor/arc --force
 *
 * 产物结构（全部由本脚本生成，`vendor/` 在 .gitignore 内）：
 *   vendor/arc/covers/<16hex>.jpg   曲绘（best-posters 原样复制，最长边 720 已在上游压过）
 *   vendor/arc/covers/index.json    songId → { file, title, artist, levels }
 *   vendor/arc/covers/placeholder.svg  缺曲绘时的占位图（本脚本生成）
 *   vendor/arc/fonts/{Saira-*.ttf, 阿里妈妈数黑体.ttf}
 *   vendor/arc/logos/{arcaea.svg, rankhub.svg}
 *
 * 幂等：已存在且内容一致的文件只统计不重写；index.json 内容不变时同样不重写。
 * 源素材缺失时直接报错退出（不生成半套素材）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** scripts → 仓库根。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DESIGN_DIR = resolve(REPO_ROOT, '..', 'designs', 'best-posters');
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'vendor', 'arc');

/** 必需素材（缺一个就报错，避免生成"看起来成功"的半套资源）。 */
const REQUIRED = {
  /** 曲绘目录：Arcaea 的 60 张谱面覆盖图。 */
  covers: join('assets', 'covers', 'arcaea'),
  /** 字体目录：Saira 4 档 + 阿里妈妈数黑体（CJK 标题）。 */
  fonts: join('assets', 'fonts'),
};
/** logo：arcaea.svg 是 hero 标题字标，必需；rankhub.svg 仅在缺失时告警。 */
const LOGOS = { required: ['arcaea.svg'], optional: ['rankhub.svg'] };
/** 字体白名单：只搬 arcaea 海报真正用到的，避免把整包字体塞进 vendor。 */
const FONT_FILES = [
  'Saira-Regular.ttf',
  'Saira-Medium.ttf',
  'Saira-SemiBold.ttf',
  'Saira-Bold.ttf',
  '阿里妈妈数黑体.ttf',
];

function parseArgs(argv) {
  const options = {
    source: process.env.ARC_DESIGN_DIR?.trim() || DEFAULT_DESIGN_DIR,
    out: DEFAULT_OUT_DIR,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source' || arg === '--design') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 需要一个目录参数`);
      options.source = resolve(value);
      i += 1;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out 需要一个目录参数');
      options.out = resolve(value);
      i += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: node scripts/fetch-assets-arc.mjs [--source <best-posters 目录>] [--out <产物目录>] [--force]',
          '',
          `默认源: ${DEFAULT_DESIGN_DIR}`,
          `默认产物: ${DEFAULT_OUT_DIR}`,
          '环境变量: ARC_DESIGN_DIR（源目录）、ARC_ASSETS_DIR（产物目录）',
          '--force: 忽略内容比对，强制重写所有产物',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  if (process.env.ARC_ASSETS_DIR?.trim() && !argv.includes('--out')) {
    options.out = resolve(process.env.ARC_ASSETS_DIR.trim());
  }
  return options;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 人眼友好的字节数（1024 进制，保留 1 位小数）。 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * 复制单个文件，幂等：内容一致就跳过。
 * 返回 'copied' | 'unchanged'。
 */
async function copyIdempotent(sourcePath, destPath, force) {
  const sourceBytes = readFileSync(sourcePath);
  if (!force && existsSync(destPath)) {
    const destStat = statSync(destPath);
    if (destStat.size === sourceBytes.length) {
      const destBytes = readFileSync(destPath);
      if (sha256(destBytes) === sha256(sourceBytes)) return { status: 'unchanged', bytes: sourceBytes.length };
    }
  }
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(sourcePath, destPath);
  return { status: 'copied', bytes: sourceBytes.length };
}

/**
 * 从 best-posters 的 `data/catalog.js` 里抽出 arcaea 谱面快照。
 *
 * 该文件由 `scripts/collect-assets.py` 生成，形如：
 *   // 注释
 *   globalThis.BestCatalog = { ... };
 * 因此直接截取第一个 `{` 到最后一个 `}` 按 JSON 解析，不执行任何脚本。
 */
function readArcaeaCatalog(designDir) {
  const catalogPath = join(designDir, 'data', 'catalog.js');
  if (!existsSync(catalogPath)) {
    throw new Error(`未找到曲库快照 ${catalogPath}：请确认 --source 指向 best-posters 根目录。`);
  }
  const text = readFileSync(catalogPath, 'utf8');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`曲库快照格式异常（找不到 JSON 主体）: ${catalogPath}`);
  let catalog;
  try {
    catalog = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`曲库快照 JSON 解析失败 ${catalogPath}: ${error instanceof Error ? error.message : error}`);
  }
  const rows = catalog?.games?.arcaea;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`曲库快照里没有 arcaea 谱面: ${catalogPath}`);
  }
  return rows;
}

/**
 * 生成曲绘索引：songId → { file, title, artist, levels }。
 *
 * 曲绘文件命名规则来自 best-posters `scripts/collect-assets.py:255`：
 *   sha256(sourceCoverUrl) 的前 16 位十六进制 + '.jpg'
 * 同一首歌的不同难度共用同一张曲绘（同一 sourceCoverUrl），这里按 songId 去重。
 */
function buildCoversIndex(rows) {
  const songs = new Map();
  for (const row of rows) {
    const songId = String(row.songId ?? '');
    const cover = String(row.cover ?? '');
    if (!songId || !cover) continue;
    const file = basename(cover);
    const existing = songs.get(songId);
    const level = {
      difficulty: String(row.difficulty ?? ''),
      level: row.level == null ? null : String(row.level),
      constant: typeof row.constant === 'number' ? row.constant : null,
      difficultyIndex: Number.isInteger(row.difficultyIndex) ? row.difficultyIndex : null,
    };
    if (!existing) {
      songs.set(songId, {
        file,
        title: String(row.title ?? songId),
        artist: String(row.artist ?? ''),
        levels: level.difficulty ? { [level.difficulty]: level } : {},
      });
      continue;
    }
    if (level.difficulty) existing.levels[level.difficulty] = level;
  }
  // 键排序保证 index.json 字节稳定（幂等 + 可 diff）。
  const ordered = {};
  for (const songId of [...songs.keys()].sort()) {
    const entry = songs.get(songId);
    const levels = {};
    for (const key of Object.keys(entry.levels).sort()) levels[key] = entry.levels[key];
    ordered[songId] = { file: entry.file, title: entry.title, artist: entry.artist, levels };
  }
  return ordered;
}

/** 缺曲绘占位图：深色斜纹 + NO ARTWORK，和海报的暗色玻璃卡面同族。 */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300" role="img" aria-label="Artwork unavailable">
  <defs>
    <pattern id="hatch" width="16" height="16" patternTransform="rotate(135)" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#171b20"/>
      <rect width="1" height="16" fill="#20252c"/>
    </pattern>
  </defs>
  <rect width="300" height="300" fill="url(#hatch)"/>
  <rect x="0.5" y="0.5" width="299" height="299" fill="none" stroke="#ffffff20"/>
  <g fill="#b2bbc8" font-family="Saira, 'PingFang SC', sans-serif" text-anchor="middle">
    <text x="150" y="146" font-size="64" font-weight="400">+</text>
    <text x="150" y="192" font-size="22" letter-spacing="4">NO ARTWORK</text>
  </g>
</svg>
`;

function assertSource(designDir) {
  if (!existsSync(designDir)) {
    throw new Error(
      `未找到 best-posters 设计稿目录：${designDir}\n` +
        '请用 --source <dir> 或环境变量 ARC_DESIGN_DIR 指向 best-posters 仓库根目录' +
        '（需包含 assets/covers/arcaea、assets/fonts、assets/logos、data/catalog.js）。',
    );
  }
  if (!existsSync(join(designDir, 'index.html'))) {
    throw new Error(`目录 ${designDir} 不像 best-posters 根目录（缺 index.html）。`);
  }
  const missing = [];
  for (const relative of Object.values(REQUIRED)) {
    const full = join(designDir, relative);
    if (!existsSync(full)) missing.push(relative);
  }
  for (const logo of LOGOS.required) {
    if (!existsSync(join(designDir, 'assets', 'logos', logo))) missing.push(join('assets', 'logos', logo));
  }
  if (missing.length > 0) {
    throw new Error(`best-posters 源素材缺失（${designDir}）：\n  - ${missing.join('\n  - ')}`);
  }
  for (const relative of Object.values(REQUIRED)) {
    const full = join(designDir, relative);
    if (statSync(full).isDirectory() && readdirSync(full).length === 0) {
      throw new Error(`best-posters 源素材目录为空：${full}`);
    }
  }
}

function listFiles(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => predicate(name))
    .sort()
    .map((name) => join(dir, name));
}

async function main() {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  const designDir = options.source;
  const outDir = options.out;

  assertSource(designDir);

  const rows = readArcaeaCatalog(designDir);
  const coverFiles = listFiles(join(designDir, REQUIRED.covers), (name) => /\.(jpe?g|png)$/i.test(name));
  if (coverFiles.length === 0) {
    throw new Error(`曲绘目录里没有图片：${join(designDir, REQUIRED.covers)}`);
  }

  const fontSources = [];
  for (const name of FONT_FILES) {
    const full = join(designDir, REQUIRED.fonts, name);
    if (existsSync(full)) fontSources.push(full);
  }
  if (fontSources.length === 0) {
    throw new Error(
      `字体目录里缺少数黑体/Saira：${join(designDir, REQUIRED.fonts)}（期望 ${FONT_FILES.join('、')}）`,
    );
  }
  const logoSources = [];
  for (const name of [...LOGOS.required, ...LOGOS.optional]) {
    const full = join(designDir, 'assets', 'logos', name);
    if (!existsSync(full)) {
      if (LOGOS.required.includes(name)) throw new Error(`缺少必需 logo：${full}`);
      console.warn(`[warn] 缺少可选 logo ${name}，海报会回退成文字标题`);
      continue;
    }
    logoSources.push(full);
  }

  const coversDir = join(outDir, 'covers');
  const fontsDir = join(outDir, 'fonts');
  const logosDir = join(outDir, 'logos');
  await mkdir(coversDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });
  await mkdir(logosDir, { recursive: true });

  const stats = { copied: 0, unchanged: 0, bytes: 0 };
  async function sync(files, targetDir) {
    const group = { copied: 0, unchanged: 0, bytes: 0, files: files.length };
    for (const sourcePath of files) {
      const destPath = join(targetDir, basename(sourcePath));
      const result = await copyIdempotent(sourcePath, destPath, options.force);
      group[result.status] += 1;
      group.bytes += result.bytes;
      stats[result.status] += 1;
      stats.bytes += result.bytes;
    }
    return group;
  }

  const coverStats = await sync(coverFiles, coversDir);
  const fontStats = await sync(fontSources, fontsDir);
  const logoStats = await sync(logoSources, logosDir);

  // 占位图：内容固定，只在缺失或 --force 时写。
  const placeholderPath = join(coversDir, 'placeholder.svg');
  let placeholderStatus = 'unchanged';
  if (options.force || !existsSync(placeholderPath)) {
    await writeFile(placeholderPath, PLACEHOLDER_SVG, 'utf8');
    placeholderStatus = 'written';
  }

  // 索引：内容不变则不重写（保持 mtime，避免渲染进程缓存无谓失效）。
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'best-posters/data/catalog.js (games.arcaea)',
    placeholder: 'placeholder.svg',
    songs: buildCoversIndex(rows),
  };
  const indexPath = join(coversDir, 'index.json');
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  let indexStatus = 'written';
  if (!options.force && existsSync(indexPath)) {
    const previous = readFileSync(indexPath, 'utf8');
    // generatedAt 每次都变，比对时先抹掉时间戳再判断是否有实质变化。
    const strip = (text) => text.replace(/"generatedAt":\s*"[^"]*",\n/, '');
    if (strip(previous) === strip(serialized)) indexStatus = 'unchanged';
  }
  if (indexStatus === 'written') await writeFile(indexPath, serialized, 'utf8');

  const songCount = Object.keys(index.songs).length;
  const missingCovers = coverFiles.length - new Set(Object.values(index.songs).map((entry) => entry.file)).size;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  const line = (label, group, extra = '') =>
    `  ${label.padEnd(12)}${String(group.files).padStart(3)} 个文件（${formatBytes(group.bytes)}）：` +
    `新增 ${group.copied}，未变 ${group.unchanged}${extra}`;

  console.log(`arcaea 素材同步完成 → ${outDir}`);
  console.log(line('covers', coverStats, missingCovers > 0 ? `，未被索引引用 ${missingCovers}` : ''));
  console.log(line('fonts', fontStats));
  console.log(line('logos', logoStats));
  console.log(
    `  ${'index.json'.padEnd(12)}${songCount} 首曲目 / ${rows.length} 张谱面：${
      indexStatus === 'written' ? '已写入' : '未变'
    }`,
  );
  console.log(`  占位图 placeholder.svg：${placeholderStatus === 'written' ? '已生成' : '未变'}`);
  console.log(`  总计：${stats.copied + stats.unchanged} 个文件，${formatBytes(stats.bytes)}（耗时 ${elapsed}s）`);
  if (fontSources.length < FONT_FILES.length) {
    const missingFonts = FONT_FILES.filter((name) => !fontSources.some((path) => basename(path) === name));
    console.warn(`[warn] 字体不全，海报会回退系统字体：缺 ${missingFonts.join('、')}`);
  }
  if (songCount < rows.length) {
    console.log(`  提示：${rows.length - songCount} 张谱面共用同曲曲绘（同 songId 去重）。`);
  }
}

main().catch((error) => {
  console.error(`\n[fetch-assets-arc] 失败：${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
