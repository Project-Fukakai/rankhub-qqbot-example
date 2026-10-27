# 档案展示模型（profile model）：头像 / 背景 / 名片字段

> 目标：为 `/me` 玩家名片提供「每游戏的头像、背景、特定展示字段」。
> 实现：`src/rankhub/profile.ts` 的 `describeProfile(game, profile, format?)`。
> 单测：`test/unit/rankhub/profile.test.ts`（fixture 驱动，无网络）。
>
> **证据纪律**：本文每条结论都带 `仓库:文件:行号`；外部事实带 `URL + retrieved_at`。
> 取不到证据的一律进文末「未知项」，不做推测。

## 0. 证据版本

| 仓库 | 分支 | commit | 说明 |
| --- | --- | --- | --- |
| `RankHub`（App，Flutter） | `fix/auth-logout-20261026` | `62a117f` | 资产 URL 规则的权威来源 |
| `rankhub_net`（后端） | `fix/identity-refresh-unbound` | `1bc26678` | v1 wire 形状与 `/format` 元数据 |
| `rankhub-qqbot`（本仓库） | `main` | `02dc64d` | 消费方 |

`retrieved_at`：`2026-10-27T10:33:49Z`（读取上述提交的工作树）。
CDN 探测时间：`2026-10-27T10:32:14Z`（见 §2.4）。

## 1. 结论摘要

| 游戏 | `rating` 来源 | 头像 `avatarUrl` | 背景 `backgroundUrl` | `fields` |
| --- | --- | --- | --- | --- |
| maimai | `player.rating`（DX Rating） | ⚠️ 规则已实现（`native.avatar_url`），**今天 v1 不下发** ⇒ `null` | 无此概念（`name_plate` 是收藏品对象）⇒ 恒 `null` | 段位 / CLASS / 星级 / 机台 userId / 好友码 |
| phigros | `player.rating`（rks） | ⚠️ 规则已实现（`avatar_asset_key`），**今天 v1 不下发** ⇒ `null` | ⚠️ 规则已实现（`background_song_id` 曲绘），**今天 v1 不下发** ⇒ `null` | 课题模式 / 游戏版本 / Object ID / Short ID |
| arcaea | `player.rating`（Potential） | ✅ 今天可得：`avatar` 缺失时回落**搭档图标**（`character`） | ⚠️ 规则已实现（`nameplate`），**今天 v1 不下发** ⇒ `null` | 搭档 / Course / Best30 均值 / Best50 均值 / Arcaea ID / 好友码 |
| 未知游戏 | 透传 | `null` | `null` | `[]`（不猜） |

`isPublic` 一律从 `profile.isPublic` 顶层透传（`rankhub_net/apps/backend/src/v1-games/dto/v1-games.types.ts:74`）。

## 2. 资产 URL 规则（以 App 代码为准）

三类来源，优先级从高到低；实现见 `src/rankhub/profile.ts` 的 `normalizeAssetUrl` /
`phigrosAssetKeyUrl` / `arcaeaAssetUrl`。

### 2.1 RankHub 相对资产路径 → `normalizeAssetUrl`

App 权威实现：`RankHub/lib/services/api/rankhub_api_service.dart:1437-1452`
（`_normalizeAssetUrl`），四个分支：

| 输入 | 输出 | 依据 |
| --- | --- | --- |
| `http(s)://…` | 原样 | `rankhub_api_service.dart:1442-1444` |
| `/v0/…`（正则 `^/v\d+(?:/|$)`） | `hostOrigin + 网关前缀 + 原路径` | `:1445-1447`；正则见 `:1476-1478` |
| 其它 `/…` | `hostOrigin + 原路径` | `:1448-1450` |
| 其它相对路径 | `hostOrigin + '/' + 原路径` | `:1451` |

- `hostOrigin` = `originOf(baseUrl)`，`网关前缀` = `gatewayPathOf(baseUrl)`：
  `rankhub_api_service.dart:27-28` 转发到
  `RankHub/packages/rankhub_net_api_client/lib/src/net/net_defaults.dart:66-70`（origin，端口只在显式声明时保留）
  与 `:80-92`（网关前缀；`https://net.rankhub.cc/api/v0` → `/api`，`http://127.0.0.1:9528/v0` → `''`）。
- 基址默认值 `https://net.rankhub.cc/api/v0`：`net_defaults.dart:26-29`（`RankHubDefaults.baseUrl`），
  由 `rankhub_api_service.dart:22` 转发。
