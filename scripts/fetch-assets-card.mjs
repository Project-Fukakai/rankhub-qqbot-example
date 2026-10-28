#!/usr/bin/env node
/**
 * 准备 `/me` 名片渲染的静态素材（幂等，可重复执行）。
 *
 * 产物全部落在 `vendor/card/**`（`vendor/` 在 .gitignore 内），渲染器只读这里：
 *
 * 1. `fonts/`
 *    - Saira Regular/Medium/SemiBold/Bold：App `pubspec.yaml` 的 `Saira` family
 *      （ASCII 展示字体，phigros/arcaea 卡片）。
 *    - Orbitron（可变字重）：maimai B35/B15 数字。
 *    - Aldrich：旧版展示字体的兜底（App 不用，缺失也不影响）。
 *    - phi.ttf（Saira×思源黑体混合字体）体量大（约 8.4MB），**不复制**，
 *      渲染器直接从 `vendor/phi/.../font/phi.ttf` 兜底读取，默认也不内联。
 * 2. `backgrounds/maimai.png`：App 默认背景板（frame 455203，来自 lxns 资源站）。
 * 3. `arcaea/{bg_light,hidden,banner,rating-0..7}.png`
 *    - bg_light / hidden 从 App `assets/arcaea/` 复制；
 *    - banner / rating 图标从 `static.rankhub.cc` 下载（App 用同一个 URL）。
 * 4. `phigros/{green,blue,red,yellow,rainbow,white}.png`：课题模式段位底图，从 App 复制。
 * 5. `maimai/rating/UI_CMN_DXRating_01..12.png` 与 `maimai/num/0..9.png`
 *    - 优先从 App `assets/maimai/{rating,ra_num}` 复制（App 卡片真实使用的素材）；
 *    - App 缺失时回退 `vendor/mai/pic/prism_plus`（01..11）与 `vendor/mai/pic/UI_NUM_Drating_*`。
 *
 * 素材都是可选的：缺失时渲染器回退系统字体 / 纯色底 / 文字数字，渲染不会失败。
 *
 * 用法：
 *   node scripts/fetch-assets-card.mjs          # 准备（已有且内容一致则跳过）
 *   node scripts/fetch-assets-card.mjs --force  # 覆盖重建
 *   RANKHUB_APP_DIR=/path/to/RankHub node scripts/fetch-assets-card.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = join(ROOT, 'vendor', 'card');
const FONT_DIR = join(CARD_DIR, 'fonts');
const BACKGROUND_DIR = join(CARD_DIR, 'backgrounds');
const ARCAEA_DIR = join(CARD_DIR, 'arcaea');
const PHIGROS_DIR = join(CARD_DIR, 'phigros');
const MAIMAI_RATING_DIR = join(CARD_DIR, 'maimai', 'rating');
const MAIMAI_NUM_DIR = join(CARD_DIR, 'maimai', 'num');

const PHI_FONT_DIR = join(ROOT, 'vendor', 'phi', 'resources', 'html', 'common', 'font');
const ARC_FONT_DIR = join(ROOT, 'vendor', 'arc', 'fonts');
const VENDOR_MAI_PIC = join(ROOT, 'vendor', 'mai', 'pic');
const VENDOR_MAI_PRISM = join(VENDOR_MAI_PIC, 'prism_plus');

const RANKHUB_APP_DIR = resolve(
  process.env.RANKHUB_APP_DIR?.trim() || join(ROOT, '..', 'RankHub'),
);
const APP_FONT_DIR = join(RANKHUB_APP_DIR, 'assets', 'fonts');
const APP_ARCAEA_DIR = join(RANKHUB_APP_DIR, 'assets', 'arcaea');
const APP_PHIGROS_DIR = join(RANKHUB_APP_DIR, 'assets', 'phigros');
const APP_MAIMAI_RATING_DIR = join(RANKHUB_APP_DIR, 'assets', 'maimai', 'rating');
const APP_MAIMAI_NUM_DIR = join(RANKHUB_APP_DIR, 'assets', 'maimai', 'ra_num');

/** Google Fonts 仓库里的可变字体（OFL-1.1），App 素材缺失时的兜底。 */
const GOOGLE_SAIRA_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/saira/Saira%5Bwght%5D.ttf';
const GOOGLE_ORBITRON_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf';

