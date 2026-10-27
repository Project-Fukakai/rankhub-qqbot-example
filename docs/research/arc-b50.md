# Arcaea B50 海报移植报告（best-posters → rankhub-qqbot）

> 证据约定：`DESIGN:` = `/Users/qianmo/personal/projects/designs/best-posters`，
> `APP:` = `/Users/qianmo/personal/projects/RankHub`，`BOT:` = `/Users/qianmo/personal/projects/rankhub-qqbot`。
> 所有 `file:line` 均为本次实测行号（仓库为只读参考，未改动）。

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 公开 API | `createArcaeaRenderer(options?)` / `renderer.renderArcaeaB50(input): Promise<Buffer>` / `renderer.renderDetail(input)` / `renderer.close()`（`BOT:src/render/arc/index.ts`） |
| 输入 | `{ profileName, potential, items: (ArcaeaScore \| GameScore)[], computedAt? }`；两种条目都收（见 §5.1），类型在 `BOT:src/render/arc/types.ts:19-72` |
| 出图尺寸 | **2600 × 3464 px**（与 best-posters 原稿 `#poster` 完全一致，实测同尺寸） |
| 出图体积 | PNG **4,946,285 B（4.72 MB）**，耗时 ~1.3–1.5 s（Chromium 复用后）；超 4.5 MB 时按 QQ 上限降级为 JPEG q90 **1,503.5 KB** |
| reference PNG | `BOT:test/render/__out__/arc-reference.png`（2600×3464，4.72 MB，gitignored） |
| 素材 | `BOT:vendor/arc`：69 文件 / 10,693,279 B（10.2 MB）＝ 曲绘 62（含 index.json + placeholder.svg）+ 字体 5 + logo 2 |
| 测试 | `tsc --noEmit` 0 error；`test/render/arc.test.ts` **11 passed**；`test/render` 52 passed；`test/unit` 132 passed |
| 降级 | 缺单张曲绘 → 占位图（不抛异常）；空列表 → 仍出图；整套素材缺失 → `ArcAssetError` 带可执行修复命令 |

复现：

```bash
node scripts/fetch-assets-arc.mjs          # 同步 vendor/arc（幂等）
npx tsc --noEmit                           # 0 error
npx vitest run test/render/arc.test.ts     # 10 passed，产出 reference PNG
```

## 1. 素材层

### 1.1 同步脚本 `BOT:scripts/fetch-assets-arc.mjs`

只做「复制 + 建索引」，不改图：

| 组 | 源 | 目标 | 说明 |
| --- | --- | --- | --- |
| covers | `DESIGN:assets/covers/arcaea/*.jpg` | `vendor/arc/covers/` | 60 张，文件名原样保留 |
| fonts | `DESIGN:assets/fonts/{Saira-*,阿里妈妈数黑体.ttf}` | `vendor/arc/fonts/` | 白名单 5 个文件（只搬海报用到的） |
| logos | `DESIGN:assets/logos/{arcaea,rankhub}.svg` | `vendor/arc/logos/` | `arcaea.svg` 必需，`rankhub.svg` 缺失只告警 |
| index | `DESIGN:data/catalog.js` → `games.arcaea` | `vendor/arc/covers/index.json` | `songId → {file,title,artist,levels}`，键排序保证字节稳定 |
| 占位图 | 脚本内联 SVG | `vendor/arc/covers/placeholder.svg` | 深色斜纹 + `NO ARTWORK`，与卡面同族 |

幂等性（连续两次运行，实测输出）：

```
第一遍： covers 60（新增 60，未变 0） fonts 5（新增 5） logos 2（新增 2） index.json 已写入  总计 67 文件 10.2 MB 0.05s
第二遍： covers 60（新增 0，未变 60） fonts 5（新增 0） logos 2（新增 0） index.json 未变    总计 67 文件 10.2 MB 0.01s
```

- 判定方式：先比字节数，再比 SHA-256；`index.json` 抹掉 `generatedAt` 后比对，实质不变就不重写（不抖 mtime，渲染进程缓存不失效）。
- 源目录缺失 → 退出码 1，消息列出缺失项与 `--source/ARC_DESIGN_DIR` 用法（`BOT:scripts/fetch-assets-arc.mjs:218-248`）。
- `catalog.js` 用「截取首个 `{` 到末个 `}` 再 `JSON.parse`」读取，不执行上游脚本。