- 因此 `/v0/assets/abc/content?v=1` → `https://net.rankhub.cc/api/v0/assets/abc/content?v=1`。
- 服务端侧该路径形态的证据：`rankhub_net/apps/backend/src/social/social.service.ts:1635-1638`
  （`getAssetContentUrl` 返回 `/v0/assets/{assetId}/content?v={updatedAt 毫秒}`）。
- `ASSETS_S3_PUBLIC_BASE_URL` 生效时，后端把资产直连成**绝对 URL**
  （`rankhub_net/apps/backend/src/assets/storage/s3-asset-storage.service.ts:50-51` 读配置、
  `:132-145` 拼 `${publicBaseUrl}/${bucket}/${key}`），此时走「绝对直通」分支。
  配置项声明见 `rankhub_net/apps/backend/src/config/config.module.ts:195`，
  默认空值见 `rankhub_net/.env.example:338`。

> 本模块的默认基址与 App 同源；调用方可传 `options.assetBaseUrl` 覆盖（测试里用
> `http://127.0.0.1:9528/v0` 与 `https://net.rankhub.cc/api/v1` 两种基址锁定了行为）。

### 2.2 phigros 资源键 → `static.rankhub.cc`

App 权威实现：`RankHub/lib/models/phigros/asset_url.dart`

- `asset(key)`（`:28-38`）：`{gameBase}/asset/{key 各段}`，**最后一段无条件追加后缀**（`:36`）；
  每段做百分号编码（单测断言 `#` → `%23`，`RankHub/test/modules/phigros/phigros_asset_models_test.dart:25-28`）。
- 后缀选择（`:73-78`）：`.json`/`.txt` → `txt`；`.wav`/`.ogg` → `ogg`；其余 → `jpg`。
  默认值 `jpg` 见 `:8`。
- `baseUrl` = `GameAssetsConfig.gameBase('phigros')`（`:6`）=
  `https://static.rankhub.cc/phigros`（`RankHub/lib/config/game_assets_config.dart:5,7`）。
- 头像：`avatar(addressableKey)` = `asset(key)`（`asset_url.dart:69`）；
  取值优先级 `avatar_asset_key` → 非绝对 URL 的 `avatar`
  （`RankHub/lib/modules/phigros/models/phigros_net_models.dart:98-106`：绝对 URL 时返回 `null`）。
- 背景（曲绘）：`songImage(songId)` = `asset('Assets/Tracks/{songId}/Illustration.jpg')`（`:40-61`），
  名片里的调用点 `RankHub/lib/modules/phigros/widgets/phigros_player_card.dart:153-156`。

### 2.3 arcaea 资源路径 → `static.rankhub.cc`

App 权威实现：`RankHub/lib/modules/arcaea/models/arcaea_models.dart:51-77`

- `partnerIconUrl`（`:51-59`）：`{gameBase}/asset/char/{encodeComponent(character)}_icon.png`
  （`character` 为空 → `null`）。
- `avatarUrl`（`:61-68`）：`avatar` 为空 → 回落 `partnerIconUrl`；
  否则去掉 `assets/` 前缀 → `GameAssetsConfig.resolve('arcaea', '/asset/' + 路径)`。
- `nameplateUrl`（`:70-77`）：同上去前缀规则，空 → `null`。
- `GameAssetsConfig.resolve`（`RankHub/lib/config/game_assets_config.dart:9-17`）：
  绝对地址直通，否则 `{origin}/{game}` + 路径（origin = `https://static.rankhub.cc`，`:5`）。

### 2.4 CDN 探测（验证「双后缀」不是笔误）

App 单测 `RankHub/test/modules/phigros/phigros_asset_models_test.dart:12-16` 断言曲绘是
`…/Illustration.jpg.jpg`。为排除「App 单测写错」的可能，对生产 CDN 做只读 `HEAD`：

```bash
curl -s -I -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://static.rankhub.cc/phigros/asset/Assets/Tracks/Glaciaxion.SunsetRay.0/Illustration.jpg
curl -s -I -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://static.rankhub.cc/phigros/asset/Assets/Tracks/Glaciaxion.SunsetRay.0/Illustration.jpg.jpg
curl -s -I -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://static.rankhub.cc/phigros/asset/avatar.Introduction.jpg
curl -s -I -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://static.rankhub.cc/arcaea/asset/char/0_icon.png
```

`retrieved_at = 2026-10-27T10:32:14Z`，结果：

| URL | 状态 | Content-Type |
| --- | --- | --- |
| `…/Illustration.jpg` | **404** | text/html |
| `…/Illustration.jpg.jpg` | **200** | image/jpeg |
| `…/avatar.Introduction.jpg` | **200** | image/jpeg |
| `https://static.rankhub.cc/arcaea/asset/char/0_icon.png` | **200** | image/png |

