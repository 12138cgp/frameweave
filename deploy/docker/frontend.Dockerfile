# 独立前端镜像：Next standalone 运行时只负责页面和 /api/* 反向代理。
ARG FRONTEND_BASE_IMAGE=frameweave-frontend-base:current
FROM ${FRONTEND_BASE_IMAGE} AS build

ARG NEXT_PUBLIC_DOC_URL
ENV NEXT_PUBLIC_DOC_URL=${NEXT_PUBLIC_DOC_URL}

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
# 对拍样本放在仓库根的 testdata/，脚本按 ../../testdata 找它（当前 WORKDIR=/app/web）。
COPY testdata /app/testdata

# ⚠️ 构建即跑对拍，别删。理由同 backend.Dockerfile：前后端两份模型类型关键词表
# 分叉过一次并造成线上事故，而这是整条构建链上唯一会跑到它的地方。
RUN bun scripts/check-model-kind-parity.ts

RUN bun run build

FROM node:22-bookworm-slim

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=build /app/web/public /app/web/public
COPY --from=build /app/web/.next/standalone /app/web
COPY --from=build /app/web/.next/static /app/web/.next/static
COPY deploy/docker/runtime/frontend-entrypoint.sh /usr/local/bin/frontend-entrypoint
RUN chmod 0755 /usr/local/bin/frontend-entrypoint

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app/web
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/frontend-entrypoint"]
