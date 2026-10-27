/**
 * 移植 maimaiDX 的文字绘制原语（core/image/base.py + core/image/tools.py）。
 *
 * 关键点：PIL 的 anchor 与 Canvas 的 textAlign/textBaseline 一一对应，
 * 实测（24px FOT-NewRodin / 20px SIYUAN）墨迹包围盒差异 ≤1px：
 *   PIL 'mm' ≡ ctx.textAlign='center' + ctx.textBaseline='middle'
 *   PIL 'lm' ≡ 'left'   + 'middle'
 *   PIL 'lt' ≡ 'left'   + 'top'
 * PIL 的 stroke_width 是「向四周膨胀 N px」，对应 Canvas 的 lineWidth = 2N。
 */
import type { SKRSContext2D } from '@napi-rs/canvas';

export type FontFamily = 'SIYUAN' | 'TBFONT' | 'FOTNEWRODIN' | 'SHANGGUMONO';

export type TextAnchor = 'lt' | 'lm' | 'lb' | 'mt' | 'mm' | 'mb' | 'rt' | 'rm' | 'rb';

const H_ALIGN: Record<string, CanvasTextAlign> = { l: 'left', m: 'center', r: 'right' };
const V_ALIGN: Record<string, CanvasTextBaseline> = { t: 'top', m: 'middle', b: 'bottom' };

export interface DrawTextOptions {
  family: FontFamily;
  size: number;
  x: number;
  y: number;
  text: string;
  color: string;
  anchor?: TextAnchor;
  strokeWidth?: number;
  strokeFill?: string;
}

/** 等价 PIL ImageDraw.text + ImageFont.truetype(font, size)。 */
export function drawText(ctx: SKRSContext2D, opts: DrawTextOptions): void {
  const { family, size, x, y, text, color, anchor = 'lt' } = opts;
  const h = anchor[0] ?? 'l';
  const v = anchor[1] ?? 't';
  ctx.save();
  ctx.font = `${size}px "${family}"`;
  ctx.textAlign = H_ALIGN[h] ?? 'left';
  ctx.textBaseline = V_ALIGN[v] ?? 'top';
  ctx.fillStyle = color;
  if (opts.strokeWidth && opts.strokeWidth > 0) {
    ctx.strokeStyle = opts.strokeFill ?? 'rgba(0,0,0,0)';
    ctx.lineWidth = opts.strokeWidth * 2;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** 测量文字宽度（PIL 用 font.getbbox 的 x1-x0；这里用 Canvas 的 advance width）。 */
export function measureText(
  ctx: SKRSContext2D,
  family: FontFamily,
  size: number,
  text: string,
): number {
  ctx.save();
  ctx.font = `${size}px "${family}"`;
  const width = ctx.measureText(text).width;
  ctx.restore();
  return width;
}

// ─────────────────────── 等宽/全角宽度（base.py 原样移植） ───────────────────────

const CHAR_WIDTHS: readonly (readonly [number, number])[] = [
  [126, 1],
  [159, 0],
  [687, 1],
  [710, 0],
  [711, 1],
  [727, 0],
  [733, 1],
  [879, 0],
  [1154, 1],
  [1161, 0],
  [4347, 1],
  [4447, 2],
  [7467, 1],
  [7521, 0],
  [8369, 1],
  [8426, 0],
  [9000, 1],
  [9002, 2],
  [11021, 1],
  [12350, 2],
  [12351, 1],
  [12438, 2],
  [12442, 0],
  [19893, 2],
  [19967, 1],
  [55203, 2],
  [63743, 1],
  [64106, 2],
  [65039, 1],
  [65059, 0],
  [65131, 2],
  [65279, 1],
  [65376, 2],
  [65500, 1],
  [65510, 2],
  [120831, 1],
  [262141, 2],
  [1114109, 1],
];

/** 单字符显示宽度（1=半角，2=全角，0=零宽）。 */
export function getCharWidth(codePoint: number): number {
  if (codePoint === 0xe || codePoint === 0xf) return 0;
  for (const [num, width] of CHAR_WIDTHS) {
    if (codePoint <= num) return width;
  }
  return 1;
}

/** 字符串显示列宽。 */
export function columnWidth(s: string): number {
  let res = 0;
  for (const ch of s) res += getCharWidth(ch.codePointAt(0) ?? 0);
  return res;
}

/** 按列宽裁剪（保留不超过 limit 列的前缀）。 */
export function changeColumnWidth(s: string, limit: number): string {
  let res = 0;
  const out: string[] = [];
  for (const ch of s) {
    res += getCharWidth(ch.codePointAt(0) ?? 0);
    if (res <= limit) out.push(ch);
  }
  return out.join('');
}

/** 曲名溢出处理：列宽 > maxColumns 时截到 clipColumns 列并加省略号。 */
export function fitTitle(title: string, maxColumns = 18, clipColumns = 17): string {
  if (columnWidth(title) > maxColumns) {
    return `${changeColumnWidth(title, clipColumns)}...`;
  }
  return title;
}