/** App 默认 maimai 背景板（`player_info_card.dart:39-40`，frame id 455203）。 */
const MAIMAI_FRAME = {
  id: 455203,
  url: 'https://assets2.lxns.net/maimai/frame/455203.png',
  target: join(BACKGROUND_DIR, 'maimai.png'),
};

/** arcaea 线上素材（App 使用同一批 URL）。 */
const ARCAEA_BANNER = {
  url: 'https://static.rankhub.cc/arcaea/asset/img/course/banner/online_banner_2026_07.png',
  target: join(ARCAEA_DIR, 'banner.png'),
};
const ARCAEA_RATING_URL = (index) =>
  `https://static.rankhub.cc/arcaea/asset/img/rating_${index}.png`;

/** 字体文件清单（按 App pubspec 的 family/weight）。 */
const FONT_FILES = [
  { name: 'Saira-Regular.ttf', appName: 'Saira-Regular.ttf', weight: 400, minBytes: 10 * 1024 },
  { name: 'Saira-Medium.ttf', appName: 'Saira-Medium.ttf', weight: 500, minBytes: 10 * 1024 },
  { name: 'Saira-SemiBold.ttf', appName: 'Saira-SemiBold.ttf', weight: 600, minBytes: 10 * 1024 },
  { name: 'Saira-Bold.ttf', appName: 'Saira-Bold.ttf', weight: 700, minBytes: 10 * 1024 },
  {
    name: 'Orbitron-VariableFont_wght.ttf',
    appName: 'Orbitron-VariableFont_wght.ttf',
    weight: '100 900',
    minBytes: 10 * 1024,
  },
];
/** phigros 课题模式段位底图（`phigros_challenge_badge.dart:18-33`）。 */
const PHIGROS_BADGES = ['green.png', 'blue.png', 'red.png', 'yellow.png', 'rainbow.png', 'white.png'];
/** maimai 数字 0..9（App `assets/maimai/ra_num`，20×27）。 */
const MAIMAI_DIGITS = Array.from({ length: 10 }, (_, index) => index);

const force = process.argv.includes('--force');
const stats = { copied: 0, unchanged: 0, downloaded: 0, missing: [] };

function log(message) {
  console.log(`[assets:card] ${message}`);
}

function warn(message) {
  console.warn(`[assets:card] ${message}`);
}

function missing(label, detail) {
  stats.missing.push(label);
  warn(`缺失：${label}${detail ? `（${detail}）` : ''}`);
}

/** TrueType / OpenType 文件头校验（0x00010000 / 'true' / 'OTTO' / 'ttcf'）。 */
function looksLikeFont(buffer) {
  if (buffer.length < 4) return false;
  if (buffer.readUInt32BE(0) === 0x00010000) return true;
  const tag = buffer.toString('ascii', 0, 4);
  return tag === 'true' || tag === 'OTTO' || tag === 'ttcf';
}

