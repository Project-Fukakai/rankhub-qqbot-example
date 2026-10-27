# 部署（Docker Compose）

目标：一台 Linux x86_64 主机（示例为 Ubuntu 22.04）+ Docker Compose，机器人以容器常驻，
素材与数据库通过 volume 挂载，密钥通过 `.env` 注入。

## 1. 目录布局

```
/srv/rankhub-qqbot/
├── app/                  # 本仓库源码（含 Dockerfile）
├── vendor/               # 素材（phi/maimai），只读挂载
├── data/                 # SQLite（bot.db），读写挂载
├── .env                  # 密钥，chmod 600
└── docker-compose.yml
```

## 2. 准备素材

在仓库里执行 `pnpm assets:fetch` 后，把 `vendor/` 同步到主机（示例用 tar）：

```bash
tar czf vendor.tgz -C rankhub-qqbot vendor
scp vendor.tgz host:/srv/rankhub-qqbot/
ssh host 'cd /srv/rankhub-qqbot && tar xzf vendor.tgz'
```

素材只读挂载即可；后续更新素材时替换宿主机目录。

## 3. 密钥

复制 `.env.example` 为 `.env`，至少填：

```ini
QQ_APP_ID=...
QQ_APP_SECRET=...
QQ_INTENTS=33554432
RANKHUB_CLIENT_ID=...
RANKHUB_CLIENT_SECRET=...
RANKHUB_SCOPES=openid profile offline_access game:read
RANKHUB_REDIRECT_URI=http://127.0.0.1:17830/callback
TOKEN_ENC_KEY=...            # openssl rand -base64 32
DB_PATH=./data/bot.db
RENDER_BROWSER_PATH=/usr/bin/chromium
```

`chmod 600 .env`。`TOKEN_ENC_KEY` 丢失会导致已入库的 refresh token 无法解密（需用户重新绑定）。

## 4. compose

```yaml
services:
  rankhub-qqbot:
    build: ./app
    image: rankhub-qqbot:0.1.0
    container_name: rankhub-qqbot
    restart: unless-stopped
    env_file: [.env]
    volumes:
      - ./vendor:/app/vendor:ro
      - ./data:/app/data
    shm_size: 256m
    logging:
      driver: json-file
      options: { max-size: "20m", max-file: "3" }
```

```bash
cd /srv/rankhub-qqbot
docker compose build
docker compose up -d
docker compose logs -f --tail=50
```

启动成功的标志：日志出现 `QQ 网关 READY` 与 `机器人已就绪`。

## 5. 镜像说明

- 构建阶段：`node:22-bookworm-slim` + `pnpm@10.33.0`，`tsc` 编译到 `dist/`；
- 运行阶段：安装 `chromium`（phigros 截图）与 `fonts-noto-cjk`，以非 root 的 `node` 用户运行；
- `vendor/` 与 `data/` **不打进镜像**，换素材/备份数据库不影响镜像；
- 更新版本：`docker compose build && docker compose up -d`。

## 6. 运维

```bash
docker compose ps
docker compose logs --since 30m | grep -E 'warn|error'
docker compose restart
```

- 单实例约束：同一个 QQ 机器人只能有一个网关连接（多实例会互相踢下线），
  因此部署时先停掉其它环境里的同名机器人；
- 数据备份：直接备份 `data/bot.db`（SQLite，建议 `sqlite3 data/bot.db "VACUUM INTO ..."`）；
- 素材更新：替换 `vendor/` 后 `docker compose restart`。
