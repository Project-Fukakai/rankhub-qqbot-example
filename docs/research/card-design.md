# /me 玩家名片设计：三张游戏卡 1:1 对齐 App「我的」页

渲染实现：`src/render/card/`（HTML + Playwright 截图）。页面固定 **1200px** 宽，卡片内容宽
**1120px**、单卡 **1120×448（5:2）**。本文件记录版式与 `../RankHub` App 的逐项对应关系、
静态素材来源与已知差异；改视觉时同步更新本文件与 `test/render/card.test.ts`。

> 证据纪律：本文的 App 事实都带 `RankHub:文件:行号`；"本实现"指向 `src/render/card/html.ts`
> 的常量/函数或 CSS 选择器。截图证据见 `evidence/qqbot/card-v2/`（工作区）。

## 1. 整体结构（机器人名片页）

App「我的」页只展示**当前选中游戏**的一张卡；机器人 `/me` 要在一个页面里展示多张，
因此页面骨架沿用 v1 名片（账号 banner / 头像 / 名字 / 图标条 / 二维码），
中间的游戏卡区换成 App 的三套 1:1 卡：

| 区域 | 本实现 | 说明 |
| --- | --- | --- |
| 账号头部 | `.hero` / `.profile` | banner + 圆形头像 + 显示名 + UID + bio（沿用 v1，宽度对齐 1120） |
| 游戏图标条 | `.strip` | 已绑定游戏圆形图标（`vendor/card/icons/*.png`） |
| 游戏卡区 | `.games` → `.game-card` | 每卡 1120×448，间距 34；无卡片时显示空状态 |
| 二维码 | `.qr` | 仅账号公开时渲染（白底二维码块） |

> 页面骨架是**机器人扩展**，不是 App「我的」页原样；App 的对照对象是卡片内部
> （`profileCardBuilder` 产生的 5:2 卡片）。

## 2. 坐标系统：App 参考卡 360×144

App 卡片由 `AspectRatio(5/2)` 撑满可用宽度，卡片内的**比例**是宽高百分比，
但字号/偏移是逻辑像素（dp）。为了把 Dart 常量原样搬进 CSS，本实现选一张
典型 360dp 屏宽（360 − 左右 16dp 边距 ≈ 328，取 360 便于换算）的 App 卡
**360×144 作为设计空间**：

- 设计空间里逐值照抄 Dart 的 `height * 0.32`、`fontSize: 13`、`skew: 32`；
- 整卡用 `transform: scale(1120/360 = 28/9 ≈ 3.1111)` 放大到 1120×448；
- 卡片圆角 `12 × 28/9 ≈ 37.33px`（App `BorderRadius.circular(12)`）。

对应代码：`html.ts` 的 `APP_CARD_WIDTH` / `APP_CARD_HEIGHT` / `CARD_SCALE`、
`.card-inner { transform: scale(...) }`。Phigros 头部是 App 里再套一层
720×140 的 `FittedBox(fitHeight)`（`phigros_player_card.dart:52-53,188-205`），
本实现对应 `.p-header { transform: scale(0.36) }`（50.4 / 140 = 0.36）。

## 3. 三张卡的逐项映射

### 3.1 maimai → `PlayerInfoCard`

入口：`RankHub:lib/bootstrap/game_registry.dart:155-156` →
`MaimaiNetProfileCard` → `PlayerInfoCard`（无 `showGameBadge`，圆角 12）。

