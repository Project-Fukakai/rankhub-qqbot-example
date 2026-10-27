# maimai b50 渲染：maimaiDX 移植评估 spike（结论 + 基线）

- 日期：2026-10-27
- 仓库：`/Users/qianmo/personal/projects/rankhub-qqbot`
- 上游：**maimaiDX**，固定 commit `1154ad676238ab45a76a70c23648f7a6d881e53c`（2026-09-23，"fix: 修复计算dx星数错误的问题"）
- 结论：**继续移植（Node + @napi-rs/canvas）**，不做 Python sidecar。
- Lead 决议（`<workspace>/evidence/qqbot/render/maimai-spike-decision.md`）：批准 Node 路线，验收改为**结构性断言**（3% 全图门槛对 PIL→Skia 过严）。

---

## 1. 结论

| 项 | 结论 |
| --- | --- |
| 路线 | 纯 Node 移植（`src/render/mai/**`），无 Python / Playwright 运行时依赖 |
| 绘制保真 | 坐标/尺寸/绘制顺序/配色逐行照抄 `best50.py` + `base.py`；50 张卡 + 头部全部移植 |
| 性能 | 1400×1600 单图 **214–294 ms**（含 50 张曲绘解码 + 约 250 次贴图），远低于 1.5 s |
| 与参考图 | 无全局平移（dx=dy=0）；头部差异 2.4–2.7%；单卡最大差异 15.1%；全图 9.2%（差异全部是字形/缩放抗锯齿，无结构错位、无缺图、无层级错误） |
| 交付接口 | `MaimaiRenderer implements Renderer`，实现 `renderMaimaiB50(input): Promise<Buffer>`；页脚保留上游署名 |

---

## 2. 参考环境（可复跑）

### 2.1 资源与源码

| 资产 | 来源 | 落盘位置 |
| --- | --- | --- |
| maimaiDX 源码子集（`core/**`、`constants.py`、`config.py`、`resources.py`、`requirements.txt`、`LICENSE`） | sparse checkout 上述 commit | `vendor/mai-src/` |
| `Resource CN1.55.7z`（467 MB）+ `Resource CN1.56 UPDATE.7z`（22 KB） | `https://cloud.yuzuchan.moe/f/34s7/...`、`/f/Jvhl/...` | 缓存 `/tmp/mai-res`，裁剪到 `vendor/mai/{pic,cover,plate,shougou,font}` |
| 曲目定数/notes | `https://maimai.lxns.net/api/v0/maimai/song/list?notes=true` | `vendor/mai/data.json`（1360 首，515 KiB） |

一键准备（幂等；`MAIMAIDX_STATIC` 指向已有 static 目录时跳过下载）：

```bash
node scripts/fetch-assets-mai.mjs
# 或复用已有资源包：
MAIMAIDX_STATIC=/path/to/maimaiDX/static node scripts/fetch-assets-mai.mjs
```

产物校验：30 个关键文件 + 1681 张曲绘；`vendor/mai/manifest.json` 记录来源与数量。

### 2.2 Python 参考渲染（只用于生成基线，不参与线上渲染）

```bash
uv venv .venv-ref --python 3.11
uv pip install --python .venv-ref/bin/python py7zr pillow numpy pydantic
.venv-ref/bin/python scripts/render-reference.py \
  --input test/render/mai/fixtures/b50-fixture.json --sample s1 \
  --output evidence/qqbot/render/maimai-reference.png
```

`scripts/render-reference.py` **原样复制** `core/image/{best50,base,assets,tools}.py`、`core/utils/calc.py`、
`constants.py`、`core/merge/models/*`、`core/clients/lxns/models/{enum,collection}.py` 到临时包，
只补 import 级 shim（均标注 `[shim]`，不含任何绘制逻辑、不改任何坐标）：

| shim | 作用 |
| --- | --- |
| `config.py` | `maiconfig`（`assets_online=False` 强制本地素材、`save_in_memory=True`、`bot_name`） |
| `resources.py` | 资源路径改指裁剪后的 `vendor/mai` |
| `service/__init__.py` | `mai.total_list` / `total_level_value_map` 由 `vendor/mai/data.json` 构建，`dx_score = notes.total * 3` |
| `database/qq.py` | `User` 数据类（`service` / `qqid` / `theme`） |
| `clients/http.py` | `online_assets` / `qqlogo` 禁用（离线） |
| `clients/lxns/models/__init__.py` | 补 `Collection` / `Notes` / 枚举导出 |
| `clients/divingfish/models/__init__.py` | `Stats` 占位 |