### 1.2 体积

```
vendor/arc/covers   62 文件  8,957,974 B (8.54 MB)   # 60 jpg + index.json + placeholder.svg
vendor/arc/fonts     5 文件  1,694,676 B (1.61 MB)
vendor/arc/logos     2 文件     40,629 B (0.03 MB)
合计                69 文件 10,693,279 B (10.2 MB)   # 脚本复制 67 个，另 2 个是生成的 index.json / placeholder.svg
```

曲绘本身在 design 侧已是「最长边 720 / JPEG q86」的成品（`DESIGN:scripts/collect-assets.py:260-264`），
因此移植脚本不再二次压缩，避免引入画质损失。字体 1.61 MB 里 1.36 MB 是中文数黑体（CJK 标题必需）。

## 2. best-posters 的 arcaea 分支：布局与结构

### 2.1 页面骨架

| 元素 | 关键尺寸 | 证据 |
| --- | --- | --- |
| `.poster` 定宽 | `width:2600px`，`overflow:hidden`，20px 基准字号 | `DESIGN:css/base.css:50` |
| 背景层 | `poster-background` blur(30px) 灰度曲绘 + 竖向渐隐 + 80px 网格 | `DESIGN:css/base.css:51-53` |
| hero | 高 440px，底部 1px 分隔线 | `DESIGN:css/base.css:54` |
| 分区容器 | `padding:32px 64px 40px`（arcaea 收成 20px 左右留白） | `DESIGN:css/base.css:94`、`DESIGN:css/games.css:37` |
| 页脚 | `min-height:108px`，三段式 | `DESIGN:css/base.css:149-154` |

### 2.2 hero（`DESIGN:js/app.js:151-158`）

- 左上 `RankHub / BEST PERFORMANCE ARCHIVE` + 右上 `VOL. 03 / 2026`（arcaea 在 `order` 里是第 3 个，`DESIGN:js/app.js:4`；`VOL. ${index}` 见 `:153`）。
- 标题位：有官方字标就用 `<img class="game-logo">` 顶掉文字（`DESIGN:js/app.js:141-144`，`LOGOS.arcaea = assets/logos/arcaea.svg` 见 `:10`），字标高 120px（`DESIGN:css/base.css:69`）。
- 玩家块：`avatar-monogram`（名字首字）+ 名字 + 编号（原稿是 `RH-002637` 演示码，`DESIGN:js/app.js:146`）。
- 大数字：`metric-value` 95px（`DESIGN:css/base.css:79`），arcaea 传 `POTENTIAL` 与 `estimatedPotential.toFixed(4)`（`DESIGN:js/demo-data.js:162`）。
- 右侧 `BEST` + `best-number` 152px，前缀斜杠（`DESIGN:css/base.css:82-84`）。
- 底部统计条 3 项 + 时间戳 stamp（`DESIGN:css/base.css:85-93`）。
- hero 背景曲绘 980px 宽、`clip-path` 四边形、灰度 + `mask-image` 左缘渐隐（`DESIGN:css/games.css:46`、`DESIGN:css/base.css:55`）。

### 2.3 分区与网格

- 单分区 `BEST 50`：`id:'best'`、副标题「单曲 Potential 降序 · 前 10 首权重 ×2」（`DESIGN:js/demo-data.js:166`）。
- 网格 `repeat(5,minmax(0,1fr))`（`DESIGN:css/base.css:103`），arcaea 收窄留白换来 `column-gap:40px; row-gap:64px`（`DESIGN:css/games.css:42`）、分区标题下 `margin-bottom:64px`（`:44`，给探出卡面的梯形标签留位）。
- 5 列 × 10 行 = 50 张卡；卡片高 214px（`DESIGN:css/games.css:68`），故 `.poster` 实测高 **3464px**。

### 2.4 卡片 DOM 顺序（arcaea 分支，`DESIGN:js/app.js:117-125`）