结论：CDN 的真实布局就是「最后一段追加后缀」，与 App 单测一致；本模块照抄。

## 3. v1 wire 上真正的 `player.native` 键（决定「今天能不能取到」）

`GET /v1/games/{game}/profiles` 的档案形状：`v1-games.types.ts:67-95`（`GameProfileDto`），
其中 `player` 只有 `name` / `rating` / `native` 三个键（`:55-65`），`native` 是「游戏原生玩家对象，未归一」。

`native` 的键名是**各 adapter `buildPlayer(...)` 的字面量**，不是上游 API 的 snake_case：

| 游戏 | `player.native` 实际键 | 证据 |
| --- | --- | --- |
| maimai | `userId` `friendCode` `courseRank` `classRank` `star` | `rankhub_net/apps/backend/src/v1-games/adapters/maimai.adapter.ts:182-188` |
| phigros | `objectId` `shortId` `challengeModeRank` `gameVersion` | `rankhub_net/apps/backend/src/v1-games/adapters/phigros.adapter.ts:163-177`（`buildPlayer` 在 `:166-171`） |
| arcaea | `arcaeaId` `course` `character` `friendCode` `b30Avg` `b50Avg` | `rankhub_net/apps/backend/src/v1-games/adapters/arcaea.adapter.ts:153-167`（`:160-167`） |

`/format` 的声明与之一致（`profile.nativeFields` 的定义就是「adapter 输出键名」，
`v1-games/formats/game-format.types.ts:104-105`）：

| 游戏 | `/format` 的 `profile.nativeFields` | `identityFields` | 证据 |
| --- | --- | --- | --- |
| maimai | `courseRank` `classRank` `star` | `friendCode` `userId` | `v1-games/formats/game-format.registry.ts:133-147` |
| phigros | `challengeModeRank` `gameVersion` | `objectId` `shortId` | `:267-280` |
| arcaea | `course` `avatar` `nameplate` `b30Avg` `b50Avg` | `arcaeaId` `character` `friendCode` | `:197-214` |

端点：`GET /v1/games/{game}/format`（`v1-games/v1-games.controller.ts:118-121`），
`profile.fields` 今天恒为 `name` + `rating`（`game-format.types.ts:102`）。

### 3.1 ❗ 缺口：v1 的读取链路上没有头像/背景

| 想要的字段 | v0（第一方）有 | v1 adapter 是否输出 | 证据 |
| --- | --- | --- | --- |
| phigros `avatar_asset_key` | ✅ `phigros.types.ts:35`；由 `avatar_name` 查曲库得到，`phigros-profile.service.ts:859-877` | ❌ | `phigros.adapter.ts:166-171` 只挑 `objectId`/`shortId`/`challengeModeRank`/`gameVersion` |
| phigros `background_song_id` | ✅ `phigros.types.ts:69`；`serializeProfile` 带出，`phigros-profile.service.ts:901-914`（`:907`） | ❌ | 同上（`buildPlayer` 没这个键） |
| arcaea `avatar` / `nameplate` | ✅ `arcaea.types.ts:28-29`；`playerFromProfile` 带出，`arcaea-profile.service.ts:909-922`（`:919-920`） | ❌ | `arcaea.adapter.ts:160-167` |
| maimai `avatar_url` | ✅（存在 `player_json`）`maimai-dx.types.ts:154-155` | ❌ | `maimai.adapter.ts:182-188` |

补充事实：

- v1 的 `PATCH .../profiles/{id}` **允许写** arcaea `avatar`/`nameplate`
  （`v1-games.service.ts:351-352` → `arcaea.adapter.ts:117-123`），
  也允许 phigros 写 `challenge_mode_rank`/`game_version`
  （可写键表 `games/native-input/index.ts:176-190`）；
  但**写进去以后读不出来** —— 读路径的 `buildPlayer` 没包含它们。这是「写读不对称」缺陷。
- phigros 的 `avatar_asset_key` / `background_song_id` **连写都不支持**：
  v1 可写展示键只有 `challenge_mode_rank` / `game_version`（`native-input/index.ts:187-190`），
  后端注释亦明确「`avatar*` → 忽略」（`games/native-input/phigros.ts:14`）。