参考渲染仅预载 b50 实际用到的两张底图（`b50_score_*` / `UI_GAM_Gauge_DXScoreIcon_0*`），
上游 `AssetsImage._load_image()` 会加载 30+ 张与 b50 无关的底图；这属于运行环境 shim，不影响绘制。

固定样例：`test/render/mai/fixtures/b50-fixture.json`（由 `fixtures/generate.mjs` 生成，确定性）：

| 样例 | 场景 |
| --- | --- |
| `s1` | 默认头（无称号，B35+B15 文案），PRiSM PLUS 主题，rating 15847 |
| `s2` | 称号条（Gold）+ rating 17047 |
| `s3` | 边界：超长曲名（省略号）、1 条 Re:Master、缺 fc/fs |

---

## 3. 移植结果与指标

复跑：

```bash
pnpm exec tsx test/render/mai/tools/render-sample.ts          # 三样例 + 结构指标
pnpm exec tsx test/render/mai/tools/card-diff.ts s1           # 50 张卡差异分布
pnpm exec tsx test/render/mai/tools/diffimage.mjs <参考> <移植> <输出>   # 差异灰度图
pnpm exec tsx test/render/mai/tools/crop-compare.ts <参考> <移植> x y w h out.png [scale]
```

| 样例 | 尺寸 | 体积 | 耗时 | 全图差异 | 头部差异 | 最差单卡 | 页脚 | 最佳平移 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1 | 1400×1600 | 1.94 MB | 294 ms | 9.21% | **2.50%** | **15.10%** | 14.99% | (0,0) |
| s2 | 1400×1600 | 1.93 MB | 214 ms | 9.24% | **2.67%** | **15.10%** | 15.19% | (0,0) |
| s3 | 1400×1600 | 1.93 MB | 220 ms | 9.15% | **2.43%** | **15.10%** | 14.99% | (0,0) |

- 50 张卡差异分布（s1）：中位 **12.53%**、最大 **15.10%**、最小 8.65%，**没有一张 >20%**。
- 分区（s1）：头部(0–230) 2.50%、B35 区(235–1085) 10.53%、B15 区(1085–1425) 11.79%、页脚 14.99%。
- 页脚差异是预期内的文案差异（参考图 `Data from Diving-Fish` vs 移植 `Data from RankHub`），不设阈值。

### 判定标准（按 lead 决议，测试已落地）

| 断言 | 阈值 | 实测 |
| --- | --- | --- |
| PNG 签名 / 尺寸 | PNG magic，1400×1600 | ✓ |
| 体积 | < 5 MB | 1.93–1.94 MB |
| 长跑内存（120 次连续渲染） | 无增长趋势 | 164–184 MB，平均 213 ms/图 |
| 单图耗时 | ≤ 1.5 s | 214–294 ms |
| 全局平移 | dx=dy=0（±1px 内） | ✓ |
| 头部区域差异 | ≤ 5% | 2.43–2.67% |
| 单卡区域差异 | ≤ 20%（50 张全查） | 最大 15.10% |
| 人工目视 | 版式一致 | ✓（`maimai-b50-final.png`、`maimai-node-s{1,2,3}.png`） |
| 页脚 | 允许文案不同 | 仅记差异 |

> 3% 全图门槛不适用：PIL 与 Skia 的字形抗锯齿、缩放滤波实现不同，即便逐像素坐标一致，
> 文字/曲绘边缘也会产生大量「>16 但视觉等价」的像素。全图差异只记录（测试里作为 20% 的回归护栏）。

---

## 4. 移植中的关键决策

1. **图片解码必须先 preload**：`new Image(); img.src = buffer` 在 @napi-rs/canvas 里能立刻拿到
   width/height，但像素是异步解码的，直接 `drawImage` 会画出**空白**（首轮 spike 输出只剩文字就是这个坑）。
   实现改为 `collectAssetPaths()` 收集全部素材 → `await assets.preload()` 并行解码 → 同步逐层绘制。
2. **缩放滤波换成面积平均**：PIL `Image.resize` 默认是带抗锯齿的 BICUBIC，而 Skia 的
   `imageSmoothingQuality` 没有等价档位。400→75 曲绘实测（vs PIL 参考）：
   `high` 59.8% / `low` 58.6% / `medium` 8.0% / **面积平均 2.1%** 像素超凡差阈值。
   因此缩小一律走自研 `areaResizePixels()`（面积平均，直通道 RGBA，与 PIL 的处理方式一致），
   放大（名牌 720→800）仍交给 Skia。该改动把全图差异从 12.5% 降到 9.2%、最差单卡从 24.9% 降到 15.1%。
