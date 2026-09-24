# 后端构建基础镜像：预下载 Go modules。
# 依赖 go.mod/go.sum 不变时，后续发布只需复制源码并编译。
FROM golang:1.25-alpine

ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download