| App 事实 | 证据 | 本实现 |
| --- | --- | --- |
| 布局常量：padding `max(8, H*0.055)`、头像 `H*0.32`、rating 高 `avatar*0.46`、name 高 `avatar*0.46`、gap `avatar*0.08` | `player_info_card.dart:119-124` | `renderMaimaiCard()` 同名常量 |
| 背景板 cover（默认 frame 455203） | `:129-140`、`:39-40` | `.m-bg`；调用方 `frame` Buffer 优先，否则 `bg:maimai` 静态素材，再否则 `.m-bg-fallback` |
| 50% 起透明→黑 80% 渐变 | `:141-147`、`:259-275` | `.m-overlay`（`top:72px` = 50%，`rgba(0,0,0,.8)`） |
| 左上方形头像：圆角 8、白 75% 边框、阴影 blur 8 offset(0,2) | `:148-154`、`:277-321` | `.m-avatar`（`border-radius:8px`、`border:1px solid rgba(255,255,255,.75)`） |
| DX Rating 徽章高度 `avatar*0.46`，档位 `_assetIndex` 1..12，宽高比 `>=9 ? 600/126 : 662/128` | `:155-160`、`:409-471`、`:473-486` | `maimaiDxAssetIndex()`、`pickMaimaiBadge()`、`.m-rating` / `.m-rating-badge` |
| 数字：高 `badgeH*0.32`、宽 `h*20/27`、左区 0.38/0.515、右区 0.085、gap 0.039、top 0.36 | `:431-464` | `.m-digit` 内联定位（同公式） |
| 白色名字条：`white .94`、圆角 4、padding h8、阴影 blur 6、宽 `W*0.35`、字号 13 w700 #252525、`FittedBox scaleDown` 左对齐 | `:161-167`、`:323-363` | `.m-name` + `.fit-box[data-fit-origin=left]`（FittedBox 等价见 §5） |
| 右上最近同步：日期 10 w700、标签 8 w600「最近同步时间」、黑色 54% 阴影 | `:168-172`、`:365-407` | `.m-sync` / `.m-sync-date` / `.m-sync-label` |
| 右下 B35/B15：label 12 w600、值 Orbitron 24 w700、间距 24 | `:173-180`、`:197-257` | `.m-versions` / `.m-stat-label` / `.m-stat-value` |

### 3.2 phigros → `PhigrosPlayerCard`

入口：`game_registry.dart:190-191`。App 卡片是 5:2 静态视觉卡，难度是组件内
点击状态（默认 IN）；机器人用**用户偏好**（契约 `difficulty`）代替点击。

| App 事实 | 证据 | 本实现 |
| --- | --- | --- |
| 曲绘背景 `BoxFit.fitWidth`（纵向裁切）；未选曲绘 `grey900` | `phigros_player_card.dart:161-173` | `.p-bg`；无 Buffer 时 `.p-bg-fallback`（`#212121` = grey[900]） |
| 50% 透明 → 底部黑 60% 渐变 | `:174-187` | `.p-overlay` |
| 头部：高 `H*0.35`、宽 `headerHeight*720/140`、`left:-8`、`FittedBox(fitHeight,topLeft)` | `:52-53`、`:144-146`、`:188-205` | `.p-header`（720×140，`scale(.36)`，`left:-8px`） |
| 头部内容固定 720×140：背景平行四边形 `left:200`、skew 32、黑 50%；内容 padding `6/20/6/8` | `:352-459` | `.p-panel` / `.p-panel-content`（`clip-path` 同 skew） |
| 课题模式徽章：left 40 / top 12、字号 30、文本 `(rank%100).pad2`、段位 `rank~/100`、底图 1:绿 2:蓝 3:红 4:金 5:彩 其它白 | `:379-390`、`phigros_challenge_badge.dart:18-33,64-140` | `renderPhigrosChallenge()`；`.p-challenge` + `.p-challenge-img` |
| RKS 白底平行四边形：left 8 / bottom 8、skew 8、padding h16 v6、字号 26 w700 黑、文本 `b30Average.toStringAsFixed(4)` | `:393-416`、`:292-302` | `.p-rks` + `.p-rks-text` |
| 右上名字：右对齐、`maxWidth:300`、字号 32 w700 白、maxLines 1 ellipsis | `:420-454` | `.p-name-col` / `.p-name` |
| 左上头像：平行四边形 skew 24 白底、240×140、cover | `:460-493` | `.p-avatar`（clip-path skew 24） |
| 右下 CLEAR/FC/PHI：宽 `W*0.6` 高 `H*0.25`、skew 10、黑 50%、padding h12 v4、每项 `FittedBox scaleDown`、达成 16 bold + `/总数` 10 + 类别 9 w600 | `:206-232` | `.p-stats` / `.p-stat` / `.fit-box`（等价 scaleDown） |
| 难度平行四边形：`right:W*0.55`、宽 `W*0.2` 高 `H*0.3`、skew 12、颜色 = EZ #4CAF50 / HD #2196F3 / IN #F44336 / AT #000000、白字 bold | `:233-268`、`phigros_record_card.dart:8-18` | `.p-difficulty`（`data-difficulty` + 内联 `background`） |
| ASCII 用 Saira、非 ASCII 回退默认字体 | `phigros_text.dart:3-7,64-84` | `--font-saira`（Saira 在前，CJK 回退） |

