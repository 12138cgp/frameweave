# 独立后端镜像：只运行 Go API，不再把 Next.js 放在同一个容器。
ARG BACKEND_BASE_IMAGE=frameweave-backend-base:current
FROM ${BACKEND_BASE_IMAGE} AS build

COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY *.go ./
# testdata 是前后端「模型类型判据」对拍样本的所在地，下面的 go test 要读 ../testdata/。
COPY testdata ./testdata

# ⚠️ 构建即跑这组测试，别删。它比对的是【关键词表本身】与 fixture 契约：
# 后端和前端各有一份模型类型关键词表，两边分叉过一次并造成线上事故。
# 这是整条构建链上唯一会跑到它的地方——CI 只在打 tag 时触发且只做 docker build。
RUN go test ./service/ -run TestModelKind

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server .

FROM alpine:3.22

RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates ffmpeg
WORKDIR /app
COPY VERSION /app/VERSION
COPY --from=build /out/server /app/server
COPY deploy/docker/runtime/backend-entrypoint.sh /usr/local/bin/backend-entrypoint
RUN chmod 0755 /usr/local/bin/backend-entrypoint && mkdir -p /app/data

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/backend-entrypoint"]