3. **文字 anchor 直接映射**：PIL 的 `mm/lm/lt` 与 Canvas 的 `textAlign+textBaseline` 组合实测墨迹包围盒
   差异 ≤1px（24px FOT-NewRodin / 20px SIYUAN 验证），所以逐字照抄上游的 `DrawText.draw(...)` 参数即可。
   PIL 的 `stroke_width` 是「向四周膨胀 N px」，对应 Canvas `lineWidth = 2N`（页脚描边 white ×5）。
4. **曲名截断沿用上游算法**：`get_char_width` 东亚宽度表 + `change_column_width(17) + "..."`，不是按像素量。
5. **数据兜底**（本任务要求）：缺定数时显示 `? -> rating`（上游会 KeyError）、缺曲绘回落 `cover/0.png`、
   缺 notes 时 DX 分显示 `x/?` 且不画 DX 星，均不抛错。
6. **长跑内存**（踩坑，已修）：@napi-rs/canvas 0.1.100 的**同步** `canvas.toBuffer('image/png')`
   每次编码会滞留约 1.6 MB 原生内存（60 次编码 RSS 66→166 MB，V8 感知不到这部分外部内存，GC 不回收）；
   换成**异步** `await canvas.encode('png')` 后完全稳定。同时整图画布改为池化复用（1400×1600 RGBA ≈ 9 MB/次）。
   修复后连续 120 次渲染：RSS 稳定在 164–184 MB，平均 213 ms/图，无增长趋势。

---

## 5. 风险与遗留

| 风险 | 说明 / 处置 |
| --- | --- |
| `Renderer` 契约未覆盖头部字段 | `MaimaiB50RenderInput` 只有 `profileName/rating/buckets/totals/computedAt`，没有段位/Class/称号。当前默认 `courseRank=0 / classRank=0 / trophy=null`（渲染为「无段位 + 0 阶 + B35/B15 文案」）。已支持通过扩展字段 `{courseRank,classRank,trophy}` 传入（`MaimaiB50RenderExtras`），后续由 commands/rankhub 侧补数据即可，**不改契约也能出图**。 |
| 数据源文案 | 页脚 `Data from RankHub`（参考图为 `Diving-Fish`）。属预期差异，已在测试中排除。 |
| CIRCLE 主题 | 已实现（含 14000+ 的星级叠加、170×35 牌、14×17 数字），但参考图基线只覆盖 PRiSM PLUS；若线上用 CIRCLE 需补一组参考图回归。 |
| 依赖 vendor 资源（约 488 MB） | `vendor/` 已被 `.gitignore` 忽略；新环境/CI 需先跑 `scripts/fetch-assets-mai.mjs`。测试在资源缺失时整组 skip，不会误报。 |
| 参考图基线依赖 Python venv | `test/render/mai` 的参考图对比在 `evidence/qqbot/render/maimai-reference*.png` 缺失时 skip（需 `.venv-ref` + py7zr 才能重建）。 |
| 长跑内存 | 已修：异步 `encode('png')` + 画布池化，120 次渲染 RSS 稳定（164–184 MB）。若后续升级 @napi-rs/canvas 需复测该项（同步 `toBuffer` 有原生内存滞留）。 |
| 字体回退 | 三个字体都用 `GlobalFonts.registerFromPath` 显式注册并 `has()` 校验；缺字体会抛带执行提示的 `MaiAssetError`，不会静默用系统字体导致版式漂移。 |

---

## 6. 产物清单

| 文件 | 说明 |
| --- | --- |
| `evidence/qqbot/render/maimai-b50-final.png` | 最终移植产物（s1，1400×1600） |
| `evidence/qqbot/render/maimai-node-s{1,2,3}.png` | 三个样例的移植输出 |
| `evidence/qqbot/render/maimai-reference.png`、`-s2`、`-s3` | maimaiDX 原始代码生成的参考图 |
| `evidence/qqbot/render/maimai-diff-s1.png` | 差异灰度图（×4 放大） |
| `src/render/mai/**` | 移植实现（constants / text / assets / data / draw / index） |
| `scripts/fetch-assets-mai.mjs` | 资源下载 + 解压 + 裁剪 + 曲目数据缓存（幂等） |
| `scripts/render-reference.py` | 上游原始绘制 + 最小 shim 的参考图生成器 |
| `test/render/mai/**` | 结构性回归（签名/尺寸/体积/耗时/平移/头部/单卡/兜底） |