### 3.3 arcaea → `ArcaeaPlayerInfoCard`

入口：`game_registry.dart:310-311`（注：任务书写的是 207，但 207 实际是
`MuseDashPlayerInfoCard`，当前代码 arcaea 在 310；以代码为准）。

| App 事实 | 证据 | 本实现 |
| --- | --- | --- |
| `bg_light.png` `BoxFit.fitWidth`（纵向裁切） | `arcaea_views.dart:1222`、`:1356-1362` | `.a-bg`（`top:50%` + `translateY(-50%)`） |
| 右侧 30% 黑渐变（center → centerRight） | `:1363-1376` | `.a-overlay`（`linear-gradient(90deg, transparent 50%, rgba(0,0,0,.3))`） |
| `hidden.png`：高度 `H*0.75`、左下对齐、`translate(-14,14)`、超出裁切 | `:1377-1391` | `.a-hidden`（`height:108px; left/bottom:-14px`） |
| 立绘：left 52 / bottom 12 / 宽 `H*0.75` / 高 H；顶部 padding `H*0.2`；`scale(3)`、origin `Alignment(0,-0.7)`（= 50%/15%）、`BoxFit.fill` | `:1392-1421` | `.a-char` → `.a-char-box`（`scale(3)`, `transform-origin:50% 15%`） |
| banner：高 `H*0.2`、left 12、按 564×74 等比、带投影 | `:1224-1226`、`:1422-1442` | `.a-banner`（`drop-shadow` 近似） |
| 名字在 banner 内：box `top:0,left:-28,width:bannerWidth,height:H*0.2`、右对齐 padding 8、Saira w300 13、白字黑阴影 | `:1443-1494` | `.a-name`（宽 = `height*0.2*564/74`） |
| 头像：`left = 12 + bannerWidth - 40`、`top:-10`、`height*0.4`、cover、跟随 alpha 的阴影 | `:1495-1522` | `.a-avatar`（`drop-shadow` 近似） |
| PTT 徽章：`right:-16,bottom:-8`、`avatar*0.7`、rating_0..7、白字 Saira 18/10 + 描边（徽章主色→黑 65%） | `:1523-1575`、`:1790-1818`、`:1822-1875` | `renderArcaeaPtt()`；`.a-ptt` / `.a-ptt-img` / `.a-ptt-value` |
| 右上同步：日期 Saira 10 w700、标签 8 w600、黑色 54% 阴影 | `:1576-1627` | `.a-sync` |
| B50/B10：`left:H*1.6, top:H*0.6`、label Saira 10 w600、B50 24 w700 / B10 24 w600、间距 18 | `:1628-1712` | `.a-bests` / `.a-stat*` |

## 4. 静态素材（`scripts/fetch-assets-card.mjs`）

渲染器**不发网络请求**；静态素材由脚本准备到 `vendor/card/**`，动态素材
（账号头像/banner、游戏图标、maimai 头像/背景板、phigros 头像/曲绘、arcaea 头像/立绘、
二维码）只从调用方 `Buffer` 来。素材缺失时逐项降级，不抛错。

| 素材 | 来源（脚本） | 落点 | 缺失时 |
| --- | --- | --- | --- |
| Saira Regular/Medium/SemiBold/Bold | `RANKHUB_APP_DIR/assets/fonts` → `vendor/arc/fonts` → Google Fonts 可变字体 | `vendor/card/fonts/` | 系统字体（`--font-display` 回退链） |
| Orbitron（可变字重） | App `assets/fonts/Orbitron-VariableFont_wght.ttf` | 同上 | maimai B35/B15 用系统字体 |
| Aldrich | phi-plugin 快照（旧版展示字体兜底） | 同上 | 忽略 |
| phi.ttf（Saira×思源黑体混合） | `vendor/phi/.../font/phi.ttf`（不复制） | 直接引用 | 默认不内联（8.4MB），`includePhiFont` 可开启 |
| maimai 默认背景板 frame 455203 | `assets2.lxns.net/maimai/frame/455203.png` | `vendor/card/backgrounds/maimai.png` | `.m-bg-fallback` 纯色 |
| arcaea `bg_light.png` / `hidden.png` | App `assets/arcaea/` | `vendor/card/arcaea/` | `.a-bg-fallback` / 不画 hidden |
| arcaea banner `online_banner_2026_07` | `static.rankhub.cc/arcaea/asset/img/course/banner/` | `vendor/card/arcaea/banner.png` | 不画 banner（名字仍显示） |
| arcaea rating 0..7 | `static.rankhub.cc/arcaea/asset/img/rating_{i}.png` | `vendor/card/arcaea/rating-{i}.png` | PTT 文字 + 半透明圆底 |
| phigros 课题徽章 green/blue/red/yellow/rainbow/white | App `assets/phigros/` | `vendor/card/phigros/` | 只显示段位数字 |
| maimai DX Rating 徽章 01..12 | App `assets/maimai/rating/`（12 档最全）→ 回退 `vendor/mai/pic/prism_plus`（仅 01..11） | `vendor/card/maimai/rating/` | 文字 rating 兜底（Orbitron） |
| maimai 数字 0..9 | App `assets/maimai/ra_num/`（20×27，卡片实际比例）→ 回退 `vendor/mai/pic/UI_NUM_Drating_*` | `vendor/card/maimai/num/` | 徽章内文字 rating |

