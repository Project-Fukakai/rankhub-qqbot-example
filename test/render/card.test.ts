/**
 * `/me` 玩家名片 v2 渲染测试（三张卡 1:1 对齐 App「我的」页）。
 *
 * 不依赖网络：占位 banner/头像/曲绘/立绘/图标/二维码全部由 @napi-rs/canvas 现场生成；
 * 静态素材从 `vendor/card/**` 读取（缺失时渲染器降级，测试另有空素材目录用例）。
 * 唯一外部依赖是本机 Chromium（playwright 缓存或 RENDER_BROWSER_PATH），与 phi/maimai 渲染测试一致。
 *
 * 产物：
 * - `test/render/__out__/*.png`（已 gitignore，便于人工对照）；
 * - `../../RankHubWorkspace/evidence/qqbot/card-v2/{maimai,phigros,arcaea,me,me-sparse}.png`（工作区证据）；
 * - `docs/images/me-card.png`（README 展示图，整张 /me）。
 */
import { existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CARD_CONTENT_WIDTH,
  CARD_HEIGHT,
  CARD_WIDTH,
  PHIGROS_DIFFICULTY_COLORS,
  arcaeaPttStrokeColor,
  arcaeaRatingIndex,
  buildCardHtml,
  buildGameCardHtml,
  createPlayerCardRenderer,
  formatSyncTime,
  imageMimeType,
  maimaiDxAssetIndex,
  toDataUrl,
  type PhigrosDifficulty,
  type PlayerCardInput,
  type PlayerCardRenderer,
} from '../../src/render/card/index.js';
import {
  FIXTURE_SYNCED_AT,
  FIXTURE_SYNCED_DISPLAY,
  arcaeaCard,
  buildFullCardInput,
  buildLongTextCardInput,
  buildMaimaiFrameCard,
  buildMinimalCardInput,
  buildPhigrosDifficultyCard,
  buildSparseCardInput,
  customArcaeaArtwork,
  customArcaeaAvatar,
  customMaimaiFrame,
  customPhigrosCover,
  maimaiCard,
  phigrosCard,
} from './card-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(REPO_ROOT, 'test', 'render', '__out__');
const REPO_DOCS_IMAGE = join(REPO_ROOT, 'docs', 'images', 'me-card.png');
/** 工作区证据目录：`rankhub-qqbot/../../RankHubWorkspace/evidence/qqbot/card-v2`。 */
const EVIDENCE_DIR = resolve(
  REPO_ROOT,
  '..',
  '..',
  'RankHubWorkspace',
  'evidence',
  'qqbot',
  'card-v2',
);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG IHDR 宽高（不引入 sharp 等图像库）。 */
function readPngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`不是 PNG：前 8 字节 ${buffer.subarray(0, 8).toString('hex')}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 写证据图：工作区不存在时跳过（CI / 单独 clone 仓库时也不失败）。 */
async function writeEvidence(name: string, buffer: Buffer): Promise<string | null> {
  try {
    const workspaceRoot = resolve(REPO_ROOT, '..', '..', 'RankHubWorkspace');
    if (!existsSync(workspaceRoot)) return null;
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const path = join(EVIDENCE_DIR, name);
    await writeFile(path, buffer);
    return path;
  } catch {
    return null;
  }
}

/** 取 PNG 中指定矩形区域的平均颜色（@napi-rs/canvas 解码，不引图像库）。 */
async function averageColor(
  png: Buffer,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<[number, number, number]> {
  const image = await loadImage(png);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, x, y, width, height, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = width * height;
  for (let index = 0; index < data.length; index += 4) {
    r += data[index] ?? 0;
    g += data[index + 1] ?? 0;
    b += data[index + 2] ?? 0;
  }
  return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
}

/** 两个 RGB 颜色的欧氏距离（0..441），用于「自定义素材确实改变了画面」的确定性断言。 */
function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

async function render(input: PlayerCardInput): Promise<{
  png: Buffer;
  size: { width: number; height: number };
  result: Awaited<ReturnType<PlayerCardRenderer['renderPlayerCardDetail']>>;
}> {
  if (!renderer) throw new Error('渲染器未初始化');
  const result = await renderer.renderPlayerCardDetail(input);
  expect(result.format).toBe('png');
  return { png: result.buffer, size: readPngSize(result.buffer), result };
}

let renderer: PlayerCardRenderer | null = null;

describe('名片渲染（/me player card v2）', () => {
  beforeAll(async () => {
    await mkdir(OUT_DIR, { recursive: true });
    renderer = createPlayerCardRenderer();
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
    renderer = null;
  });

  it('完整素材：三张卡各 1120×448（5:2），输出整张 /me 与证据图', async () => {
    const { png, size, result } = await render(buildFullCardInput());

    // 页面固定 1200 宽；卡片内容宽 1120、单卡 1120×448。
    expect(size.width).toBe(CARD_WIDTH);
    expect(size.width).toBe(1200);
    expect(size.height).toBeGreaterThan(1200);
    expect(png.length).toBeGreaterThan(20 * 1024);

    // 三张卡都在，且实测几何严格 5:2。
    expect(result.summary.cardsByGame).toEqual(['maimai', 'phigros', 'arcaea']);
    expect(result.summary.cards).toBe(3);
    expect(result.summary.games).toBe(3);
    expect(result.summary.hasBanner).toBe(true);
    expect(result.summary.hasAvatar).toBe(true);
    expect(result.summary.hasQr).toBe(true);
    expect(result.diagnostics.cardRects).toHaveLength(3);
    for (const rect of result.diagnostics.cardRects) {
      expect(rect.width).toBe(CARD_CONTENT_WIDTH);
      expect(rect.height).toBe(CARD_HEIGHT);
      expect(rect.width / rect.height).toBeCloseTo(2.5, 6);
    }
    // 横向不溢出：长元素被截断/缩放而不是把页面撑宽。
    expect(result.diagnostics.scrollWidth).toBeLessThanOrEqual(CARD_WIDTH);
    expect(result.diagnostics.clientWidth).toBe(CARD_WIDTH);

    // ── maimai（PlayerInfoCard）结构 ──
    expect(result.html).toContain('data-game="maimai"');
    expect(result.html).toContain('class="m-overlay"');
    expect(result.html).toContain('class="m-name fit-box"');
    expect(result.html).toContain('往期版本 B35');
    expect(result.html).toContain('当期版本 B15');
    expect(result.html).toContain('14980');
    expect(result.html).toContain('15080');
    // 15023 → 徽章第 11 档 + 5 个数字字形（App `_assetIndex`）。
    expect(result.html.match(/class="m-digit"/g)).toHaveLength(5);
    expect(result.usedStaticAssets).toEqual(
      expect.arrayContaining([
        'bg:maimai',
        'maimai:rating:11',
        'maimai:num:1',
        'maimai:num:5',
        'maimai:num:0',
        'maimai:num:2',
        'maimai:num:3',
      ]),
    );
    expect(result.html).toContain(FIXTURE_SYNCED_DISPLAY);

    // ── phigros（PhigrosPlayerCard）结构 ──
    expect(result.html).toContain('data-game="phigros"');
    expect(result.html).toContain('class="p-header"');
    expect(result.html).toContain('class="p-panel"');
    expect(result.html).toContain('class="p-challenge"'); // 课题模式 415 → 4 段位 + 15
    expect(result.html).toContain('class="p-rks"');
    expect(result.html).toContain('15.4321');
    expect(result.html).toContain('class="p-stats"');
    expect(result.html).toContain('CLEAR');
    expect(result.html).toContain('FC');
    expect(result.html).toContain('PHI');
    expect(result.html).toContain('98');
    expect(result.html).toContain('64');
    // 难度平行四边形：IN 的 App 颜色 #F44336。
    expect(result.html).toContain('data-difficulty="IN"');
    expect(result.html).toContain(PHIGROS_DIFFICULTY_COLORS.IN);
    expect(result.usedStaticAssets).toContain('phigros:badge:4');

    // ── arcaea（ArcaeaPlayerInfoCard）结构 ──
    expect(result.html).toContain('data-game="arcaea"');
    expect(result.html).toContain('class="a-hidden"');
    expect(result.html).toContain('class="a-banner"');
    expect(result.html).toContain('class="a-char"');
    expect(result.html).toContain('class="a-avatar"');
    expect(result.html).toContain('class="a-ptt"');
    expect(result.html).toContain('B50 Avg');
    expect(result.html).toContain('B10 Avg');
    expect(result.html).toContain('12.10');
    expect(result.html).toContain('11.98');
    expect(result.usedStaticAssets).toEqual(
      expect.arrayContaining([
        'arcaea:bg',
        'arcaea:hidden',
        'arcaea:banner',
        'arcaea:rating:5', // PTT 12.34 → 第 5 档
      ]),
    );

    // 素材齐全时不应有缺失；字体（Saira/Orbitron）真的加载成功。
    expect(result.missingStaticAssets).toEqual([]);
    expect(result.diagnostics.fontFamilies).toEqual(
      expect.arrayContaining(['Saira', 'Orbitron']),
    );
    if (result.diagnostics.fontFamilies.length > 0) {
      expect(result.diagnostics.fontsReady).toBe(true);
    }

    // HTML 里没有未替换的占位符/对象字符串。
    expect(result.html).not.toContain('undefined');
    expect(result.html).not.toContain('[object Object]');
    expect(result.html).toContain('data:image/png;base64,');

    await writeFile(join(OUT_DIR, 'card-v2-full.png'), png);
    await writeFile(REPO_DOCS_IMAGE, png);
    await writeEvidence('me.png', png);
  }, 120_000);

  it('单卡导出：maimai / phigros / arcaea 各自 1120×448，并写入证据目录', async () => {
    if (!renderer) throw new Error('渲染器未初始化');
    const cases = [
      { game: 'maimai', card: maimaiCard() },
      { game: 'phigros', card: phigrosCard() },
      { game: 'arcaea', card: arcaeaCard() },
    ] as const;
    for (const item of cases) {
      const result = await renderer.renderGameCardDetail(item.card);
      expect(result.format).toBe('png');
      const size = readPngSize(result.buffer);
      expect(size).toEqual({ width: CARD_CONTENT_WIDTH, height: CARD_HEIGHT });
      expect(result.diagnostics.cardRects).toHaveLength(1);
      const rect = result.diagnostics.cardRects[0];
      expect(rect).toMatchObject({
        game: item.game,
        width: CARD_CONTENT_WIDTH,
        height: CARD_HEIGHT,
      });
      // 每张卡都用了自己的静态素材，不是只剩纯色底。
      expect(result.usedStaticAssets.length).toBeGreaterThan(0);
      await writeFile(join(OUT_DIR, `card-v2-${item.game}.png`), result.buffer);
      await writeEvidence(`${item.game}.png`, result.buffer);
      // 单卡 HTML 里只应出现一个游戏卡容器。
      expect(result.html.match(/data-game=/g)).toHaveLength(1);
    }
  }, 180_000);

  it('自定义素材（frame/曲绘/立绘/头像）真的覆盖默认：抽样像素与 PNG 字节均不同', async () => {
    if (!renderer) throw new Error('渲染器未初始化');

    const expectSingleCard = (result: Awaited<ReturnType<PlayerCardRenderer['renderGameCardDetail']>>, game: string): void => {
      expect(result.summary.cards).toBe(1);
      expect(result.summary.cardsByGame).toEqual([game]);
      expect(result.diagnostics.cardRects).toHaveLength(1);
      expect(result.diagnostics.cardRects[0]).toMatchObject({
        game,
        width: CARD_CONTENT_WIDTH,
        height: CARD_HEIGHT,
      });
      expect(readPngSize(result.buffer)).toEqual({
        width: CARD_CONTENT_WIDTH,
        height: CARD_HEIGHT,
      });
    };

    // ── maimai：自定义 frame vs 默认背景板（vendor 存在）或纯色兜底 ──
    const maimaiBase = await renderer.renderGameCardDetail(maimaiCard({ frame: null }));
    const maimaiCustom = await renderer.renderGameCardDetail(
      maimaiCard({ frame: customMaimaiFrame() }),
    );
    expectSingleCard(maimaiBase, 'maimai');
    expectSingleCard(maimaiCustom, 'maimai');
    expect(maimaiCustom.html).toContain('class="m-bg"');
    expect(maimaiCustom.usedStaticAssets).not.toContain('bg:maimai');
    expect(maimaiCustom.buffer.equals(maimaiBase.buffer)).toBe(false);
    const maimaiBaseColor = await averageColor(maimaiBase.buffer, 560, 12, 120, 50);
    const maimaiCustomColor = await averageColor(maimaiCustom.buffer, 560, 12, 120, 50);
    expect(colorDistance(maimaiCustomColor, maimaiBaseColor)).toBeGreaterThan(30);
    await writeEvidence('custom-maimai.png', maimaiCustom.buffer);

    // ── phigros：自定义曲绘 vs 无曲绘（App grey900 纯色） ──
    const phigrosBase = await renderer.renderGameCardDetail(phigrosCard({ background: null }));
    const phigrosCustom = await renderer.renderGameCardDetail(
      phigrosCard({ background: customPhigrosCover() }),
    );
    expectSingleCard(phigrosBase, 'phigros');
    expectSingleCard(phigrosCustom, 'phigros');
    expect(phigrosCustom.html).toContain('class="p-bg"');
    expect(phigrosBase.html).toContain('class="p-bg-fallback"');
    expect(phigrosCustom.buffer.equals(phigrosBase.buffer)).toBe(false);
    const phigrosBaseColor = await averageColor(phigrosBase.buffer, 60, 200, 120, 60);
    const phigrosCustomColor = await averageColor(phigrosCustom.buffer, 60, 200, 120, 60);
    expect(colorDistance(phigrosCustomColor, phigrosBaseColor)).toBeGreaterThan(30);
    await writeEvidence('custom-phigros.png', phigrosCustom.buffer);

    // ── arcaea：自定义立绘 + 头像（名片板） vs 无立绘/头像占位 ──
    const arcaeaBase = await renderer.renderGameCardDetail(
      arcaeaCard({ avatar: null, characterArtwork: null }),
    );
    const arcaeaCustom = await renderer.renderGameCardDetail(
      arcaeaCard({
        avatar: customArcaeaAvatar(),
        characterArtwork: customArcaeaArtwork(),
      }),
    );
    expectSingleCard(arcaeaBase, 'arcaea');
    expectSingleCard(arcaeaCustom, 'arcaea');
    expect(arcaeaCustom.html).toContain('class="a-char"');
    expect(arcaeaCustom.html).toContain('class="a-avatar"');
    expect(arcaeaBase.html).not.toContain('class="a-char"');
    expect(arcaeaBase.html).toContain('a-avatar-fallback');
    expect(arcaeaCustom.buffer.equals(arcaeaBase.buffer)).toBe(false);
    // 立绘区域（左下）与头像区域（右上，banner 右侧）都要有可见差异。
    const arcaeaBaseArt = await averageColor(arcaeaBase.buffer, 120, 250, 120, 60);
    const arcaeaCustomArt = await averageColor(arcaeaCustom.buffer, 120, 250, 120, 60);
    expect(colorDistance(arcaeaCustomArt, arcaeaBaseArt)).toBeGreaterThan(30);
    const arcaeaBaseAvatar = await averageColor(arcaeaBase.buffer, 700, 16, 40, 30);
    const arcaeaCustomAvatar = await averageColor(arcaeaCustom.buffer, 700, 16, 40, 30);
    expect(colorDistance(arcaeaCustomAvatar, arcaeaBaseAvatar)).toBeGreaterThan(30);
    await writeEvidence('custom-arcaea.png', arcaeaCustom.buffer);
  }, 180_000);

  it('无任何可选素材（无 banner/头像/卡片/二维码）：仍输出 1200 宽 PNG', async () => {
    const { png, size, result } = await render(buildMinimalCardInput());

    expect(size.width).toBe(CARD_WIDTH);
    expect(size.height).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({
      hasBanner: false,
      hasAvatar: false,
      hasQr: false,
      games: 0,
      cards: 0,
      cardsByGame: [],
    });
    // 空状态 + App 的兜底文案。
    expect(result.html).toContain('还没有公开的游戏档案');
    expect(result.html).toContain('UID 暂不可用');
    expect(result.html).toContain('这个人很神秘，还没有填写个人简介。');
    expect(result.html).not.toContain('undefined');
    // 没有动态图片时不应出现 image data URL（字体是 data:font/*）。
    expect(result.html).not.toContain('data:image');
    expect(result.diagnostics.cardRects).toEqual([]);

    await writeFile(join(OUT_DIR, 'card-v2-minimal.png'), png);
  }, 90_000);

  it('稀疏数据：rating/potential 为 null、无头像/曲绘/立绘 → App 的 -- / 纯色兜底', async () => {
    const { png, size, result } = await render(buildSparseCardInput());

    expect(size.width).toBe(CARD_WIDTH);
    expect(png.length).toBeGreaterThan(0);
    expect(result.summary.cardsByGame).toEqual(['maimai', 'phigros', 'arcaea']);
    expect(result.diagnostics.cardRects).toHaveLength(3);

    // maimai：没有 rating → 不画徽章、文字占位；没有头像 → person 图标。
    expect(result.html).not.toContain('class="m-digit"');
    expect(result.html).toContain('class="m-rating-text"');
    expect(result.html).toContain('person-icon');
    expect(result.html).toContain('>--<');
    // phigros：没有曲绘 → grey900 纯色；课题模式 0 → 不画徽章；AT 黑色。
    expect(result.html).toContain('class="p-bg-fallback"');
    expect(result.html).not.toContain('class="p-challenge"');
    expect(result.html).toContain('data-difficulty="AT"');
    expect(result.html).toContain('#000000');
    // arcaea：没有头像 → 占位；PTT null → 不画徽章；B50/B10 为 --。
    expect(result.html).toContain('a-avatar-fallback');
    expect(result.html).not.toContain('class="a-ptt"');
    expect(result.html).toContain('B50 Avg');
    expect(result.html).toContain('--');
    // 无最近同步时间时只保留「最近同步时间」标签。
    expect(result.html).toContain('最近同步时间');
    expect(result.diagnostics.scrollWidth).toBeLessThanOrEqual(CARD_WIDTH);

    await writeFile(join(OUT_DIR, 'card-v2-sparse.png'), png);
    await writeEvidence('me-sparse.png', png);
  }, 90_000);

  it('静态素材缺失（assetsDir 指向空目录）：降级渲染、不崩溃、诊断出缺失 key', async () => {
    const emptyDir = join(OUT_DIR, 'empty-assets');
    rmSync(emptyDir, { recursive: true, force: true });
    await mkdir(emptyDir, { recursive: true });
    const bare = createPlayerCardRenderer({ assetsDir: emptyDir });
    try {
      const result = await bare.renderPlayerCardDetail(buildFullCardInput());
      const size = readPngSize(result.buffer);
      expect(size.width).toBe(CARD_WIDTH);
      expect(result.diagnostics.cardRects).toHaveLength(3);
      expect(result.summary.usedStaticAssets).toBe(0);
      expect(result.missingStaticAssets.length).toBeGreaterThan(10);
      // 没有徽章/数字素材时 maimai 退回文字 rating；arcaea 背景退回纯色；phigros 徽章不画。
      expect(result.html).not.toContain('class="m-digit"');
      expect(result.html).toContain('class="m-rating-text"');
      expect(result.html).toContain('class="a-bg-fallback"');
      // 课题模式数字仍然显示，只是底图缺失（没有 p-challenge-img）。
      expect(result.html).not.toContain('<img class="p-challenge-img"');
      // 动态图片仍然来自调用方 Buffer（maimai 没有静态背景板 → 纯色兜底）。
      expect(result.html).toContain('class="m-bg-fallback"');
      expect(result.html).toContain('class="p-bg"');
      expect(result.html).not.toContain('undefined');
    } finally {
      await bare.close();
    }
  }, 120_000);

  it('调用方帧图覆盖 App 默认背景板（maimai frame Buffer）', async () => {
    if (!renderer) throw new Error('渲染器未初始化');
    const result = await renderer.renderPlayerCardDetail(buildMaimaiFrameCard());
    expect(result.html).toContain('class="m-bg"');
    // 调用方 frame 优先：静态默认背景板不应被使用。
    expect(result.usedStaticAssets).not.toContain('bg:maimai');
    expect(readPngSize(result.buffer).width).toBe(CARD_WIDTH);
  }, 90_000);

  it('Phigros 四档难度：E/F 颜色严格来自 phigros_record_card.dart 的枚举', () => {
    for (const [difficulty, color] of Object.entries(PHIGROS_DIFFICULTY_COLORS)) {
      const built = buildGameCardHtml(buildPhigrosDifficultyCard(difficulty as PhigrosDifficulty).cards[0]!);
      expect(built.html).toContain(`data-difficulty="${difficulty}"`);
      expect(built.html).toContain(color);
    }
    expect(PHIGROS_DIFFICULTY_COLORS).toEqual({
      EZ: '#4CAF50',
      HD: '#2196F3',
      IN: '#F44336',
      AT: '#000000',
    });
  });

  it('公开 API：renderPlayerCard 直接返回 PNG Buffer', async () => {
    if (!renderer) throw new Error('渲染器未初始化');
    const png = await renderer.renderPlayerCard(buildMinimalCardInput());

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(readPngSize(png).width).toBe(CARD_WIDTH);
  }, 90_000);

  it('超长昵称/bio：横向不溢出，宽度仍是 1200，名字被缩放而不是撑破卡片', async () => {
    const { png, size, result } = await render(buildLongTextCardInput());

    expect(size.width).toBe(CARD_WIDTH);
    expect(png.length).toBeGreaterThan(0);
    expect(result.diagnostics.scrollWidth).toBeLessThanOrEqual(CARD_WIDTH);
    expect(result.diagnostics.clientWidth).toBe(CARD_WIDTH);
    expect(result.diagnostics.cardRects).toHaveLength(3);
    // FittedBox 等价缩放：每张卡都有自己的 data-fit 文本节点。
    expect(result.html).toContain('data-fit-origin="left"');
    expect(result.html).toContain('class="fit-text"');
  }, 90_000);

  it('超过 maxImageBytes 时降级 JPEG（QQ 5MB 上限的兜底）', async () => {
    const tiny = createPlayerCardRenderer({ maxImageBytes: 10_000 });
    try {
      const result = await tiny.renderPlayerCardDetail(buildFullCardInput());
      expect(result.format).toBe('jpeg');
      expect(result.buffer[0]).toBe(0xff);
      expect(result.buffer[1]).toBe(0xd8);
      expect(result.width).toBe(CARD_WIDTH);
      expect(result.buffer.length).toBeLessThan(4.5 * 1024 * 1024);
    } finally {
      await tiny.close();
    }
  }, 120_000);

  it('并发渲染：两个页面同时截图互不影响', async () => {
    const [full, minimal] = await Promise.all([
      render(buildFullCardInput()),
      render(buildMinimalCardInput()),
    ]);
    expect(full.size.width).toBe(CARD_WIDTH);
    expect(minimal.size.width).toBe(CARD_WIDTH);
    expect(full.size.height).not.toBe(minimal.size.height);
  }, 150_000);
});

describe('名片 HTML 生成（纯函数，不需要浏览器）', () => {
  it('转义用户输入、三张卡结构齐全、动态素材走 data URL', () => {
    const input: PlayerCardInput = {
      displayName: '<script>alert(1)</script>',
      uid: '"><img src=x onerror=1>',
      bio: 'bio',
      games: [{ name: '<b>mai</b>', icon: Buffer.alloc(0) }],
      cards: [
        maimaiCard({ name: '<i>x</i>', avatar: null }),
        phigrosCard({ name: '<i>y</i>', avatar: null }),
        arcaeaCard({ name: '<i>z</i>', avatar: null }),
      ],
    };
    const built = buildCardHtml(input);

    // 注入内容只作为文本出现，不产生真实标签。
    expect(built.html).not.toContain('<script>alert');
    expect(built.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(built.html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(built.html).not.toContain('<img src=x');
    expect(built.summary.cardsByGame).toEqual(['maimai', 'phigros', 'arcaea']);
    // 空 Buffer 图标回退到首字母占位。
    expect(built.html).toContain('strip-icon-fallback');
    // 三张卡的关键结构都在。
    expect(built.html).toContain('class="m-name fit-box"');
    expect(built.html).toContain('class="p-header"');
    expect(built.html).toContain('class="a-avatar"');
    // 没有静态素材时不应该有半截 src=""/undefined。
    expect(built.html).not.toContain('src=""');
    expect(built.html).not.toContain('undefined');
    // 纯函数不传 images：静态素材全部记为缺失。
    expect(built.summary.usedStaticAssets).toBe(0);
    expect(built.summary.missingStaticAssets).toBeGreaterThan(0);
  });

  it('静态素材通过 key 注入后真实出现在 HTML（data URL）', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const dataUrl = toDataUrl(png) as string;
    const built = buildGameCardHtml(arcaeaCard(), {
      images: {
        'arcaea:bg': dataUrl,
        'arcaea:hidden': dataUrl,
        'arcaea:banner': dataUrl,
        'arcaea:rating:5': dataUrl,
      },
    });
    expect(built.html).toContain('class="a-bg"');
    expect(built.html).toContain('class="a-hidden"');
    expect(built.html).toContain('class="a-banner"');
    expect(built.html).toContain('class="a-ptt"');
    expect(built.usedStaticAssets).toEqual(
      expect.arrayContaining(['arcaea:bg', 'arcaea:hidden', 'arcaea:banner', 'arcaea:rating:5']),
    );
  });

  it('图片 MIME 嗅探与空素材处理', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const gif = Buffer.from('GIF89a', 'ascii');
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBPVP8 ', 'ascii'),
    ]);

    expect(imageMimeType(png)).toBe('image/png');
    expect(imageMimeType(jpeg)).toBe('image/jpeg');
    expect(imageMimeType(gif)).toBe('image/gif');
    expect(imageMimeType(webp)).toBe('image/webp');
    expect(imageMimeType(Buffer.from('unknown', 'ascii'))).toBe('image/png');

    expect(toDataUrl(png)).toMatch(/^data:image\/png;base64,/);
    expect(toDataUrl(Buffer.alloc(0))).toBeNull();
    expect(toDataUrl(null)).toBeNull();
    expect(toDataUrl(undefined)).toBeNull();
  });

  it('App 常量映射：maimai 徽章档位 / arcaea PTT 档位与描边色 / 同步时间格式', () => {
    // player_info_card.dart:473-486
    expect(maimaiDxAssetIndex(0)).toBe(1);
    expect(maimaiDxAssetIndex(999)).toBe(1);
    expect(maimaiDxAssetIndex(15023)).toBe(11);
    expect(maimaiDxAssetIndex(15999)).toBe(11);
    expect(maimaiDxAssetIndex(16000)).toBe(12);
    // arcaea_views.dart:1746-1756
    expect(arcaeaRatingIndex(0)).toBe(0);
    expect(arcaeaRatingIndex(3.49)).toBe(0);
    expect(arcaeaRatingIndex(10)).toBe(3);
    expect(arcaeaRatingIndex(12.34)).toBe(5);
    expect(arcaeaRatingIndex(13)).toBe(7);
    // 描边色 = 徽章主色向黑 lerp 0.65。
    expect(arcaeaPttStrokeColor(0)).toBe('#12121C');
    expect(arcaeaPttStrokeColor(7)).toBe('#432B36');
    // UTC → Asia/Shanghai 的 yyyy-MM-dd HH:mm（App `DateFormat`）。
    expect(formatSyncTime(FIXTURE_SYNCED_AT)).toBe(FIXTURE_SYNCED_DISPLAY);
    expect(formatSyncTime(null)).toBeNull();
    expect(formatSyncTime('not-a-date')).toBeNull();
  });
});
