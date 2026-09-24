# 部署方案说明

> 本文讲的是 `deploy/` 目录的设计与 `deploy.sh` 的用法。
> 想直接把系统跑起来，请先看 `docs/部署指南.md`。

本目录是本系统**唯一**的部署入口。所有操作都通过 `deploy.sh` 完成。

## 目录结构

```text
deploy/
├── compose/compose.yaml                 # 前端、后端
├── compose/prod.env                     # 正式 Compose 参数，自动生成且不提交
├── compose/test.env                     # 测试 Compose 参数，自动生成且不提交
├── docker/backend-base.Dockerfile        # Go modules 构建基础镜像
├── docker/backend.Dockerfile             # Go API 独立镜像
├── docker/frontend-base.Dockerfile       # Bun 依赖构建基础镜像
├── docker/frontend.Dockerfile            # Next standalone 独立镜像
├── docker/runtime/                       # 容器入口脚本
├── env/                                  # Compose/程序 env 模板
├── runtime/prod.env                      # 正式程序配置，自动生成且不提交
├── runtime/test.env                      # 测试程序配置，自动生成且不提交
├── runtime/releases/                     # 当前镜像标签，自动生成且不提交
└── deploy.sh                             # 构建、启动、停止、清理、查看
```

表结构由程序首次启动时自动创建（AutoMigrate），无需手工执行迁移脚本。PostgreSQL 需另行准备。

配置职责是分开的：`env/` 只存模板；`compose/*.env` 只存 Compose 项目名、网络、端口、数据目录和镜像仓库等部署参数；`runtime/*.env` 存放后端和前端程序运行所需的数据库、JWT、管理员、业务凭据等配置。后端容器通过 `compose.yaml` 的 `env_file` 读取 `runtime/*.env`，Compose 本身只使用 `compose/*.env`，`deploy.sh` 会额外加载 runtime 配置用于 Compose 插值校验。

## 环境与网络

使用 Compose 项目名和显式网络名隔离两套环境：

| 环境 | 前端宿主端口 | 前后端内部网络 | PostgreSQL |
| --- | ---: | --- | --- |
| prod | 3000 | `frameweave_prod_net` | 外部 PG，见 `DATABASE_DSN` |
| test | 3001 | `frameweave_test_net` | 外部 PG，见 `DATABASE_DSN` |

每套环境内只有两个独立容器：`frontend`、`backend`。前端通过 Docker DNS 访问 `http://backend:8080`，后端通过 `DATABASE_DSN` 访问外部 PostgreSQL；只有前端发布宿主机端口。请用你自己的 Nginx 反代正式环境的宿主机端口 `3000`，测试环境使用 `3001`。

## 镜像版本与清理策略

先使用 `deploy.sh build-base` 构建公共依赖基础镜像：基础镜像不区分 prod/test，也不包含业务程序和环境配置，固定使用 `:current` 标签；重新构建会覆盖该标签。后端构建基础镜像只包含 Go 编译环境和 Go modules 缓存，前端构建基础镜像预安装 Bun 依赖；最终后端运行镜像再使用阿里云 Alpine 源安装 `ca-certificates`、`ffmpeg`。`deploy.sh build` 会检查并使用对应的 `:current` 基础镜像，发布版本只需复制源码并执行编译/Next 构建；`go.mod`、`go.sum`、`web/package.json` 或 `web/bun.lock` 变化后，需要重新执行对应的 `build-base`。

应用发布镜像不再反复覆盖 `frameweave-backend:prod` 这类固定标签，而是生成类似下面的不可变标签：

```text
frameweave-backend:prod-v0.1.0-20260823153000-a1b2c3
frameweave-frontend:prod-v0.1.0-20260823153000-a1b2c3
```

标签由环境、仓库 `VERSION`、UTC 构建时间和随机短标识组成。构建成功后，当前应用标签写入 `runtime/releases/prod.env` 或 `runtime/releases/test.env`；这些发布状态文件被 Git 忽略，后续 `up` 会使用最近一次构建成功的应用镜像。基础镜像不写入发布状态文件，始终使用仓库名加 `:current` 固定标签。

应用镜像的 `build`、`up`、`restart` 或 `cleanup` 会分别检查对应仓库，只保留每个环境最近两版镜像，并尝试删除更旧版本；`build-base` 只重新构建并覆盖基础镜像的 `:current` 标签：

- `build` 会在构建前先释放已超过保留数的旧镜像，构建成功后再清理一次；单独构建一个服务不会改动另一个服务当前使用的标签。
- 只清理本部署生成的环境前缀标签，不执行全局 `docker image prune`，不会误删其他项目镜像。
- 如果旧镜像仍被运行中的容器使用，删除会被跳过，不强制删除仍在提供服务的镜像。
- 可用 `cleanup` 手工重复执行清理。
- 外部 PostgreSQL 不属于本 Compose 项目，镜像清理和容器启停均不会触碰它。

## 首次初始化与日常操作

建议在你的服务器上把代码放到 `/srv/frameweave/frameweave-src`，把应用数据放到 `/data/frameweave/{prod,test}/app-data`（下面的命令按这两个路径书写，你也可以换成自己的约定；数据目录同时要写进 `compose/*.env` 的 `APP_DATA_DIR`）。建议不要放在 `/root` 下，那里通常不在常规的备份与磁盘规划范围内。以下命令从 `deploy` 目录执行：

```bash
cd /srv/frameweave/frameweave-src/deploy
chmod +x deploy.sh

# 首次生成 Compose 配置和程序配置；之后手工补齐 runtime/*.env 中的 DATABASE_DSN、PUBLIC_BASE_URL、TOS、上游渠道等配置。
./deploy.sh init --env prod
./deploy.sh init --env test

# 获取代码仓库最新提交；脚本会自动识别 deploy 所在 Git 工作区根目录，只快进更新代码，不自动构建或重启服务。
# ./deploy.sh pull   —— 在 Git 工作区里执行：只快进拉取最新提交，不自动构建或重启服务。

# 先构建基础镜像；all 是一次性构建两个独立的基础镜像。
./deploy.sh build-base all

# 再分别构建后端、前端；all 是一次性构建两个独立的发布镜像。
./deploy.sh build --env prod backend
./deploy.sh build --env prod frontend
./deploy.sh build --env test all

# 分别启动/停止；all 是一次性操作多个独立容器，不会合并容器。
./deploy.sh up --env prod backend
./deploy.sh up --env prod frontend
./deploy.sh down --env prod backend
./deploy.sh down --env prod frontend

# 同一环境一键启动或停止前后端两个独立容器。
./deploy.sh up --env prod all
./deploy.sh down --env prod all

./deploy.sh ps --env prod
./deploy.sh logs --env prod backend
./deploy.sh cleanup --env prod all
./deploy.sh config --env prod
```

`down --env <env> all` 使用 `docker compose down --timeout 45 --remove-orphans`，会删除该环境的前后端容器和 Compose 网络，但不删除卷、不删除应用数据目录，也不会触碰外部 PostgreSQL。单独指定 `backend` 或 `frontend` 时，只停止并删除指定服务容器，保留同环境网络和另一个服务。docker 侧给 45 秒，比后端进程内置的 40 秒优雅停机窗口（main.go 的 shutdownGrace）多留 5 秒余量；调整任一侧时请保持 docker 侧 > 进程侧。