/** PNG / JPEG 文件头校验（避免把 HTML 错误页当素材）。 */
function imageKind(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'PNG';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'JPEG';
  }
  return null;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileSize(path) {
  try {
    const info = await statSync(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function verifyFont(path, label, minBytes = 10 * 1024) {
  const size = await fileSize(path);
  if (size < minBytes) throw new Error(`${label} 体积异常（${size} 字节）：${path}`);
  if (!looksLikeFont(readFileSync(path))) throw new Error(`${label} 不是合法 TTF/OTF：${path}`);
  log(`字体已就绪：${path}（${(size / 1024).toFixed(1)} KB）`);
}

async function verifyImage(path, label, minBytes = 1024) {
  const size = await fileSize(path);
  if (size < minBytes) throw new Error(`${label} 体积异常（${size} 字节）：${path}`);
  const kind = imageKind(readFileSync(path));
  if (kind === null) throw new Error(`${label} 不是合法 PNG/JPEG：${path}`);
  return kind;
}

/** 幂等复制：内容一致跳过；返回 'copied' | 'unchanged'。 */
async function copyIdempotent(source, target, { verify, label, minBytes } = {}) {
  if (!existsSync(source)) return false;
  const sourceBytes = readFileSync(source);
  if (!force && existsSync(target)) {
    try {
      const targetBytes = readFileSync(target);
      if (
        targetBytes.length === sourceBytes.length &&
        sha256(targetBytes) === sha256(sourceBytes)
      ) {
        stats.unchanged += 1;
        return true;
      }
    } catch {
      /* 读失败按需要重建处理 */
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, sourceBytes);
  await rename(temp, target);
  if (verify === 'font') await verifyFont(target, label ?? source, minBytes);
  if (verify === 'image') await verifyImage(target, label ?? source, minBytes);
  stats.copied += 1;
  return true;
}

/** 下载（幂等：已有文件通过校验就跳过）。 */
async function download(url, target, { label, minKind, minBytes, retries = 2 } = {}) {
  if (!force && (await fileSize(target)) > 0) {
    try {
      const kind = await verifyImage(target, label ?? target, minBytes);
      if (minKind === undefined || kind === minKind) {
        stats.unchanged += 1;
        return true;
      }
    } catch {
      warn(`已有文件校验失败，重新下载：${target}`);
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'rankhub-qqbot-assets-fetch' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const kind = imageKind(buffer);
      if (kind === null || (minKind !== undefined && kind !== minKind) || buffer.length < (minBytes ?? 256)) {
        throw new Error(`下载内容不是合法素材（${buffer.length} 字节，${kind ?? 'unknown'}）`);
      }
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.tmp`;
      await writeFile(temp, buffer);
      await rename(temp, target);
      await verifyImage(target, label ?? url, minBytes);
      stats.downloaded += 1;
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw new Error(
    `下载失败 ${url}：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ─────────────────────────────────── 字体 ───────────────────────────────────

async function prepareFonts() {
  let ok = 0;
  for (const font of FONT_FILES) {
    const target = join(FONT_DIR, font.name);
    try {
      if (!force && (await fileSize(target)) > 0) {
        await verifyFont(target, `已有字体 ${font.name}`, font.minBytes);
        stats.unchanged += 1;
        ok += 1;
        continue;
      }
      const appSource = join(APP_FONT_DIR, font.appName);
      const arcSource = join(ARC_FONT_DIR, font.appName);
      if (await copyIdempotent(appSource, target, {
        verify: 'font',
        label: `App 字体 ${font.name}`,
        minBytes: font.minBytes,
      })) {
        ok += 1;
        continue;
      }
      if (await copyIdempotent(arcSource, target, {
        verify: 'font',
        label: `vendor/arc 字体 ${font.name}`,
        minBytes: font.minBytes,
      })) {
        ok += 1;
        continue;
      }
      missing(`字体 ${font.name}`, `App ${appSource} / vendor/arc ${arcSource}`);
    } catch (error) {
      warn(`字体 ${font.name} 准备失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  // 可变字体兜底：App/vendor 都缺对应字体时，下载 Google Fonts 的可变字重版本。
  // 注意 Saira 与 Orbitron 分别判断：只缺 Orbitron 时也要补，不能因为 Saira 已有就跳过。
  const variableFonts = [
    {
      url: GOOGLE_SAIRA_URL,
      name: 'Saira-VariableFont_wght.ttf',
      ready: ['Saira-Regular.ttf', 'Saira-Bold.ttf'].every((name) => existsSync(join(FONT_DIR, name))),
    },
    {
      url: GOOGLE_ORBITRON_URL,
      name: 'Orbitron-VariableFont_wght.ttf',
      ready: existsSync(join(FONT_DIR, 'Orbitron-VariableFont_wght.ttf')),
    },
  ];
  for (const item of variableFonts) {
    if (item.ready) continue;
    const target = join(FONT_DIR, item.name);
    try {
      if (!force && (await fileSize(target)) > 0) {
        await verifyFont(target, `已有字体 ${item.name}`);
        stats.unchanged += 1;
        continue;
      }
      log(`本地缺字体，下载 ${item.url}`);
      const response = await fetch(item.url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'rankhub-qqbot-assets-fetch' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!looksLikeFont(buffer) || buffer.length < 10 * 1024) {
        throw new Error(`下载内容不是合法字体（${buffer.length} 字节）`);
      }
      await mkdir(FONT_DIR, { recursive: true });
      const temp = `${target}.tmp`;
      await writeFile(temp, buffer);
      await rename(temp, target);
      await verifyFont(target, '下载的可变字体');
      stats.downloaded += 1;
    } catch (error) {
      warn(`字体下载失败（${item.name}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Aldrich（旧版展示字体兜底）：已有则校验，否则从 phi-plugin 快照复制。
  const aldrich = join(FONT_DIR, 'Aldrich-Regular.ttf');
  try {
    if ((await fileSize(aldrich)) > 0) {
      await verifyFont(aldrich, '已有 Aldrich');
      stats.unchanged += 1;
    } else if (
      !(await copyIdempotent(join(PHI_FONT_DIR, 'Aldrich-Regular.ttf'), aldrich, {
        verify: 'font',
        label: 'phi-plugin Aldrich',
        minBytes: 10 * 1024,
      }))
    ) {
      missing('Aldrich-Regular.ttf', 'phi-plugin 字体目录');
    }
  } catch (error) {
    warn(`Aldrich 准备失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // phi.ttf 体积大（约 8.4MB），渲染器默认直接从 phi-plugin 快照读取，不复制。
  if (existsSync(join(PHI_FONT_DIR, 'phi.ttf'))) {
    log(`phi.ttf 就绪（直接引用）：${join(PHI_FONT_DIR, 'phi.ttf')}`);
  } else {
    log('phi.ttf 缺失：不影响 App 卡片（默认不内联），仅 phi-plugin 模板会用到。');
  }

  log(`字体：${ok}/${FONT_FILES.length} 个主字体就绪。`);
}

// ───────────────────────────────── 游戏素材 ─────────────────────────────────

async function prepareArcaea() {
  // App 内置 bg_light / hidden。
  const copies = [
    { source: join(APP_ARCAEA_DIR, 'bg_light.png'), target: join(ARCAEA_DIR, 'bg_light.png'), label: 'arcaea bg_light.png' },
    { source: join(APP_ARCAEA_DIR, 'hidden.png'), target: join(ARCAEA_DIR, 'hidden.png'), label: 'arcaea hidden.png' },
  ];
  for (const item of copies) {
    try {
      if (!force && (await fileSize(item.target)) > 0) {
        await verifyImage(item.target, `已有 ${item.label}`, 8 * 1024);
        stats.unchanged += 1;
        continue;
      }
      if (!(await copyIdempotent(item.source, item.target, { verify: 'image', label: item.label, minBytes: 8 * 1024 }))) {
        missing(item.label, `App ${item.source}`);
      }
    } catch (error) {
      warn(`${item.label} 准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // banner + rating 图标：线上静态资源站（App 用同一批 URL）。
  try {
    await download(ARCAEA_BANNER.url, ARCAEA_BANNER.target, {
      label: 'arcaea banner',
      minKind: 'PNG',
      minBytes: 8 * 1024,
    });
  } catch (error) {
    warn(`arcaea banner 准备失败：${error instanceof Error ? error.message : String(error)}`);
  }
  for (let index = 0; index < 8; index += 1) {
    try {
      await download(ARCAEA_RATING_URL(index), join(ARCAEA_DIR, `rating-${index}.png`), {
        label: `arcaea rating-${index}`,
        minKind: 'PNG',
        minBytes: 1024,
      });
    } catch (error) {
      warn(`arcaea rating-${index} 准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function preparePhigros() {
  for (const file of PHIGROS_BADGES) {
    const target = join(PHIGROS_DIR, file);
    try {
      if (!force && (await fileSize(target)) > 0) {
        await verifyImage(target, `已有 phigros ${file}`, 1024);
        stats.unchanged += 1;
        continue;
      }
      if (!(await copyIdempotent(join(APP_PHIGROS_DIR, file), target, {
        verify: 'image',
        label: `phigros ${file}`,
        minBytes: 1024,
      }))) {
        missing(`phigros ${file}`, join(APP_PHIGROS_DIR, file));
      }
    } catch (error) {
      warn(`phigros ${file} 准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function prepareMaimaiBadges() {
  // DX Rating 徽章 01..12：App 素材最全（12 档），vendor/mai 只有 01..11。
  for (let assetIndex = 1; assetIndex <= 12; assetIndex += 1) {
    const padded = String(assetIndex).padStart(2, '0');
    const target = join(MAIMAI_RATING_DIR, `UI_CMN_DXRating_${padded}.png`);
    try {
      if (!force && (await fileSize(target)) > 0) {
        await verifyImage(target, `已有 maimai 徽章 ${padded}`, 1024);
        stats.unchanged += 1;
        continue;
      }
      const appSource = join(APP_MAIMAI_RATING_DIR, `UI_CMN_DXRating_${padded}.png`);
      const vendorSource = join(VENDOR_MAI_PRISM, `UI_CMN_DXRating_${padded}.png`);
      if (
        (await copyIdempotent(appSource, target, {
          verify: 'image',
          label: `App maimai 徽章 ${padded}`,
          minBytes: 1024,
        })) ||
        (await copyIdempotent(vendorSource, target, {
          verify: 'image',
          label: `vendor/mai 徽章 ${padded}`,
          minBytes: 1024,
        }))
      ) {
        continue;
      }
      missing(`maimai 徽章 ${padded}`, `App ${appSource} / vendor ${vendorSource}`);
    } catch (error) {
      warn(`maimai 徽章 ${padded} 准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 数字 0..9：App ra_num（20×27，卡片实际使用的比例）；回退 vendor/mai UI_NUM_Drating。
  for (const digit of MAIMAI_DIGITS) {
    const target = join(MAIMAI_NUM_DIR, `${digit}.png`);
    try {
      if (!force && (await fileSize(target)) > 0) {
        await verifyImage(target, `已有 maimai 数字 ${digit}`, 64);
        stats.unchanged += 1;
        continue;
      }
      const appSource = join(APP_MAIMAI_NUM_DIR, `${digit}.png`);
      const vendorSource = join(VENDOR_MAI_PIC, `UI_NUM_Drating_${digit}.png`);
      if (
        (await copyIdempotent(appSource, target, {
          verify: 'image',
          label: `App maimai 数字 ${digit}`,
          minBytes: 64,
        })) ||
        (await copyIdempotent(vendorSource, target, {
          verify: 'image',
          label: `vendor/mai 数字 ${digit}`,
          minBytes: 64,
        }))
      ) {
        continue;
      }
      missing(`maimai 数字 ${digit}`, `App ${appSource} / vendor ${vendorSource}`);
    } catch (error) {
      warn(`maimai 数字 ${digit} 准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function prepareMaimaiFrame() {
  try {
    if (!force && (await fileSize(MAIMAI_FRAME.target)) > 0) {
      await verifyImage(MAIMAI_FRAME.target, '已有 maimai 背景板', 8 * 1024);
      stats.unchanged += 1;
      log('maimai 背景板已存在，跳过（--force 可强制重建）');
      return;
    }
    if (await download(MAIMAI_FRAME.url, MAIMAI_FRAME.target, {
      label: 'App 默认 maimai 背景板',
      minKind: 'PNG',
      minBytes: 8 * 1024,
    })) {
      log(`maimai 背景板 #${MAIMAI_FRAME.id} 已就绪`);
    }
  } catch (error) {
    warn(`maimai 背景板准备失败：${error instanceof Error ? error.message : String(error)}`);
    warn('缺失时 maimai 卡使用纯色兜底（App 在背景板加载失败时也是纯色）。');
  }
}

async function main() {
  log(`App 素材源：${RANKHUB_APP_DIR}`);
  await prepareFonts();
  await prepareMaimaiFrame();
  await prepareArcaea();
  await preparePhigros();
  await prepareMaimaiBadges();
  log(
    `完成：复制 ${stats.copied}、下载 ${stats.downloaded}、跳过 ${stats.unchanged}` +
      (stats.missing.length > 0 ? `、缺失 ${stats.missing.length}` : ''),
  );
  if (stats.missing.length > 0) {
    log('缺失素材不影响渲染（会降级）；要完整素材请检查 RANKHUB_APP_DIR 或网络。');
  }
}

await main();
