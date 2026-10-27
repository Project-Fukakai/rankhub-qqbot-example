#!/usr/bin/env node
/**
 * 准备 `/me` 名片渲染的**可选**素材（幂等，可重复执行）：
 * 把数字/字母展示字体 Aldrich 放到 `vendor/card/fonts/Aldrich-Regular.ttf`。
 *
 * 为什么需要它：
 * - 名片渲染器本身不依赖 vendor 素材：字体缺失时回退系统字体（macOS PingFang SC、
 *   Docker 镜像里的 fonts-noto-cjk），渲染照常工作；有 Aldrich 时 rating / 字段数字
 *   会使用统一的几何显示字体，跨平台观感一致。
 *
 * 素材来源（按优先级，全程不发请求就能完成）：
 * 1. 已经存在 `vendor/card/fonts/Aldrich-Regular.ttf` → 直接复用（--force 可覆盖）；
 * 2. 本仓库 phi-plugin 快照里的 `vendor/phi/resources/html/common/font/Aldrich-Regular.ttf`
 *    → 本地复制（推荐路径，完全不触网）；
 * 3. 固定 URL 下载 Google Fonts 的 Aldrich（OFL-1.1）→ 校验 TTF magic 与大小后落盘。
 *
 * 用法：
 *   node scripts/fetch-assets-card.mjs          # 准备字体（已有则跳过）
 *   node scripts/fetch-assets-card.mjs --force  # 覆盖重建
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD_FONT_DIR = join(ROOT, 'vendor', 'card', 'fonts');
const TARGET = join(CARD_FONT_DIR, 'Aldrich-Regular.ttf');
const PHI_FONT = join(ROOT, 'vendor', 'phi', 'resources', 'html', 'common', 'font', 'Aldrich-Regular.ttf');
/** Google Fonts 仓库里的 Aldrich（OFL-1.1），固定分支 + 固定路径，便于追溯。 */
const ALDRICH_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/aldrich/Aldrich-Regular.ttf';
/** 字体下界：低于这个大小基本是错误页/HTML，而不是字体。 */
const MIN_FONT_BYTES = 10 * 1024;

const force = process.argv.includes('--force');

function log(message) {
  console.log(`[assets:card] ${message}`);
}

/** TrueType / OpenType 文件头校验（0x00010000 / 'true' / 'OTTO' / 'ttcf'）。 */
function looksLikeFont(buffer) {
  if (buffer.length < 4) return false;
  const magic = buffer.readUInt32BE(0);
  if (magic === 0x00010000) return true;
  const tag = buffer.toString('ascii', 0, 4);
  return tag === 'true' || tag === 'OTTO' || tag === 'ttcf';
}

async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function verify(path, label) {
  const size = await fileSize(path);
  if (size < MIN_FONT_BYTES) {
    throw new Error(`${label} 体积异常（${size} 字节）：${path}`);
  }
  const buffer = await readFile(path);
  if (!looksLikeFont(buffer)) {
    throw new Error(`${label} 不是合法的 TTF/OTF：${path}`);
  }
  log(`已就绪：${path}（${(size / 1024).toFixed(1)} KB）`);
}

async function copyFromPhi() {
  if (!existsSync(PHI_FONT)) return false;
  await mkdir(CARD_FONT_DIR, { recursive: true });
  // 先写临时文件再 rename，避免中断留下半截字体。
  const temp = `${TARGET}.tmp`;
  await copyFile(PHI_FONT, temp);
  await rename(temp, TARGET);
  await verify(TARGET, '复制自 phi-plugin 的字体');
  return true;
}

async function download() {
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
  const temp = `${TARGET}.tmp`;
  await writeFile(temp, buffer);
  await rename(temp, TARGET);
  await verify(TARGET, '下载的字体');
}

async function main() {
  if (!force && (await fileSize(TARGET)) > 0) {
    await verify(TARGET, '已有字体');
    log('跳过（--force 可强制重建）');
    return;
  }

  try {
    if (await copyFromPhi()) return;
    await download();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[assets:card] 未能准备展示字体：${message}`);
    console.error('[assets:card] 这不影响渲染：名片会回退系统字体（PingFang SC / Noto Sans CJK）。');
    console.error('[assets:card] 离线环境可先执行 `node scripts/fetch-assets-phi.mjs`，再重跑本脚本。');
    process.exitCode = 1;
  }
}

await main();