因此：**今天只靠 v1，三游戏的头像与背景基本拿不到**（唯一例外是 arcaea 用 `character`
回落出的搭档图标，见 §4.3）。本模块按 v0/App 的键名做了前向兼容读取：后端只要在
adapter 的 `buildPlayer` 里补一行键（例如 phigros `avatarAssetKey` / `backgroundSongId`、
arcaea `avatar` / `nameplate`、maimai `avatarUrl`），本仓库**不需要改代码**即可生效。
该缺口登记为未知项 U1（§7），需 Lead 决策（改后端 adapter / 改走 v0 端点 / 暂不做头像）。

## 4. 逐游戏逐字段映射（实现口径）

通用：

- 值读取顺序 = **v1 camelCase 键在前，v0/display 的 snake_case 兜底**
  （snake_case 键的来源：v0 类型 `phigros.types.ts:28-36`、`arcaea.types.ts:21-30`、
  `maimai-dx.types.ts:141-157`；v1 可写展口键表 `games/native-input/index.ts:176-190`）。
- 数字 → 十进制字符串（`challengeModeRank` 例外，按下表解码）；布尔 → `是`/`否`；
  空串、字面量 `'null'`、对象/数组 → 不展示（与 App `_readNullableString` 同口径，
  `rankhub_api_service.dart:1614-1620`）。
- 数值 `0` **原样展示**（不擅自当「未设置」）：App 在 maimai 段位图上把 `0` 当无图
  （`RankHub/lib/modules/maimai/pages/maimai_b50_export_page.dart:254,258-259`），
  但字段是数据而不是图片，隐藏 `0` 属于展示策略，交给调用方决定。
- 传了 `format` 时**只展示它声明过的键**（`nativeFields ∪ identityFields`）；
  没传则用内置规格（等于信任 adapter 输出键名）。头像/背景不受该过滤影响。

### 4.1 maimai

| 展示 label | 来源键（优先→兜底） | 依据 |
| --- | --- | --- |
| 段位 | `courseRank` → `course_rank` | `maimai.adapter.ts:185`；语义 `game-format.registry.ts:143` |
| CLASS | `classRank` → `class_rank` | `:186`；语义 `registry.ts:144` |
| 星级 | `star` | `:187`；语义 `registry.ts:145` |
| 机台 userId | `userId` → `user_id` | `:183` |
| 好友码 | `friendCode` → `friend_code` | `:184` |

- `rating` ← `player.rating`（`maimai.adapter.ts:182`；评分体系名 `DX Rating`，`registry.ts:126-131`）。
- 头像：无 v1 键；前向兼容读 `native.avatar_url` / `native.avatarUrl`
  → `normalizeAssetUrl`（类型注释表明它是 URL：`maimai-dx.types.ts:154-155`）。
- 背景：**恒 `null`**。`name_plate` 是收藏品对象 `{id,name,color,…}`（`maimai-dx.types.ts:127-133`、`:152`），
  不是图片地址；不把对象拼成 URL。

### 4.2 phigros

| 展示 label | 来源键（优先→兜底） | 依据 |
| --- | --- | --- |
| 课题模式 | `challengeModeRank` → `challenge_mode_rank` | `phigros.adapter.ts:169`；语义 `registry.ts:277`；解码见下 |
| 游戏版本 | `gameVersion` → `game_version` | `:170`；语义 `registry.ts:278` |
| Object ID | `objectId` → `object_id` | `:167`；`registry.ts:269` |
| Short ID | `shortId` → `short_id` | `:168`；`registry.ts:270` |

课题模式解码（App 权威：`RankHub/lib/models/phigros/player_summary.dart:35-70`）：

- 三位数：百位 = 段位等级（1 绿 / 2 蓝 / 3 红 / 4 金 / 5 彩，`:46-63`），后两位 = 总难度（`:44`）；
- `0` → `未参与`（`:68`）；
- 例：`316` → `红 16`；`102` → `绿 2`。

- `rating` ← `player.rating`（`phigros.adapter.ts:166`，取 `summary.rks`；评分体系名 `rks`，`registry.ts:261-266`）。
- 头像：`avatar_asset_key`（native 或 v0 顶层）→ `PhigrosAssetUrl.avatar`；
  回落 `avatar`（**绝对 URL 时返回 `null`**，同 App `phigros_net_models.dart:98-106`）。
- 背景：`background_song_id`（native 或 v0 顶层）→ `songImage`（`Illustration.jpg.jpg`）。
  顶层键存在性的证据：v0 形状 `phigros_net_models.dart:12-39`、`phigros.types.ts:69`。

### 4.3 arcaea

