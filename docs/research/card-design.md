# /me 玩家名片设计：对齐 App「我的二维码」与「我的」

渲染实现：`src/render/card/`（HTML + Playwright 截图，1200 宽、高度自适应）。
本文件记录版式与 App 的对应关系；改动视觉时同步更新。

## 1. 整体结构（对齐 App 二维码页）

参考 `RankHub/lib/pages/user/my_qr_code_page.dart` 的 `_ProfileQrCard`：

| 区域 | App 事实 | 本实现 |
| --- | --- | --- |
| 深色底 | `Card` + `colorScheme.surface`，圆角 8、1px outline（`my_qr_code_page.dart:248-259`） | 近黑背景（`#000`）+ 卡片圆角，深色主题 |
| 顶部 banner | 高 164，`Positioned.fill(bottom: 32)`，缺省用 `colorScheme.surfaceContainerHighest`（`:264-283`） | banner 区 + 底部暗色遮罩；无图时用主题渐变 |
| 圆形头像 | 半径 38（有头像框 76），叠在 banner 下沿左侧（`:285-307`） | 圆形头像压边（banner 下沿） |
| 名字/UID/bio | `titleLarge` bold / `UID · …` / bio（`:319-380`） | 同结构；UID 仅当 `/v1/me/profile` 可用 |
| 二维码 | 白色圆角容器 + `PrettyQrCode`（`:430-460`），仅公开账号展示 | 白底圆角二维码块放最底部；非公开不渲染 |

差异（按需求）：App 卡片二维码位置在 UID/bio 下方；机器人把**二维码移到最底部**，原位置换成「已绑定游戏」圆形图标条。

## 2. 游戏图标条

- 图标来源：`rankhub-website/assets/icons/{maimai,phigros,arcaea}-icon.png`
  （网站 `components/game-icon.tsx` 的 `GAME_ICONS` 同一份资产），已复制到 `vendor/card/icons/`。
- 圆形裁剪 + 横向等距排列，替代 App 卡片的二维码区。

## 3. 游戏档案卡（对齐 App「我的」页）

App 每款游戏的「我的」卡片由 `game_registry.dart` 的 `profileCardBuilder` 决定：

| 游戏 | App 卡片 | 版式要点 | 本方数据 |
| --- | --- | --- | --- |
| maimai | `lib/modules/maimai/widgets/maimai_net_profile_card.dart` → `PlayerInfoCard` | 5:2 横向卡、背景框图、头像、rating、段位/CLASS/星级 | `describeProfile()`：`rating` + 段位/CLASS/星级/机台 ID |
| phigros | `lib/modules/phigros/widgets/phigros_player_card.dart` | 5:2 曲绘背景、头像、RKS、课题模式 | `rating`（rks）+ 课题模式/版本/Object ID |
| arcaea | `lib/modules/arcaea/widgets/arcaea_views.dart` 的 `ArcaeaPlayerInfoCard` | 5:2 背景（nameplate/character）、头像、Potential、B30/B50 | `rating`（Potential）+ B30/B50 均值/搭档/Arcaea ID |

卡片内的数据约定（调用方 `/me` 负责填）：

- `title` = 玩家名；`subtitle` = 「游戏名 · 评分体系」（如 `maimai DX · DX rating`）；
- `rating` = 大号分数（maimai 整数 / phigros 3 位小数 / arcaea 2 位小数）；
- `fields` = 2~4 个统计小块；
- `background` = 游戏背景图（arcaea nameplate、phigros 曲绘；maimai 缺省 → 主题渐变）。

## 4. 降级与限制

- 无 banner/头像/二维码/背景：仍输出 1200 宽 PNG，缺图用主题渐变色与首字母占位。
- 超长昵称/bio/字段：CSS 截断，`scrollWidth <= 1200`（单测断言）。
- 输出 > 4.5MB 时降级 JPEG q90（QQ 图片链路上限）。
- 中文依赖系统字体（Docker 镜像内有 `fonts-noto-cjk`）。
