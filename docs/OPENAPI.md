# RankHub Open API 用法（本仓库的可运行示例）

本文件把机器人里**真实在用**的 RankHub Open API 调用、鉴权与错误处理逐条对应到代码，
方便作为第三方接入示例阅读。所有结论都以代码/线上探测为依据（见文末证据）。

## 0. 客户端身份

- 控制台创建「第三方应用」后得到 `client_id` / `client_secret`；
- 第三方应用**只能读授权用户自己的数据**，且必须由用户在 RankHub App 内确认授权；
- 令牌端点在 `RANKHUB_AUTH_BASE`（生产 `https://auth.rankhub.cc`），
  业务端点在 `RANKHUB_API_BASE`（生产 `https://api.rankhub.cc`）。

对应代码：`src/config/index.ts`（env schema）、`src/rankhub/http.ts`（统一请求/错误映射）。

## 1. 两种绑定（授权）流程

### 1.1 设备码（RFC 8628）

```
POST {AUTH}/v1/oauth/device_authorization   client_id, scope
  → 200 { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
用户打开 verification_uri_complete（RankHub 确认页）并确认
POST {AUTH}/v1/oauth/token
  grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=...&client_id=...&client_secret=...
  → 200 {access_token,refresh_token,expires_in}  |  200 {error:"authorization_pending"|"slow_down"}  |  400 {error:"expired_token"|"access_denied"}
```

实现：`src/rankhub/device-flow.ts`、`src/rankhub/poll.ts`。
注意：`authorization_pending` / `slow_down` 是 **HTTP 200 + body.error**，不是 4xx。

### 1.2 授权码 + App 扫码（本仓库当前默认）

设备码确认页在服务端历史上存在缺陷（见 `docs/DECISIONS.md` D-20261027-02/03），
因此 `/bind` 改用服务端到服务端的授权请求，用户在 App 内确认：

```
POST {AUTH}/v1/interaction/oauth-authorizations
  {clientId, redirectUri, responseType:"code", scope, state}
  → 201 {pollToken, deepLink, deepLinkQrCodeDataUrl, expiresAt, client, permissions}
机器人把 deepLinkQrCodeDataUrl 作为图片发给用户；用户在 RankHub App 扫码确认
POST {AUTH}/v1/interaction/oauth-authorizations/status  {pollToken}
  → 200 {status:"pending"|"approved"|..., resumeUrl}
approved 时 resumeUrl = <redirectUri>?code=...&state=...
POST {AUTH}/v1/oauth/token
  grant_type=authorization_code&code=...&redirect_uri=...&client_id=...&client_secret=...
  → 200 {access_token,refresh_token,expires_in,scope,id_token}
```

实现：`src/rankhub/oauth-code.ts`、`src/commands/bind.ts`。
`redirectUri` 只作为 code 载体，必须在应用上注册（示例默认 `http://127.0.0.1:17830/callback`）。

## 2. 令牌生命周期

- 访问令牌默认 **600 秒**（`expires_in`），过期前用刷新令牌换新；
- 刷新是**轮换**语义：旧 refresh token 用一次即失效，因此刷新必须单飞（single-flight），
  否则并发刷新会把整族令牌撤销。
- 实现：`src/rankhub/refresh.ts`（`createRankHubClient.authorize()` 内做单飞 + 提前 60s 刷新）。

## 3. 业务接口

| 接口 | 说明 | 代码 |
| --- | --- | --- |
| `GET {API}/v1/games` | 当前用户可读的游戏列表（含 `read` 权限位） | `src/rankhub/games.ts` |
| `GET {API}/v1/games/{game}/profiles` | 档案列表（`profileId`、玩家名、rating、更新时间） | 同上 |
| `GET {API}/v1/games/{game}/profiles/{id}/bests` | B50/B30/phi 分桶与总分（`buckets` + `totals`） | 同上 |
| `GET {API}/v1/games/{game}/profiles/{id}/scores` | 逐曲成绩，`limit`/`cursor`/`sortBy`/`order` 分页 | `src/commands/score.ts` |

响应统一为 `{code, message, data, requestId}` envelope；分页用 `nextCursor` + `hasMore`。
错误映射见 `src/rankhub/errors.ts`：`401 unauthorized`、`403 firstPartyOnly`、
`429 rate_limited`（读 `Retry-After`）、`5xx server_error`。

## 4. 数据 → 绘制的映射（b50 为例）

RankHub 的 maimai 成绩字段（线上实测）：

```json
{"songId":"1842","type":"dx","levelIndex":3,"level":"14",
 "achievements":100.5911,"rating":317,"rank":"sssp","dxScore":3019,"fc":null,"fs":"sync"}
```

- `songId` 是**基础曲目 id**，DX 谱在定数表里是 `id + 10000`，查表前必须归一；
- `level` 是展示串（`14` / `13+`），**不是定数**；定数与满 DX 分从
  `vendor/mai/data.json`（lxns song list）按 `songId-levelIndex` 查；
- `rating` 直接可用；`dxScore` 的分母 = `notes_total * 3`，用于 DX 星计算。

实现：`src/render/mai/index.ts`（`toRow`）、`src/render/mai/data.ts`。

phigros 侧：`buckets.phi` 与 `buckets.best30` 可能重叠，best 区需要剔除 phi 曲目，
否则 b19 同一首歌会出现两次（`src/commands/rks.ts`）。

## 5. 渲染复用

- phigros：直接复用 **phi-plugin** 的 b19 HTML/CSS/art-template，Node 端用
  `playwright-core` + Chromium 截图，`file://` 加载本地字体/曲绘；
- maimai：把 **maimaiDX** 的 PIL 绘制移植到 `@napi-rs/canvas`（纯 Node，无 Python 依赖），
  逐像素与 Python 参考实现比对验收；
- 曲绘缓存：`vendor/mai/cover/<songId % 10000>.png`、`vendor/phi/...`。

## 6. 证据

- 线上探测：`evidence/qqbot/device-grant-bug-20261027.md`、
  `evidence/qqbot/device-page-bug-20261027.md`、`evidence/qqbot/bind-qr-flow-probe-20261027.md`
- 真实数据渲染：`docs/images/maimai-b50.png`、`docs/images/phigros-rks.png`
- 上游代码：`phi-plugin`（GPL-3.0）、`maimaiDX`（MIT），见 `NOTICE`。