```html
<article class="score-card" style="--diff:<难度色>">
  <div class="card-surface">            <!-- 切角卡面（z-index:-1） -->
  <span class="card-rank">B01</span>     <!-- 绝对定位右上（arcaea 不占顶栏，:111） -->
  <div class="card-tab">● FTR 10</div>  <!-- 梯形难度标签（arcaea 专属，:120） -->
  <div class="card-cover"><img 154×154></div>
  <div class="card-body">               <!-- arcaea 专属：正文 + 右侧大字同行（:116） -->
    <div class="card-content">曲名 / 分数 / 判定统计</div>
    <div class="grade-column">P / F / EX+  +  TIME</div>
  </div>
  <div class="card-footer">             <!-- arcaea 底栏为空(:123) -->
  <div class="rating-band">11.3 → 13.5450 PTT</div>  <!-- arcaea 放在 footer 之后(:124) -->
```

要点：

- arcaea **没有** `status()` 状态 chip（`DESIGN:js/app.js:123` 三元里 arcaea 返回空串），判定语义改由右侧大字承担（`:71-81`）。
- arcaea **没有** `card-top` 顶栏：序号绝对定位到右上角，省掉 26px（`:109-112` + `DESIGN:css/games.css:66-69`）。
- 难度/等级合并成梯形标签，不是独立色块：`.card-surface` 向上探出 28px，用同一条 polygon 画出卡面 + 标签（`DESIGN:css/games.css:48-62`），标签本体只放文字（`:88`）。
- 正文与右侧大字同处一条 flex 行，正文栏宽随大字长度（P/F/EX+）自动伸缩（`DESIGN:css/games.css:70-77`）；曲名绝对定位成单行 + ellipsis（`:78-84`）。
- 分数 36px（`:85`）、判定行 14px、PTT 板 204×30 贴右下、出血 -8/-6px（`:91-99`）、判定大字 46px（`:104-109`）、P/F 带散光（`:110-117`）、TIME 挂在大字下方共用右边界（`:118-124`）。

## 3. 字段映射 best-posters → 移植模板

| 模板字段 | 来源 | best-posters 证据 |
| --- | --- | --- |
| 序号 `B01` | `rank = prefix + padStart(2)` | `DESIGN:js/demo-data.js:28`、`DESIGN:js/app.js:96-98` |
| 难度名 | `difficulty`（`FTR/BYD/ETR/INS`） | `DESIGN:js/demo-data.js:144-148`（`ratingClass` → 名字数组） |
| 难度色 `--diff` | `COLORS.arcaea[difficultyIndex]` | `DESIGN:js/demo-data.js:17-19`、`:50` |
| 等级 `10+` | `level`（缺失退回 `constant`） | `DESIGN:js/app.js:89`、`DESIGN:js/demo-data.js:148` |
| 曲名 | `title` | `DESIGN:js/app.js:113` |
| 分数 `9'950'000` | 千分位换半角单引号 | `DESIGN:js/demo-data.js:148` |
| 判定行 `P x (+y) / F z / L w` | 判定统计 | `DESIGN:js/demo-data.js:151` |
| 判定大字 `P/F/EX+` | PM→P（gold）/ FR→F（blue）/ 其余评级（neutral） | `DESIGN:js/demo-data.js:154-157`、`DESIGN:css/games.css:107-109` |
| TIME `5h` | 分钟换挡 m/h/d | `DESIGN:js/demo-data.js:38-45,140`、`DESIGN:js/app.js:77-78` |
| PTT 板 `定数 → 单曲PTT PTT` | `constant` + `rating.toFixed(4)` | `DESIGN:js/app.js:82-86`、`DESIGN:js/demo-data.js:147` |
| 分区计数 `COUNTED RECORDS 50 / 50` | `cards.length` | `DESIGN:js/app.js:130` |
| 页脚公式说明 | `formulaNote` | `DESIGN:js/app.js:158`、`DESIGN:js/demo-data.js:167` |

移植实现集中在 `BOT:src/render/arc/data.ts`：`isGameScore`/`fromGameScore`/`normalizeScore`（`:233-271`）、`resolveDifficulty`（`:287-324`）、
`deriveGrade`（`:326-346`）、`formatJudgements`（`:348-358`）、`resolveItem`（`:396-410`）、
`buildCard`（`:412-459`）、`buildArcTemplateData`（`:461-536`）。

## 4. 曲绘命名规则

**规则：`sha256(曲绘源 URL)` 的十六进制前 16 位 + `.jpg`** —— `DESIGN:scripts/collect-assets.py:255`：

