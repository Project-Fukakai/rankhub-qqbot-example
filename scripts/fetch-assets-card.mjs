#!/usr/bin/env node
/**
 * 准备 `/me` 名片渲染的**可选**素材（幂等，可重复执行）：
 *
 * 1. 数字/字母展示字体 → `vendor/card/fonts/Aldrich-Regular.ttf`
 *    来源优先级：已有文件 → 本仓库 phi-plugin 快照里的 Aldrich（离线复制）→ Google Fonts 下载。
 * 2. **App 默认游戏卡背景** → `vendor/card/backgrounds/<game>.png`
 *    渲染器在调用方没有传 `background` 时使用它们，保证名片观感与 App 一致，而不是自造渐变：
 *    - maimai：App `player_info_card.dart:47` 的默认背景板 `getFrameUrl(455203)`
 *      （`MaimaiLxnsResourceRepository` 的 `assets2.lxns.net/maimai/frame/<id>.png`）；
 *    - arcaea：App 内置 `assets/arcaea/bg_light.png`（从同工作区的 RankHub 仓库复制，
 *      路径可用 `RANKHUB_APP_DIR` 覆盖）；
 *    - phigros：App 未选曲绘时用 `Colors.grey.shade900` 纯色，没有默认背景素材 ⇒ 不下载，
 *      曲绘由调用方（`background_song_id` → 曲绘 URL）传入。
 *
 * 所有素材都是可选的：缺失时渲染器回退系统字体 / 卡片纯色 surface，渲染不会失败。
 *
 * 用法：
 *   node scripts/fetch-assets-card.mjs          # 准备字体 + 背景（已有则跳过）
 *   node scripts/fetch-assets-card.mjs --force  # 覆盖重建
 *   RANKHUB_APP_DIR=/path/to/RankHub node scripts/fetch-assets-card.mjs
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = join(ROOT, 'vendor', 'card');
const CARD_FONT_DIR = join(CARD_DIR, 'fonts');
const FONT_TARGET = join(CARD_FONT_DIR, 'Aldrich-Regular.ttf');
const BACKGROUND_DIR = join(CARD_DIR, 'backgrounds');
const PHI_FONT = join(ROOT, 'vendor', 'phi', 'resources', 'html', 'common', 'font', 'Aldrich-Regular.ttf');
/** Google Fonts 仓库里的 Aldrich（OFL-1.1），固定分支 + 固定路径，便于追溯。 */
const ALDRICH_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/aldrich/Aldrich-Regular.ttf';
/** 字体下界：低于这个大小基本是错误页/HTML，而不是字体。 */
const MIN_FONT_BYTES = 10 * 1024;

/** App 默认 maimai 背景板：`RankHub/lib/modules/maimai/widgets/player_info_card.dart:47`。 */
const MAIMAI_FRAME = {
  id: 455203,
  url: 'https://assets2.lxns.net/maimai/frame/455203.png',
  target: join(BACKGROUND_DIR, 'maimai.png'),
};
/** App 内置的 arcaea 卡片背景：`RankHub/assets/arcaea/bg_light.png`。 */
const RANKHUB_APP_DIR = resolve(
  process.env.RANKHUB_APP_DIR?.trim() || join(ROOT, '..', 'RankHub'),
);
const ARCAEA_BACKGROUND = {
  source: join(RANKHUB_APP_DIR, 'assets', 'arcaea', 'bg_light.png'),
  target: join(BACKGROUND_DIR, 'arcaea.png'),
};
/** 背景图下界：低于这个大小基本是错误页/占位图。 */
const MIN_IMAGE_BYTES = 32 * 1024;

const force = process.argv.includes('--force');

function log(message) {
  console.log(`[assets:card] ${message}`);
}

function warn(message) {
  console.warn(`[assets:card] ${message}`);
}

/** TrueType / OpenType 文件头校验（0x00010000 / 'true' / 'OTTO' / 'ttcf'）。 */
function looksLikeFont(buffer) {
  if (buffer.length < 4) return false;
  const magic = buffer.readUInt32BE(0);
  if (magic === 0x00010000) return true;
  const tag = buffer.toString('ascii', 0, 4);
  return tag === 'true' || tag === 'OTTO' || tag === 'ttcf';
}

/** PNG / JPEG 文件头校验（背景图只接受位图，避免把 HTML 错误页当素材）。 */
function imageKind(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'PNG';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'JPEG';
  }
  return null;
}

async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function verifyFont(path, label) {
  const size = await fileSize(path);
  if (size < MIN_FONT_BYTES) {
    throw new Error(`${label} 体积异常（${size} 字节）：${path}`);
  }
  const buffer = await readFile(path);
  if (!looksLikeFont(buffer)) {
    throw new Error(`${label} 不是合法的 TTF/OTF：${path}`);
  }
  log(`字体已就绪：${path}（${(size / 1024).toFixed(1)} KB）`);
}

async function verifyImage(path, label) {
  const size = await fileSize(path);
  if (size < MIN_IMAGE_BYTES) {
    throw new Error(`${label} 体积异常（${size} 字节）：${path}`);
  }
  const kind = imageKind(await readFile(path));
  if (kind === null) {
    throw new Error(`${label} 不是合法的 PNG/JPEG：${path}`);
  }
  log(`背景已就绪：${path}（${kind}，${(size / 1024).toFixed(0)} KB）`);
}

