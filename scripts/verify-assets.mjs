/**
 * 素材完整性检查（不发网络请求）：
 * - phi-plugin 模板与曲绘缓存；
 * - maimaiDX 裁剪资源包关键文件；
 * - Chromium 可执行文件（phi 渲染用）。
 *
 * 用法：`node scripts/verify-assets.mjs`
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const problems = [];
const notes = [];

function check(label, path, { required = true } = {}) {
  const ok = existsSync(path);
  if (!ok && required) problems.push(`${label}: 缺少 ${path}`);
  else if (!ok) notes.push(`${label}: 缺少 ${path}（可选）`);
  return ok;
}

// phi-plugin
const phi = process.env.PHI_PLUGIN_RES
  ? resolve(process.env.PHI_PLUGIN_RES)
  : join(root, 'vendor', 'phi', 'resources');
check('phi b19 模板', join(phi, 'html', 'b19', 'b19.art'));
check('phi b19 样式', join(phi, 'html', 'b19', 'b19.css'));
check('phi common.css', join(phi, 'html', 'common', 'common.css'));
check('phi 默认 layout', join(phi, 'html', 'common', 'layout', 'default.art'));
check('phi 字体', join(phi, 'html', 'common', 'font', 'NotoSans-Regular.ttf'));
check('phi 评级图标 S', join(phi, 'html', 'otherimg', 'S.png'));

const coversIndex = join(root, 'vendor', 'covers', 'phigros', 'index.json');
if (check('phigros 曲绘索引', coversIndex)) {
  try {
    const index = JSON.parse(readFileSync(coversIndex, 'utf8'));
    const count = Object.keys(index.songs ?? index).length;
    notes.push(`phigros 曲绘索引: ${count} 首`);
    if (count < 100) problems.push(`phigros 曲绘索引条目过少: ${count}`);
  } catch (error) {
    problems.push(`phigros 曲绘索引无法解析: ${error.message}`);
  }
}

// maimaiDX
const mai = process.env.MAIMAIDX_STATIC
  ? resolve(process.env.MAIMAIDX_STATIC)
  : join(root, 'vendor', 'mai');
check('mai b50 主题底图', join(mai, 'pic', 'prism_plus', 'b50.png'));
check('mai 难度底图', join(mai, 'pic', 'b50_score_master.png'));
check('mai 排序数字', join(mai, 'pic', 'UI_NUM_Drating_0.png'));
check('mai 字体 SIYUAN', join(mai, 'font', 'ResourceHanRoundedCN-Bold.ttf'));
check('mai 字体 TBFONT', join(mai, 'font', 'Torus SemiBold.otf'));
check('mai 曲绘 0.png', join(mai, 'cover', '0.png'));
check('mai 曲目数据', join(mai, 'data.json'));
check('mai manifest', join(mai, 'manifest.json'), { required: false });

// Chromium（phi 渲染）
if (process.env.RENDER_BROWSER_PATH) {
  check('Chromium（RENDER_BROWSER_PATH）', process.env.RENDER_BROWSER_PATH);
} else {
  notes.push('Chromium: 未设置 RENDER_BROWSER_PATH，运行时会在 ~/Library/Caches/ms-playwright 里自动查找');
}

for (const note of notes) console.log(`[note] ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`[fail] ${problem}`);
  console.error(`\n素材检查失败：${problems.length} 项。运行 pnpm assets:fetch 重新准备。`);
  process.exitCode = 1;
} else {
  console.log('\n素材检查通过。');
}