```python
relative = f"assets/covers/{game}/{hashlib.sha256(url.encode()).hexdigest()[:16]}.jpg"
```

源 URL 的选取（arcaea，`DESIGN:scripts/collect-assets.py:121-152`）：

1. 目录名 `("dl_" if remote_dl else "") + song.id`（`:133`）；
2. 在 `resources.json` 的 `songs/<目录>/` 下按优先级挑图：`1080_base.jpg` > `base.jpg` > `1080_base_256.jpg` > `base_256.jpg`（`:137-138`）；
3. 拼成 `https://static.rankhub.cc/arcaea/asset/songs/<目录>/<图>`（`:139`、`:47-50`）；
4. 落地时 exif 转正 → RGB → 最长边 720（LANCZOS）→ JPEG q86（`:260-264`）。

因此**同一个 songId 的曲绘文件名与其难度无关**（同曲不同难度共图），移植侧只需 `songId → 文件名` 索引。
`vendor/arc/covers/index.json` 就是这张索引（由 `catalog.js` 的 `songId`/`cover` 反推），
`levels` 里带着该曲的 `difficulty/level/constant/difficultyIndex`，用于「输入缺等级/定数时兜底」。

> 当前 60 张曲绘 / 60 个 songId，正好一一对应（best-posters 的 `pick_unique` 保证同曲只取一条谱面，`DESIGN:scripts/collect-assets.py:60-78`）。
> 对真实 B50（50 条里可能有 best-posters 没采样的歌）覆盖率有限，见 §6 第 4 条。

## 5. 与 RankHub 数据字段的对应关系

### 5.1 契约层与两种输入形状

- `GET /v1/games/{game}/profiles/{id}/bests` → `GameBests{buckets,totals,computedAt}`（`BOT:src/contracts/index.ts:123-135`、`BOT:docs/OPENAPI.md:65`）。
- 单条成绩归一为 `GameScore`（`BOT:src/contracts/index.ts:103-121`），arcaea 的原始字段在 `native: Record<string, unknown>` 里透传。
- 并行任务已在契约里加了 `ArcaeaB50RenderInput { profileName, potential: number|null, items: GameScore[], computedAt? }`
  与可选方法 `Renderer.renderArcaeaB50?`（`BOT:src/contracts/index.ts:307-323`；本次为他人改动，本任务未修改该文件）。

因此渲染器**同时接受两种条目**（`BOT:src/render/arc/types.ts:60` 的 `ArcaeaRenderItem = ArcaeaScore | GameScore`）：

| 形状 | 用途 | 归一化 |
| --- | --- | --- |
| `ArcaeaScore`（本模块，扁平 camelCase） | fixture、单测、手工构造 | 原样使用 |
| `GameScore`（契约层，`native` 里放 arcaea 原始字段） | 装配层 `/bests` 直传 | `fromGameScore`（`data.ts:247-267`）摊平 `native` |

`GameScore → ArcaeaScore` 的映射（`data.ts:247-267`）：

| ArcaeaScore | 来源 |
| --- | --- |
| `songId` / `level` / `levelIndex` | 契约同名字段 |
| `title` | `songName` → `native.title` |
| `score` | `score` → `native.score` → `achievements` |
| `rating` | `rating` → `native.potential` |
| `difficulty` | `difficulty` → `type` |
| `scoreRank` | `rank` → `native.rank` |
| `clearType` | `native.clear_type`（兼容 `clearType`） |
| `perfectCount` / `shinyPerfectCount` / `nearCount` / `missCount` | 同名 snake_case native 字段 |
| `constant` | `native.constant` |
| `playTime` | 仅契约里的已格式化字符串（`native.time_played` 不消费，见 §6.6） |

> 装配层不需要先摊平 `native`：`GameScore[]` 可直接赋给 `ArcaeaRenderItem[]`，
> `renderer.renderArcaeaB50(contractInput)` 即可（`BOT:test/render/arc.test.ts` 有用例锁定这条链路）。

### 5.2 App 侧的 arcaea 原始字段（权威来源）

`ArcaeaScore.fromJson`（`APP:lib/modules/arcaea/models/arcaea_models.dart:138-187`）：