脚本幂等：内容一致跳过；PNG/字体文件头 + 体积校验；`--force` 强制重建；
失败只告警（渲染可降级），不生成半套素材。

## 5. 已知差异与限制

1. **固定字号按参考卡放大**：App 的 dp 字号/偏移在 360dp 参考卡上按 28/9 放大。
   真机卡片宽度不是 360dp 时，App 的固定字号相对更小/更大，本实现无法同时匹配所有设备；
   我们选择 360dp（Android 最常见逻辑宽度）作为基准。
2. **FittedBox(scaleDown) 是页面内联 JS 模拟**：`.fit-box` 内的 `.fit-text` 在
   `document.fonts.ready` 后测量并 `scale()`（maimai 名字、phigros 达成统计、arcaea PTT）。
   渲染器在截图前会再调用一次；极端字体加载延迟下仍可能出现 1px 级差异。
3. **阴影是 CSS 近似**：Flutter `PhysicalShape(elevation)` 的材质阴影、`_alphaShadowedImage`
   的 alpha 跟随阴影，分别用 `filter: drop-shadow()` / `box-shadow` 近似，模糊半径与
   不透明度与 Flutter 不完全一致（视觉接近，不做像素级承诺）。
4. **默认字体不同**：App 里未指定 `fontFamily` 的文本（maimai 名字/统计标签/同步时间、
   phigros 达成统计、arcaea 同步标签）在 Android 是 Roboto、iOS 是 SF；本实现用
   `Helvetica Neue / Segoe UI / Arial + CJK 回退`。Saira / Orbitron 素材与 App 相同。
5. **同步时间固定 Asia/Shanghai**：App 用设备本地时区（`toLocal()`）；机器人没有用户
   设备时区，统一按产品主要用户时区格式化 `yyyy-MM-dd HH:mm`。
6. **Phigros 难度来源**：App 是组件内点击循环（EZ→HD→IN→AT）；机器人读用户偏好
   （契约 `difficulty`，默认 IN），三张卡都不做点击交互。
7. **游戏角标（showGameBadge）不画**：App「我的」页卡片默认 `false`；只有玩家详情页
   置顶卡才开，机器人不渲染。
8. **页面骨架是机器人扩展**：账号 banner/头像/图标条/二维码沿用 v1，不是 App
   「我的二维码」页的原样结构；卡片内部才是 1:1 对照对象。
9. **arcaea hidden/立绘的可见部分**依赖素材本身透明度与立绘构图；缺素材时顺序降级。
10. **素材缺失不报错**：渲染器只在诊断里返回 `missingStaticAssets`；`/me` 仍会出图。

## 6. 自定义素材如何进入卡片

所有游戏级图片都来自冻结契约 `PlayerCardRenderInput.cards[]` 的 `Buffer` 字段
（`src/contracts/index.ts`）：渲染器只做 MIME 嗅探 + `data:` URL 内联，不解析 URL、
不发网络请求。空 Buffer / `null` 视为「没有该素材」，按 App 的回退链降级。

