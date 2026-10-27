# syntax=docker/dockerfile:1
#
# RankHub QQ 机器人生产镜像（linux/amd64）。
#
# - 构建阶段编译 TypeScript；
# - 运行阶段带 Chromium（phigros b19 渲染用）与中文字体；
# - vendor/（phi/maimai 素材）与 data/（SQLite）通过 volume 挂载，不打进镜像。

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY types ./types
COPY src ./src
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    RENDER_BROWSER_PATH=/usr/bin/chromium
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