| JSON 字段 | 类型 | 含义 |
| --- | --- | --- |
| `song_id` | string | 曲目 id |
| `difficulty` | int | 难度槽位 0..5 |
| `score` | int | 原始分（Arcaea 满分 10,000,000） |
| `score_below_max` | int | 距满分差 |
| `perfect_count` / `shiny_perfect_count` / `near_count` / `miss_count` | int | 判定统计 |
| `clear_type` / `best_clear_type` | int | 0 Track Lost / 1 Clear / 2 Full Recall / 3 Pure Memory |
| `health` | int | 残血 |
| `time_played` | int | **语义未知（见 §6 第 6 条）** |
| `potential` | double | 单曲 PTT |
| `rank` | string | 评级文本 |
| `constant` | double? | 定数（可缺） |

App 的海报卡片推导（`APP:lib/modules/arcaea/widgets/arcaea_b50_poster.dart`）：
`status` 由判定数推导（`:105-109`）、序号 `#01`（`:111`）、副标题含难度名/定数/判定（`:113`）、
PTT 保留 4 位（`:117,159`）、分数用 `'` 分隔（`:115,154-157`）、难度名映射（`:137-144`）、难度色（`:146-152`）。

### 5.3 渲染输入 → 模板字段

| `ArcaeaScore`（本仓库） | 模板 | 兜底链（缺字段时） |
| --- | --- | --- |
| `songId` | 曲绘解析、`data-chart-id` | 必填；缺失条目在入口被过滤（`data.ts:468-474`） |
| `title` | 曲名 | → 索引里的 `title` → `TRACK n` |
| `score` | `primaryValue` | → `—` |
| `rating` | `ratingValue`（4 位小数） | → 定数 + 分数按 `arcaeaPtt` 公式算（`data.ts:139-149`） → `—` |
| `level` | 梯形标签等级 | → 索引里的 `level` → `constant` |
| `levelIndex` / `difficulty` | 标签难度名 + 颜色 | → 索引里该曲唯一一档 → 不画标签 |
| `constant` | PTT 板左侧 | → 索引里的 `constant` → `—` |
| `clearType` / `nearCount`+`missCount` | `gradeMark` / `gradeSrText` / `gradeTone` | 判定数齐全优先，其次 `clearType`（2=FR、≥3=PM），最后用评级 |
| `scoreRank` | 评级 | → `arcaeaGrade(score)`（`js/ratings.js:77-85` 阈值） |
| `perfectCount` 等 | 判定统计行 | 逐项 `—` |
| `playTime` / `playMinutes` | TIME | → 不显示该栏 |
| `coverFile` | 曲绘 | → `songId` 查索引 → 占位图 |

`potential` 接受 `number`（→ 4 位小数）或 `string`（原样透传，便于保留 RankHub 精度）；缺失显示 `—`。

## 6. 已知差异（与 best-posters / 与 App）

1. **序号前缀**：design 用 `B01…B50`（`js/demo-data.js:28,161`），App 用 `#01`（`arcaea_b50_poster.dart:111`）。
   移植沿用 design 的 `B`。
2. **第 6 槽难度名**：design 用 `INS`（`js/demo-data.js:19`），App 用 `CHT`（`arcaea_b50_poster.dart:143`）。
   移植沿用 design 的 `INS`，颜色也跟随 design（INS 用 indigo `#4f46e5`，与 ETR 的浅紫拉开）。
3. **英雄区三处文案换成 RankHub 口径**：玩家编号 `RH-002637` → `RANKHUB`；stamp `SAMPLE PLAYER` → `RANKHUB DATA`；
   caption `B50 + B10 估算 · 演示成绩` → `B50 + B10 · RANKHUB 数据`。原因：输入里没有玩家码，也不该谎称示例数据。
4. **曲绘覆盖率**：design 只采样了 60 条 arcaea 谱面（`collect-assets.py:149-152` 的 `pick_unique(…, 60)`），
   真实 B50 里未被采样的曲目会回落到 `placeholder.svg`。当前 60/60 命中，只是因为 fixture 取自索引。
   后续如果要全量覆盖，需要按 `collect-assets.py` 的口径从 `static.rankhub.cc` 补拉（含 `sha256(url)[:16]` 命名），
   属于素材脚本的下一个迭代，不在本次「复制 design 素材」范围内。