| 展示 label | 来源键（优先→兜底） | 依据 |
| --- | --- | --- |
| 搭档 | `character` | `arcaea.adapter.ts:163`；`registry.ts:200` |
| Course | `course` | `:162`；`registry.ts:208` |
| Best 30 均值 | `b30Avg` → `b30_avg` | `:165`；`registry.ts:211` |
| Best 50 均值 | `b50Avg` → `b50_avg` | `:166`；`registry.ts:212` |
| Arcaea ID | `arcaeaId` → `arcaea_id` | `:161`；`registry.ts:199` |
| 好友码 | `friendCode` → `friend_code` | `:164`；`registry.ts:201` |

- `rating` ← `player.rating`（`arcaea.adapter.ts:160`，取 `potential.potential`；评分体系名 `Potential`，`registry.ts:191-196`）。
- 头像：`avatar` → `arcaea_models.dart:61-68`；**`avatar` 为空时回落搭档图标**
  `…/asset/char/{character}_icon.png`（`:51-59`）—— 这条回落是今天唯一「真实可得」的头像。
- 背景：`nameplate` → `arcaea_models.dart:70-77`。

## 5. 与 `/format` 的关系

`describeProfile` 的第三个参数就是 `GET /v1/games/{game}/format` 的 `data`：

1. **字段白名单**：`profile.nativeFields` ∪ `profile.identityFields` 的 `name` 即允许展示的键。
   给了 format 就按它过滤 —— 避免把后端内部键当名片字段画出去；`format` 未来加键时本模块自动跟上。
2. 内置规格里 `canonical` 与 format 的 `name` 逐字一致（见 §4 各表），
   所以「用 format 过滤」与「不用 format」在今天的线上数据上结果相同（单测有断言）。
3. 已知取舍：maimai 的 `userId` / `friendCode` 在 `nativeFields` 里没有，只在 `identityFields` 里，
   所以白名单是两者的并集。
4. 若 backend 把头像/背景加进 `nativeFields`，它们会进入**白名单**但不会进 `fields`
   （本模块把它们当 URL 处理，见 §4），不会出现「一大串 asset key 当字段」的问题。

## 6. 复跑

```bash
cd /Users/qianmo/personal/projects/rankhub-qqbot
pnpm typecheck
pnpm exec vitest run test/unit/rankhub/profile
```

结果（2026-10-27T10:36Z 本地）：`tsc --noEmit` 0 错误；`profile.test.ts` 24 passed。

单测覆盖：三游戏完整映射、缺字段 / `native: null` / `rating: null`、未知游戏、
format 过滤、四支 URL 归一、`originOf`/`gatewayPathOf`、`static.rankhub.cc` 双后缀、
arcaea 搭档图标回落、纯函数不改输入。

## 7. 未知项（`unknown`，不猜）

| ID | 未知项 | 已知证据 | 影响 / 建议 |
| --- | --- | --- | --- |
| U1 | v1 何时/是否暴露头像与背景（phigros `avatar_asset_key`/`background_song_id`、arcaea `avatar`/`nameplate`、maimai `avatar_url`） | §3.1：v0 有、v1 adapter 未输出 | 阻塞「名片有头像/背景」这一半目标。建议 Lead 决策：①后端 adapter 各补一行（最小改动，且 `/format` 同步补声明）；②本 bot 改走 v0 端点（越权，需评估）；③先接受空图 |
| U2 | arcaea `nameplate` 线上真实取值形态（是否带 `assets/` 前缀、是否含子目录） | 规则来自 `arcaea_models.dart:70-77` + 资源索引形如 `assets/char/0_icon.png`（`RankHub/test/modules/arcaea/arcaea_models_test.dart:158-163`） | 无线上样本；实现按 App 规则去前缀，若线上值形态不同会 404（不影响不崩） |
| U3 | phigros `avatar_asset_key` 的真实取值集合（addressable key 示例） | App 单测只给了 `avatar.Introduction`（`phigros_asset_models_test.dart:29-32`），CDN 实测 200 | 规则已锁定；取值集合未知，不需要改代码 |
| U4 | 生产是否配置 `ASSETS_S3_PUBLIC_BASE_URL`（影响资产是绝对 URL 还是 `/v0/...` 相对路径） | `.env.example:338` 为空默认；`s3-asset-storage.service.ts:132-145` 两支都实现了 | 两种形态本模块都兼容（直通 / 归一），无需改代码 |
| U5 | bot 是否应把资产基址接到自己的配置（当前配置里没有这个键） | `src/config/index.ts` 只有 `RANKHUB_API_BASE`（v1 BFF 域），而资产在 v0 域 | 本模块默认取 App 常量 `https://net.rankhub.cc/api/v0`，并允许 `options.assetBaseUrl` 覆盖；未改配置（不在本任务写作用域） |
