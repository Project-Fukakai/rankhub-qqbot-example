# src/render/phi — phigros `/rks`（照搬 phi-plugin b19）

不重新设计版式：直接使用 **phi-plugin b19 模板 + CSS + 字体 + 图标**，渲染链路与上游一致
（art-template 渲染 HTML → 无头 Chromium 截图）。本目录只做「素材定位 + 数据适配 + 截图」。

## 素材

```bash
node scripts/fetch-assets-phi.mjs          # 首次/更新素材（幂等，可重复执行）
node scripts/fetch-assets-phi.mjs --force  # 强制重取
```

- phi-plugin 固定 commit `6bb6fad1db8702d2c8d470930c31538581d16a31`，用
  `git fetch --depth 1 --filter=blob:none` + `sparse-checkout` 只拉
  `resources/html/{b19,common,otherimg,avatar}` 与 `LICENSE`（约 53MB，避免整仓 642MB）。
  落盘到 `vendor/phi/`，`.phi-plugin-commit` 记录版本；已存在则跳过。
- 曲库 `https://static.rankhub.cc/phigros/info/songs.json` + 曲绘
  `.../Tracks/<songId>/IllustrationLowRes.jpg.jpg`（并发 4、重试 3、失败占位），
  落盘 `vendor/covers/phigros/<sha1(songId)>.jpg` 与 `index.json`（含每首的定数 levels）。
- `vendor/` 已在 `.gitignore`，不入库。

## 使用

```ts
import { createPhigrosRenderer } from './src/render/phi/index.js';

const renderer = createPhigrosRenderer();
try {
  const image = await renderer.renderPhigrosRks(input); // PNG/JPEG Buffer
} finally {
  await renderer.close();
}
```

`PhigrosRenderer` 同时实现了契约 `Renderer`（`renderMaimaiB50` 显式抛错，避免误装配）。

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PHI_PLUGIN_RES` | phi-plugin resources 目录（可指 `resources` 或其父目录） | `vendor/phi/resources` |
| `PHI_COVERS_DIR` | 曲绘缓存目录 | `vendor/covers/phigros` |
| `RENDER_BROWSER_PATH` | Chromium 可执行文件 | `~/Library/Caches/ms-playwright/chromium_headless_shell-*/…`（取 build 最大），再退 `chromium-*` / PATH |

## 数据映射（对齐 `Save.getB19()`）

- `gameuser`: `PlayerId`=profileName、`rks`=rks、`avatar`=`-SURREALISM-`（缺省取第一个头像）、
  `ChallengeMode`='0'（无数据，CSS 隐藏）、`ChallengeModeRank`=0、`data`='—'。
- `Date`: 渲染时刻 `YYYY/MM/DD hh:mm:ss`。
- `phi`: `input.phi` 前 3 条 → P1~P3；即使为空数组也传（模板用 `phi ? 27 : 30` 决定 OVER FLOW 分界）。
- `b19_list`: `input.best` 按 rating/score 降序取前 30，`num` 重编 1..30；第 28~30 条进 OVER FLOW。
- 单卡字段：`song`、`illustration`（本地曲绘 `file://`，缺图用占位）、`rank`=难度（EZ/HD/IN/AT，
  模板 `rank-*` / `info-*` 类名）、`difficulty`=songs.json 定数（缺失退回 `level`，再无则 0.0）、
  `rks`=RankHub rating（缺失按 phi-plugin `fCompute.rks` 兜底）、`score`、`acc`、
  `Rating`=评级图标名（phi/FC/V/S/A/B/C/F/NEW，与上游 `Rating(score, fc)` 完全一致）。
- 上游有、RankHub 输入没有的块只做**视觉隐藏**（注入 `<style id="rankhub-phi-overrides">`，
  一律 `visibility: hidden` 而不是 `display: none`，保留布局占位，避免挤动 `.rks` / `.suggest` 等相邻元素）：
  逐难度通关统计 `recordInfo`、挑战模式 `clgBox`、推分建议 `suggest`、空 `spInfoBox`；
  `b30Analysis` / `accAvg` / `cpToOld` 不传。

## 渲染细节

- `art-template` 用 `template(b19ArtPath, data)` 按文件名渲染，
  等价于 `render(file, data, { filename: file })`，`{{extend defaultLayout}}` / `{{include}}` 才能按绝对路径解析。
- `_res_path` 传 `file://.../vendor/phi/resources/`（模板里写的是 `{{_res_path}}html/...`）。
- Chromium 加 `--allow-file-access-from-files`，否则 `file://` 页面的本地字体可能被跨源拦截。
- 等待 `document.fonts.ready` + 所有 `<img>` load/error + 两帧 rAF，再截 `body` 元素（不是 fullPage）。
- 输出：PNG；超过 4.5MB 降级 JPEG(q90)；仍超限则 `html{zoom:0.85}` 再截 PNG。
- 实测尺寸：30 条 ≈ 1200×1770（≈2.1MB PNG）；12 条 ≈ 1200×972。

## 测试

```bash
node scripts/fetch-assets-phi.mjs   # 首次
pnpm test:render                    # 产物在 test/render/__out__/
```

覆盖：30 条 / 12 条 fixture、缺曲绘、超限降级、评级与 rks 公式、空 best、并发渲染。

## 版权

`vendor/phi` 内的模板、样式、字体、图标来自 [phi-plugin](https://github.com/Catrong/phi-plugin)
（GPL-3.0，`vendor/phi/LICENSE`），渲染结果保留其页脚与免责声明，未做删改。