5. **PNG vs JPEG**：50 张曲绘的 PNG 约 4.72 MB，超过 `MAX_IMAGE_BYTES = 4.5 MB`
   （QQ 图片上限约 5MB，留 0.5MB 余量，与 `src/render/phi/renderer.ts:33` 同口径），
   默认链路会降级为 JPEG q90 ≈ 1.5 MB。要强制 PNG（如归档/测试）传 `maxImageBytes: Number.POSITIVE_INFINITY`；
   reference PNG 就是这样产出的。降级阶梯是 PNG → JPEG q90 → 整体缩放 85% 的 JPEG，取第一个满足上限的候选。
6. **`time_played` 不消费**：App 模型里有一处 `timePlayed: DateTime.now().millisecondsSinceEpoch`
   （`APP:lib/modules/arcaea/widgets/arcaea_views.dart:2639`），说明它更像时间戳而不是分钟；
   design 的「TIME 5h」来自演示字段 `play_minutes`（`js/demo-data.js:140,153`）。
   **`time_played` 的单位属于未知项（unknown）**，因此渲染器只接受显式的 `playMinutes` / `playTime`，
   不猜单位。装配层若要显示 TIME，需要先确认该字段口径。
7. **分区副标题固定为 design 原文**「单曲 Potential 降序 · 前 10 首权重 ×2」（对应 `(ΣB50+ΣB10)/60` 口径）；
   如果 RankHub 上报的 Potential 与其自带 B10 权重口径不同，应改文案而不是改算法。
8. **hero 大数字不做本地重算**：`potential` 由调用方传入（RankHub 上报值），渲染器只负责排版；
   `B50 AVG / B10 AVG / EX+` 三个统计项是本地按 `items` 现算（与原稿 `js/ratings.js:87-96` 一致）。
9. **模板裁剪范围**：去掉工作台外壳（header/tabs/zoom/纯海报开关/响应式与打印媒体查询）与另外六款游戏的样式，
   只保留 `.game-arcaea`；`@font-face` 依据 `vendor/arc/fonts` 实际文件生成，缺字体自动退回系统字体（不报错）。
10. **与契约层同名类型**：`src/contracts/index.ts` 里的 `ArcaeaB50RenderInput`（`items: GameScore[]`）与本模块同名类型
    （`items: (ArcaeaScore | GameScore)[]`）**不是同一个声明**，本模块的签名更宽（可接受契约输入）。
    装配层建议只从 `src/contracts/index.js` 引类型、从 `src/render/arc/index.js` 引实现，避免同名歧义。
11. **`assets:fetch` 尚未串联**：`package.json` 的 `assets:fetch` 目前是
    `fetch-assets-phi && fetch-assets-mai`，未包含 `node scripts/fetch-assets-arc.mjs`
    （该文件不在本任务写作用域内）。**建议 Lead 加一行**：`"assets:arc": "node scripts/fetch-assets-arc.mjs"` 并串进 `assets:fetch`，
    否则干净检出后 `test/render/arc.test.ts` 会因缺 `vendor/arc` 报可执行的 ArcAssetError。

## 7. 验证记录

### 7.1 类型与测试

```
$ npx tsc --noEmit                     → 0 error
$ npx vitest run test/render/arc.test.ts → 11 passed
$ npx vitest run test/render            → 4 files / 52 tests passed（arc + mai + phi 全绿）
$ npx vitest run test/unit              → 15 files / 132 tests passed
```

`test/render/arc.test.ts` 覆盖：

| 用例 | 断言 |
| --- | --- |
| 50 条 fixture | PNG、宽 **2600**（>2000）、高 3464、字节 **4,946,285 B**（>100KB）、50 张卡、曲绘 50/50 命中、`fontsReady=true`、`viewportWidth ≥ 图宽`、HTML 无 `{{`/`undefined`/`NaN`；写出 reference PNG |
| 未知曲目（6 条，全字段缺失） | 不抛异常、`coversMissing=6`、`coverUrl` 指向 `placeholder.svg`、分数 `9'876'543`、判定行 `P — / F — / L —`、`profileInitial='?'`、`potentialText='—'` |
| 空列表 | 仍出图（宽 2600），统计项 `['—','—','0']` |
| 体积降级 | 2MB 上限 → JPEG（1503.5KB）；1KB 上限 → 85% 缩放 JPEG（宽 2210，仍 >2000） |
| 公开 API | `renderArcaeaB50` 返回 `Buffer` |
| 契约形状输入 | `GameScore[]`（native 带 clear_type/判定数/constant）→ 曲名/分数/难度/定数/FULL RECALL/判定行全部正确，曲绘命中 |
| 纯函数映射 | 分数分隔、PTT 公式（含 `Math.max(0,…)` 低分夹取）、评级 7 档、判定推导（判定数优先 / `clear_type` 次之）、时长换挡、模板数据名次与回落 |

