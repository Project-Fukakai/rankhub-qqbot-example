/**
 * `/me` 玩家名片渲染测试。
 *
 * 不依赖 `vendor/` 素材：占位 banner/头像/图标/背景/二维码全部由 @napi-rs/canvas 现场生成，
 * 因此新克隆 / CI 上没有 `node scripts/fetch-assets-*` 也能跑。
 * 唯一外部依赖是本机 Chromium（playwright 缓存或 RENDER_BROWSER_PATH），与 phi/maimai 渲染测试一致。
 *
 * 产物写入 `test/render/__out__/`（已 gitignore），其中 `card-reference.png` 是完整版式的人工对照图。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CARD_WIDTH,
  buildCardHtml,
  createPlayerCardRenderer,
  imageMimeType,
  toDataUrl,
  type PlayerCardInput,
  type PlayerCardRenderer,
} from '../../src/render/card/index.js';
import {
  buildFullCardInput,
  buildLongTextCardInput,
  buildMinimalCardInput,
  buildSparseCardInput,
} from './card-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(REPO_ROOT, 'test', 'render', '__out__');
const REFERENCE_PATH = join(OUT_DIR, 'card-reference.png');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG IHDR 宽高（不引入 sharp 等图像库）。 */
function readPngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`不是 PNG：前 8 字节 ${buffer.subarray(0, 8).toString('hex')}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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

describe('名片渲染（/me player card）', () => {
  beforeAll(async () => {
    await mkdir(OUT_DIR, { recursive: true });
    renderer = createPlayerCardRenderer();
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
    renderer = null;
  });

  it('完整素材：PNG 宽 1200、体积 > 20KB，并写出 card-reference.png', async () => {
    const { png, size, result } = await render(buildFullCardInput());

    // 验收：固定 1200 宽、高度随内容自适应。
    expect(size.width).toBe(CARD_WIDTH);
    expect(size.width).toBe(1200);
    expect(size.height).toBeGreaterThan(1200);
    expect(png.length).toBeGreaterThan(20 * 1024);
    expect(result.width).toBe(size.width);
    expect(result.height).toBe(size.height);

    // 素材全部真正用上（banner / 头像 / 3 个图标 / 3 张卡片 / 9 个字段 / 二维码）。
    expect(result.summary).toEqual({
      hasBanner: true,
      hasAvatar: true,
      hasQr: true,
      games: 3,
      cards: 3,
      fields: 9,
    });
    // 版式没有横向溢出（body 固定 1200，超长元素应被截断而不是撑宽）。
    expect(result.diagnostics.scrollWidth).toBeLessThanOrEqual(CARD_WIDTH);
    expect(result.diagnostics.clientWidth).toBe(CARD_WIDTH);
    // 若有展示字体，data: URL 注入必须真的加载成功（不然数字会静默回退系统字体）。
    if (result.diagnostics.displayFont) {
      expect(result.diagnostics.fontsReady).toBe(true);
    }
    // HTML 里不应残留未替换的占位符或对象字符串。
    expect(result.html).not.toContain('undefined');
    expect(result.html).not.toContain('[object Object]');
    expect(result.html).toContain('data:image/png;base64,');

    await writeFile(REFERENCE_PATH, png);
  }, 90_000);

  it('无任何可选素材（无 banner/头像/卡片/二维码）：仍能渲染出 1200 宽 PNG', async () => {
    const { png, size, result } = await render(buildMinimalCardInput());

    expect(size.width).toBe(CARD_WIDTH);
    expect(size.height).toBeGreaterThan(0);
    expect(png.length).toBeGreaterThan(0);
    expect(result.summary).toEqual({
      hasBanner: false,
      hasAvatar: false,
      hasQr: false,
      games: 0,
      cards: 0,
      fields: 0,
    });
    // 空状态文案存在，说明走的是正常版式而不是报错页。
    expect(result.html).toContain('还没有公开的游戏档案');
    expect(result.html).not.toContain('undefined');

    await writeFile(join(OUT_DIR, 'card-minimal.png'), png);
  }, 90_000);

  it('缺可选素材但有卡片：rating 为 null 显示 —，无背景/头像也能排版', async () => {
    const { png, size, result } = await render(buildSparseCardInput());

    expect(size.width).toBe(CARD_WIDTH);
    expect(png.length).toBeGreaterThan(0);
    expect(result.summary.hasAvatar).toBe(false);
    expect(result.summary.hasBanner).toBe(false);
    expect(result.summary.cards).toBe(1);
    expect(result.summary.fields).toBe(0);
    // rating 缺失的兜底文案 + 用标题占位符替代游戏头像。
    expect(result.html).toContain('—');
    expect(result.html).toContain('game-avatar-fallback');
    expect(result.diagnostics.scrollWidth).toBeLessThanOrEqual(CARD_WIDTH);

    await writeFile(join(OUT_DIR, 'card-sparse.png'), png);
  }, 90_000);

  it('公开 API：renderPlayerCard 直接返回 PNG Buffer', async () => {
    if (!renderer) throw new Error('渲染器未初始化');
    const png = await renderer.renderPlayerCard(buildMinimalCardInput());

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(readPngSize(png).width).toBe(CARD_WIDTH);
  }, 90_000);

  it('超长昵称/bio/字段：横向不溢出，宽度仍是 1200', async () => {
    const { png, size, result } = await render(buildLongTextCardInput());

    expect(size.width).toBe(CARD_WIDTH);
    expect(png.length).toBeGreaterThan(0);
    expect(result.diagnostics.scrollWidth).toBeLessThanOrEqual(CARD_WIDTH);
    expect(result.diagnostics.clientWidth).toBe(CARD_WIDTH);
  }, 90_000);

  it('超过 maxImageBytes 时降级 JPEG（QQ 5MB 上限的兜底）', async () => {
    const tiny = createPlayerCardRenderer({ maxImageBytes: 10_000 });
    try {
      const result = await tiny.renderPlayerCardDetail(buildFullCardInput());
      expect(result.format).toBe('jpeg');
      // JPEG SOI 魔数 + 尺寸仍是 1200 宽（SOF 段解析交给 phi 测试的同类工具，这里只校验签名与体积）。
      expect(result.buffer[0]).toBe(0xff);
      expect(result.buffer[1]).toBe(0xd8);
      expect(result.width).toBe(CARD_WIDTH);
      expect(result.buffer.length).toBeLessThan(4.5 * 1024 * 1024);
    } finally {
      await tiny.close();
    }
  }, 90_000);

  it('并发渲染：两个页面同时截图互不影响', async () => {
    const [full, minimal] = await Promise.all([
      render(buildFullCardInput()),
      render(buildMinimalCardInput()),
    ]);
    expect(full.size.width).toBe(CARD_WIDTH);
    expect(minimal.size.width).toBe(CARD_WIDTH);
    expect(full.size.height).not.toBe(minimal.size.height);
  }, 120_000);
});

describe('名片 HTML 生成（纯函数，不需要浏览器）', () => {
  it('转义用户输入、截断字段数量、空图标回退占位符', () => {
    const { html, summary } = buildCardHtml({
      displayName: '<script>alert(1)</script>',
      uid: '"><img src=x onerror=1>',
      bio: 'bio',
      games: [{ name: '<b>mai</b>', icon: Buffer.alloc(0) }],
      cards: [
        {
          game: 'maimai',
          title: '<i>x</i>',
          rating: null,
          fields: Array.from({ length: 8 }, (_, index) => ({
            label: `L${index}`,
            value: `V${index}`,
          })),
        },
      ],
    });

    // 注入内容只作为文本出现，不产生真实标签。
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).not.toContain('<img src=x');
    // 字段最多 4 个；空 Buffer 图标回退到首字母占位。
    expect(summary.fields).toBe(4);
    expect(html).toContain('strip-icon-fallback');
    // 所有素材都是空 Buffer → 不产生任何 data URL（也不会出现半截 src=""）。
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('src=""');
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
});