async function copyFontFromPhi() {
  if (!existsSync(PHI_FONT)) return false;
  await mkdir(CARD_FONT_DIR, { recursive: true });
  // 先写临时文件再 rename，避免中断留下半截字体。
  const temp = `${FONT_TARGET}.tmp`;
  await copyFile(PHI_FONT, temp);
  await rename(temp, FONT_TARGET);
  await verifyFont(FONT_TARGET, '复制自 phi-plugin 的字体');
  return true;
}

async function downloadFont() {
  log(`本地没有 phi-plugin 字体，尝试下载 ${ALDRICH_URL}`);
  let response;
  try {
    response = await fetch(ALDRICH_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'rankhub-qqbot-assets-fetch' },
    });
  } catch (error) {
    throw new Error(`下载失败（网络不可用？）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!looksLikeFont(buffer) || buffer.length < MIN_FONT_BYTES) {
    throw new Error(`下载内容不是合法字体（${buffer.length} 字节），已丢弃`);
  }
  await mkdir(CARD_FONT_DIR, { recursive: true });
  const temp = `${FONT_TARGET}.tmp`;
  await writeFile(temp, buffer);
  await rename(temp, FONT_TARGET);
  await verifyFont(FONT_TARGET, '下载的字体');
}

async function prepareFont() {
  if (!force && (await fileSize(FONT_TARGET)) > 0) {
    await verifyFont(FONT_TARGET, '已有字体');
    log('字体已存在，跳过（--force 可强制重建）');
    return;
  }
  try {
    if (await copyFontFromPhi()) return;
    await downloadFont();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`未能准备展示字体：${message}`);
    warn('这不影响渲染：名片会回退系统字体（PingFang SC / Noto Sans CJK）。');
    warn('离线环境可先执行 `node scripts/fetch-assets-phi.mjs`，再重跑本脚本。');
    process.exitCode = 1;
  }
}

async function copyArcaeaBackground() {
  if (!existsSync(ARCAEA_BACKGROUND.source)) {
    return false;
  }
  await mkdir(BACKGROUND_DIR, { recursive: true });
  const temp = `${ARCAEA_BACKGROUND.target}.tmp`;
  await copyFile(ARCAEA_BACKGROUND.source, temp);
  await rename(temp, ARCAEA_BACKGROUND.target);
  await verifyImage(ARCAEA_BACKGROUND.target, 'App arcaea bg_light.png');
  return true;
}

async function downloadMaimaiFrame() {
  log(`下载 App 默认 maimai 背景板 #${MAIMAI_FRAME.id}：${MAIMAI_FRAME.url}`);
  let response;
  try {
    response = await fetch(MAIMAI_FRAME.url, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'user-agent': 'rankhub-qqbot-assets-fetch' },
    });
  } catch (error) {
    throw new Error(`下载失败（网络不可用？）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (imageKind(buffer) === null || buffer.length < MIN_IMAGE_BYTES) {
    throw new Error(`下载内容不是合法背景图（${buffer.length} 字节），已丢弃`);
  }
  await mkdir(BACKGROUND_DIR, { recursive: true });
  const temp = `${MAIMAI_FRAME.target}.tmp`;
  await writeFile(temp, buffer);
  await rename(temp, MAIMAI_FRAME.target);
  await verifyImage(MAIMAI_FRAME.target, 'App 默认 maimai 背景板');
}

async function prepareBackgrounds() {
  // arcaea：优先从同工作区的 App 仓库复制（离线、与 App 完全一致）。
  try {
    if (!force && (await fileSize(ARCAEA_BACKGROUND.target)) > 0) {
      await verifyImage(ARCAEA_BACKGROUND.target, '已有 arcaea 背景');
      log('arcaea 背景已存在，跳过（--force 可强制重建）');
    } else if (!(await copyArcaeaBackground())) {
      warn(`未找到 App 的 arcaea 背景：${ARCAEA_BACKGROUND.source}`);
      warn('可设置 RANKHUB_APP_DIR 指向 RankHub 仓库根目录；缺失时 arcaea 卡使用纯色兜底。');
    }
  } catch (error) {
    warn(`arcaea 背景准备失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }

  // maimai：App 的默认背景板来自 lxns 资源站（与 App 同一个 URL / 同一个 id）。
  try {
    if (!force && (await fileSize(MAIMAI_FRAME.target)) > 0) {
      await verifyImage(MAIMAI_FRAME.target, '已有 maimai 背景');
      log('maimai 背景已存在，跳过（--force 可强制重建）');
    } else {
      await downloadMaimaiFrame();
    }
  } catch (error) {
    warn(`maimai 背景准备失败：${error instanceof Error ? error.message : String(error)}`);
    warn('缺失时 maimai 卡使用纯色兜底（App 在未同步背景板时也是纯色）。');
    process.exitCode = 1;
  }

  log('phigros 没有默认背景（App 未选曲绘时用 grey900 纯色），曲绘由调用方传入，跳过。');
}

async function main() {
  await prepareFont();
  await prepareBackgrounds();
}

await main();