### 7.2 与 design 原稿的像素级对照

用同一 Chromium（`chrome-headless-shell`）分别截图原稿与移植版：

| | 宽 | 高 | 说明 |
| --- | --- | --- | --- |
| `DESIGN:index.html#game=arcaea&pure=1` 的 `#poster` | 2600 | **3464** | 原稿 `data-ready=true` 后截图 |
| 移植版 `#poster` | 2600 | **3464** | 同 DOM 结构 / 同 CSS |

高度一致说明 hero/分区/网格/卡片/页脚的高度链全部对齐；卡片 214px、5 列、行距 64px 也在 DOM 探针里核对过
（`gridTemplateColumns: 480px ×5`、`.hero-best` 右边界 2580）。逐区目测（hero / 分区标题 / 首行卡片 / 缺曲绘卡）无差异项。

### 7.3 明确的降级行为（验收项）

| 场景 | 行为 |
| --- | --- |
| 单张曲绘缺失（songId 不在索引 / 文件不存在） | `<img src=placeholder.svg>` + `.is-placeholder`（灰度 0.72），不抛异常 |
| 字体缺失 | 只为存在的字体生成 `@font-face`，其余退回 `Saira,'PingFang SC','Microsoft YaHei',sans-serif` |
| `arcaea.svg` 缺失 | hero 标题回退为文字 `Arcaea` |
| `rankhub.svg` 缺失 | 顶栏/页脚不渲染品牌标（不留破图） |
| 整套 `vendor/arc` 缺失 | `ArcAssetError`：`未找到 arcaea 素材目录（缺 covers/index.json）：已查找 …。请先运行 node scripts/fetch-assets-arc.mjs …` |
| 条目字段缺失 | 逐字段占位（`—` / `TRACK n` / 不画难度标签 / 不显示 TIME），不抛异常 |
| 条目为空 | 仍出 PNG（只有 hero + 空分区 + 页脚） |

## 8. 交付清单（文件）

```
scripts/fetch-assets-arc.mjs          素材同步（幂等，374 行）
src/render/arc/types.ts               输入类型（ArcaeaScore / ArcaeaRenderItem / ArcaeaB50RenderInput）
src/render/arc/assets.ts              素材解析（目录/索引/曲绘/字体/logo/Chromium 查找）
src/render/arc/data.ts                字段映射 + GameScore 归一 + 兜底 + 模板数据（536 行）
src/render/arc/template.ts            自包含 HTML + 裁剪后的内联 CSS（332 行）
src/render/arc/renderer.ts            playwright-core 截图（320 行）
src/render/arc/index.ts               公开导出（76 行）
test/render/arc.test.ts               11 个用例 + fixture（463 行）
vendor/arc/**                         生成物（gitignored）
test/render/__out__/arc-reference.png  参考图（gitignored）
```

依赖复用：`findBrowserExecutable` / `REPO_ROOT` 直接来自 `BOT:src/render/phi/assets.ts:13,180-224`（只读引用，未改动 phi 目录）。
Chromium launch 参数与 phi 一致（`--no-sandbox --disable-gpu --disable-dev-shm-usage --allow-file-access-from-files --font-render-hinting=none`）。

装配状态：并行任务已把本模块接进 `BOT:src/bot/renderer.ts:117-132`（动态 `import('../render/arc/index.js')` →
`createArcaeaRenderer({ browserPath })` → `renderArcaeaB50(input)` / `close()`），命令入口在 `BOT:src/commands/arc.ts:24,63`。
传参只用到 `browserPath`，与本模块 `ArcaeaRendererOptions` 一致；`tsc --noEmit` 在含这些他人改动的工作树上仍为 0 error。
构造期不加载素材（与 phi 渲染器一致），`vendor/arc` 缺失时在首次 render 抛 `ArcAssetError`（消息带修复命令）。
