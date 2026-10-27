# rankhub-qqbot

RankHub 的 QQ 查分机器人：QQ 官方机器人 API v2（WebSocket 网关 + 被动回复）+ RankHub Open API（设备码 OAuth + `/v1/games/**`）。

## 能力（首版，只读）

| 指令 | 说明 |
| --- | --- |
| `/help` | 指令与绑定说明 |
| `/bind` | RankHub 设备码绑定（在 RankHub App 内确认） |
| `/unbind` | 撤销令牌并删除本地绑定 |
| `/me` | 已绑定身份与各游戏档案摘要 |
| `/b50` | maimai b50 图片（照搬 maimaiDX 的绘制方案） |
| `/rks` | phigros b19/rks 图片（照搬 phi-plugin 的 b19 模板） |
| `/best <game>` | 任意游戏最佳成绩（文字） |
| `/score [game] <关键词>` | 在本人成绩里按曲名模糊查（文字） |
| `/games` | 服务端能力矩阵 |
| `/status` | 绑定与运行状态 |

只申请 `openid profile offline_access game:read`；第三方只能读**授权用户本人**的数据。

## 结构

```
src/
  contracts/  冻结接口（QQ / RankHub / Store / Renderer）
  config/     env 校验
  logger/     JSON lines + 脱敏
  qq/         AccessToken、REST、WebSocket 网关、被动回复
  rankhub/    设备码、games client、错误映射
  store/      node:sqlite + AES-256-GCM
  render/phi/ phi-plugin b19 模板 + Playwright
  render/mai/ maimaiDX b50（Node 移植，或 Python sidecar）
  commands/   指令实现
  bot/        装配与事件管线
scripts/      资产拉取/校验、live 冒烟
vendor/       素材缓存（gitignore，见 scripts/fetch-assets.mjs）
```

## 起步

```bash
pnpm install
cp .env.example .env.local   # 填入 QQ_APP_SECRET / RANKHUB_CLIENT_SECRET / TOKEN_ENC_KEY
pnpm assets:fetch            # 拉取 phi-plugin b19 素材、maimaiDX 资源包、phigros 曲绘
pnpm typecheck && pnpm test
pnpm start
```

- `TOKEN_ENC_KEY`：`openssl rand -base64 32`
- `pnpm assets:fetch` 会下载 maimaiDX `Resource CN1.55.7z`（约 467MB），可用 `MAIMAIDX_STATIC` 复用已有资源包。
- 本地假 QQ / 假 RankHub 的联调见 `test/e2e`。

## 许可与署名

本项目以 **GPL-3.0-or-later** 发布：phigros 渲染复用了 [phi-plugin](https://github.com/Catrong/phi-plugin)（GPL-3.0）的 b19 模板与素材；maimai 渲染移植/复用了 [maimaiDX](https://github.com/Yuri-YuzuChaN/maimaiDX)（MIT）的绘制方案与素材。详见 `NOTICE`。
