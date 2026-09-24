# 前端构建基础镜像：预安装 Bun 依赖。
# 依赖 web/package.json/web/bun.lock 不变时，后续发布只需复制源码并构建。
FROM oven/bun:1.3.13

ENV BUN_CONFIG_REGISTRY=https://registry.npmmirror.com
WORKDIR /app/web

COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