| 入参字段 | 卡片图层（选择器） | 绘制顺序 / 尺寸 | 缺失或空 Buffer 时 |
| --- | --- | --- | --- |
| `maimai.frame` | `.m-bg`（`<img>`，`object-fit:cover`） | 卡片最底层（背景 → 渐变遮罩 → 头像/徽章/文字） | 回退静态 `vendor/card/backgrounds/maimai.png`（`bg:maimai`）；再缺则 `.m-bg-fallback`（`#1B1B1B` 近似 App `surfaceContainer`） |
| `maimai.avatar` | `.m-avatar img`（圆角 8、白 75% 边框） | 头像层，背景之上 | 回退内联 person 图标（App `Icon(Icons.person)`） |
| `phigros.background` | `.p-bg`（`<img>`，`BoxFit.fitWidth`：宽 100%、纵向居中裁切） | 背景 → 渐变遮罩 → 头部/统计/难度 | 回退 `.p-bg-fallback`（`#212121` = App `Colors.grey.shade900`） |
| `phigros.avatar` | `.p-avatar img`（平行四边形 skew 24、240×140、cover） | 头部图层内、面板之上 | 不绘制头像（保留平行四边形面板） |
| `arcaea.avatar` | `.a-avatar-img`（`object-fit:cover` + alpha 阴影近似） | 背景/hidden/立绘/banner 之后、PTT 徽章之下 | 回退 `.a-avatar-fallback`（App `ColoredBox(black26)` + person 图标） |
| `arcaea.characterArtwork` | `.a-char` → `.a-char-box img`（1080 立绘，`scale(3)`、origin 50%/15%、`BoxFit.fill`） | 背景 → 右侧渐变 → hidden → **立绘** → banner → 名字/头像 | 不绘制立绘（App `SizedBox.shrink()`）；没有动态「名片板」字段，banner/bg_light 是 App 内置静态素材 |
| 账号 `banner` / `avatar` / `qr` | `.hero-banner img` / `.hero-avatar img` / `.qr-img` | 页面骨架（机器人扩展，不属于卡片内部） | banner 用 `RankHub` 文案底、头像用首字母渐变、二维码整块不渲染 |

要点：

- **优先级**：调用方 Buffer > `vendor/card/**` 静态素材 > 纯色/图标/文字兜底。
  maimai 的 `frame` 只要非空就一定覆盖默认背景板（`renderMaimaiCard()` 里
  `toDataUrl(card.frame) ?? lookup.get('bg:maimai')` 的短路顺序）；
- **只认字节**：`toDataUrl()` 按 PNG/JPEG/GIF/WebP 魔数嗅探 MIME，未知格式按 PNG 交给
  Chromium；解码失败只让该元素空白，不影响其余版式；
- **可测试性**：`test/render/card-fixtures.ts` 的 `customMaimaiFrame()` /
  `customPhigrosCover()` / `customArcaeaArtwork()` / `customArcaeaAvatar()` 生成高对比
  条纹+标记素材；`card.test.ts` 的「自定义素材…真的覆盖默认」用例对同一区域做平均色
  抽样（`averageColor` / `colorDistance`），断言与默认/纯色截图的颜色距离 > 30，
  并断言 PNG 字节不同、卡片盒仍为 1120×448；
- **证据图**：`evidence/qqbot/card-v2/custom-{maimai,phigros,arcaea}.png`
  （1120×448，由 `renderGameCardDetail()` 直接截 `.game-card`）；
- 回归：`pnpm test:render`（含自定义素材用例）。渲染器本身无改动即满足需求；
  若后续把「arcaea 名片板」做成动态素材，需要先在冻结契约里加字段再改渲染层。

## 7. 验证

```bash
pnpm assets:card     # 准备 vendor/card 静态素材（幂等）
pnpm test:render     # 渲染测试（三张卡结构/5:2/素材/降级/自定义素材生效）
```

- 单卡证据：`../../RankHubWorkspace/evidence/qqbot/card-v2/{maimai,phigros,arcaea}.png`
  （1120×448，直接由 `renderGameCardDetail()` 截 `.game-card` 元素）。
- 自定义素材证据：同目录 `custom-{maimai,phigros,arcaea}.png`（1120×448）；测试对
  自定义 vs 默认/纯色做抽样平均色比较（颜色距离 > 30）与 PNG 字节比较。
- 整页证据：同目录 `me.png`；README 展示图 `docs/images/me-card.png`（1200×约 3400）。
- 测试断言：三卡实测盒子 1120×448（5:2）、`scrollWidth <= 1200`、素材 key 真实被引用、
  字体（Saira/Orbitron）加载成功、空素材目录降级、超长文本不溢出。
