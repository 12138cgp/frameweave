#!/usr/bin/env bash
set -Eeuo pipefail

# 部署入口。
# 设计目标：显式指定环境和服务，避免误用其它位置的 compose 文件。

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR"
REPO_DIR="$(cd -- "$DEPLOY_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/compose/compose.yaml"
RELEASE_DIR="$DEPLOY_DIR/runtime/releases"

ENV_NAME="prod"
ACTION=""
# logs 默认一次性输出就退出。follow 要显式加 -f——
# 部署检查清单里的命令必须会自己终止，否则照抄的人会以为卡死了。
FOLLOW=0
SERVICE="all"

usage() {
  cat <<'EOF'
用法：
  deploy.sh init    --env prod|test
  deploy.sh pull
  deploy.sh build-base [backend|frontend|all]
  deploy.sh build   --env prod|test [backend|frontend|all]
  deploy.sh up      --env prod|test [backend|frontend|all]
  deploy.sh down    --env prod|test [backend|frontend|all]
  deploy.sh restart --env prod|test [backend|frontend|all]
  deploy.sh logs    --env prod|test [backend|frontend|all] [-f]
  deploy.sh ps      --env prod|test
  deploy.sh config  --env prod|test
  deploy.sh cleanup --env prod|test [backend|frontend|all]

也支持：--service backend|frontend|all。
logs 默认打印最近 200 行后退出；加 -f（或 --follow）才持续跟随，按 Ctrl-C 退出。
PostgreSQL 由外部服务器提供，本脚本只管理前后端容器和宿主机应用数据。
build/up/cleanup 会按环境清理旧镜像，每个应用保留最近两版。
  build 之前必须先成功执行 build-base；基础镜像不区分 prod/test，使用固定 current 标签。
down --env <env> all 会删除容器和网络，但不会删除卷、应用数据或外部 PostgreSQL。
EOF
}

die() {
  echo "[错误] $*" >&2
  exit 1
}

pull_code() {
  command -v git >/dev/null 2>&1 || die "未检测到 Git"
  local git_root
  git_root="$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$git_root" ]] || die "代码目录不在 Git 工作区内：$REPO_DIR"
  git_root="$(cd -- "$git_root" && pwd -P)"

  if [[ -n "$(git -C "$git_root" status --porcelain --untracked-files=no)" ]]; then
    die "Git 工作区存在未提交的已跟踪文件变更，请先提交或处理后再 pull：$git_root"
  fi

  echo "拉取最新代码：$git_root"
  git -C "$git_root" pull --ff-only
}

random_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

replace_env_value() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i.bak -E "s|^${key}=.*$|${key}=${value}|" "$file"
    rm -f "$file.bak"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

init_env() {
  local compose_file="$DEPLOY_DIR/compose/${ENV_NAME}.env"
  local runtime_file="$DEPLOY_DIR/runtime/${ENV_NAME}.env"
  local compose_example="$DEPLOY_DIR/env/${ENV_NAME}.compose.env.example"
  local runtime_example="$DEPLOY_DIR/env/${ENV_NAME}.runtime.env.example"
  [[ -f "$compose_example" ]] || die "缺少 Compose 环境模板：$compose_example"
  [[ -f "$runtime_example" ]] || die "缺少程序环境模板：$runtime_example"
  [[ ! -e "$compose_file" ]] || die "文件已存在，不覆盖：$compose_file"
  [[ ! -e "$runtime_file" ]] || die "文件已存在，不覆盖：$runtime_file"

  # 首次 init 时这两个目录还不存在（发布包里不含实际配置），cp 之前先建出来。
  mkdir -p "$(dirname "$compose_file")" "$(dirname "$runtime_file")"

  cp "$compose_example" "$compose_file"
  cp "$runtime_example" "$runtime_file"
  local jwt_secret
  jwt_secret="$(random_hex 32)"
  replace_env_value "$runtime_file" JWT_SECRET "$jwt_secret"

  echo "已生成：$compose_file"
  echo "已生成：$runtime_file"
  echo "请继续填写 runtime/${ENV_NAME}.env 中的外部 PostgreSQL DATABASE_DSN、PUBLIC_BASE_URL 和业务凭据，再执行 build/up。"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --env)
        (($# >= 2)) || die "--env 缺少值"
        ENV_NAME="$2"
        shift 2
        ;;
      --service)
        (($# >= 2)) || die "--service 缺少值"
        SERVICE="$2"
        shift 2
        ;;
      -f|--follow)
        FOLLOW=1
        shift
        ;;
      pull|init|build-base|build|up|down|restart|logs|ps|config|cleanup)
        [[ -z "$ACTION" ]] || die "只能指定一个操作：$ACTION 和 $1"
        ACTION="$1"
        shift
        ;;
      backend|frontend|all)
        [[ "$SERVICE" == "all" ]] || die "服务重复指定"
        SERVICE="$1"
        shift
        ;;
      *)
        die "无法识别参数：$1（使用 --help 查看用法）"
        ;;
    esac
  done
}

parse_args "$@"
[[ "$ENV_NAME" == "prod" || "$ENV_NAME" == "test" ]] || die "环境只能是 prod 或 test"
[[ -n "$ACTION" ]] || { usage; exit 2; }
[[ "$SERVICE" == "backend" || "$SERVICE" == "frontend" || "$SERVICE" == "all" ]] || die "服务只能是 backend、frontend 或 all"

if [[ "$ACTION" == "init" ]]; then
  [[ "$SERVICE" == "all" ]] || die "init 不接受服务参数"
  init_env
  exit 0
fi

if [[ "$ACTION" == "pull" ]]; then
  [[ "$SERVICE" == "all" ]] || die "pull 不接受服务参数"
  pull_code
  exit 0
fi

BACKEND_REPO="${BACKEND_IMAGE_REPO:-frameweave-backend}"
FRONTEND_REPO="${FRONTEND_IMAGE_REPO:-frameweave-frontend}"
BACKEND_BASE_REPO="frameweave-backend-base"
FRONTEND_BASE_REPO="frameweave-frontend-base"

# 基础镜像只依赖 Dockerfile、依赖锁文件和基础镜像仓库配置，不读取 prod/test 配置。
set -a
if [[ "$ACTION" != "build-base" ]]; then
  COMPOSE_ENV_FILE="$DEPLOY_DIR/compose/${ENV_NAME}.env"
  RUNTIME_ENV_FILE="$DEPLOY_DIR/runtime/${ENV_NAME}.env"
  [[ -f "$COMPOSE_ENV_FILE" ]] || die "缺少 Compose 环境文件：$COMPOSE_ENV_FILE；先执行 deploy.sh init --env $ENV_NAME，再填写配置"
  [[ -f "$RUNTIME_ENV_FILE" ]] || die "缺少程序环境文件：$RUNTIME_ENV_FILE；先执行 deploy.sh init --env $ENV_NAME，再填写配置"
  [[ -f "$COMPOSE_FILE" ]] || die "缺少 Compose 文件：$COMPOSE_FILE"

  # Compose 环境文件只包含部署参数；程序配置单独加载，仅用于 Compose 插值和脚本读取。
  # shellcheck disable=SC1090
  . "$COMPOSE_ENV_FILE"
  # shellcheck disable=SC1090
  . "$RUNTIME_ENV_FILE"
  if [[ -f "$RELEASE_DIR/${ENV_NAME}.env" ]]; then
    # 发布状态文件只包含镜像标签，不包含业务密钥。
    # shellcheck disable=SC1090
    . "$RELEASE_DIR/${ENV_NAME}.env"
  fi
fi
set +a
export DEPLOY_ENV="$ENV_NAME"

# Compose 环境文件可能覆盖应用发布仓库名；基础镜像仓库名是公共固定值，不随环境变化。
BACKEND_REPO="${BACKEND_IMAGE_REPO:-$BACKEND_REPO}"
FRONTEND_REPO="${FRONTEND_IMAGE_REPO:-$FRONTEND_REPO}"
BACKEND_BASE_IMAGE="${BACKEND_BASE_REPO}:current"
FRONTEND_BASE_IMAGE="${FRONTEND_BASE_REPO}:current"
export BACKEND_BASE_IMAGE FRONTEND_BASE_IMAGE

COMPOSE=()
if [[ "$ACTION" != "build-base" ]]; then
  PROJECT_NAME="${COMPOSE_PROJECT_NAME:-frameweave-${ENV_NAME}}"
  NETWORK_NAME="${NETWORK_NAME:-${PROJECT_NAME}_net}"
  APP_DATA_DIR="${APP_DATA_DIR:-}"
  [[ -n "$APP_DATA_DIR" ]] || die "APP_DATA_DIR 未配置"
  COMPOSE=(docker compose --project-name "$PROJECT_NAME" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
fi

if ! command -v docker >/dev/null 2>&1; then
  die "未检测到 Docker"
fi
docker info >/dev/null 2>&1 || die "Docker 未运行或当前账号无权访问 Docker"

if [[ "$ACTION" == "up" || "$ACTION" == "restart" ]]; then
  mkdir -p "$APP_DATA_DIR"
fi

compose() {
  "${COMPOSE[@]}" "$@"
}

service_args() {
  case "$SERVICE" in
    backend) printf '%s\n' backend ;;
    frontend) printf '%s\n' frontend ;;
    all) printf '%s\n' backend frontend ;;
  esac
}

validate_config() {
  compose config --quiet
}

new_release_tag() {
  local version safe_version timestamp suffix
  version="$(tr -d '\r\n' < "$REPO_DIR/VERSION")"
  [[ -n "$version" ]] || version="dev"
  safe_version="${version//[^A-Za-z0-9_.-]/-}"
  timestamp="$(date -u +%Y%m%d%H%M%S)"
  suffix="$(random_hex 3)"
  printf '%s-%s-%s-%s' "$ENV_NAME" "$safe_version" "$timestamp" "$suffix"
}

set_release_images() {
  local release_tag="$1"
  export DEPLOY_RELEASE="$release_tag"
  case "$SERVICE" in
    backend)
      export BACKEND_IMAGE="${BACKEND_REPO}:${release_tag}"
      ;;
    frontend)
      export FRONTEND_IMAGE="${FRONTEND_REPO}:${release_tag}"
      ;;
    all)
      export BACKEND_IMAGE="${BACKEND_REPO}:${release_tag}"
      export FRONTEND_IMAGE="${FRONTEND_REPO}:${release_tag}"
      ;;
  esac
}

persist_release_state() {
  mkdir -p "$RELEASE_DIR"
  local state_file="$RELEASE_DIR/${ENV_NAME}.env"
  {
    printf 'DEPLOY_RELEASE=%s\n' "${DEPLOY_RELEASE:-}"
    [[ -n "${BACKEND_IMAGE:-}" ]] && printf 'BACKEND_IMAGE=%s\n' "$BACKEND_IMAGE"
    [[ -n "${FRONTEND_IMAGE:-}" ]] && printf 'FRONTEND_IMAGE=%s\n' "$FRONTEND_IMAGE"
  } > "$state_file"
  chmod 0600 "$state_file" 2>/dev/null || true
}

cleanup_repo_images() {
  local repo="$1" tag_prefix="$2"
  local refs=()
  local candidates=()
  local ref created

  mapfile -t candidates < <(docker image ls "$repo" --format '{{.Repository}}:{{.Tag}}')
  for ref in "${candidates[@]}"; do
    [[ "$ref" == "$repo:${tag_prefix}"* ]] || continue
    created="$(docker image inspect "$ref" --format '{{.Created}}' 2>/dev/null || true)"
    [[ -n "$created" ]] || continue
    refs+=("$created\t$ref")
  done

  if ((${#refs[@]} > 2)); then
    mapfile -t refs < <(printf '%b\n' "${refs[@]}" | sort -r -k1,1)
    local stale_count=$((${#refs[@]} - 2))
    echo "清理 $repo[$tag_prefix]：保留最近 2 版，尝试删除 $stale_count 版旧镜像。"
    local i old_ref
    for ((i = 2; i < ${#refs[@]}; i++)); do
      old_ref="${refs[$i]#*$'\t'}"
      if docker image rm "$old_ref" >/dev/null 2>&1; then
        echo "  已删除：$old_ref"
      else
        # 旧镜像仍被运行中的容器使用时不强制删除，避免影响正在提供服务的容器。
        echo "  跳过（仍被容器使用或 Docker 拒绝删除）：$old_ref"
      fi
    done
  fi

  # 清理本方案早期固定标签，避免它们绕过“最近两版”筛选长期残留。
  local legacy_ref
  for legacy_ref in "$repo:${ENV_NAME}" "$repo:${ENV_NAME}-initial"; do
    if docker image inspect "$legacy_ref" >/dev/null 2>&1; then
      if docker image rm "$legacy_ref" >/dev/null 2>&1; then
        echo "  已删除旧固定标签：$legacy_ref"
      else
        echo "  跳过旧固定标签（仍被容器使用或 Docker 拒绝删除）：$legacy_ref"
      fi
    fi
  done
}

cleanup_images() {
  case "$SERVICE" in
    backend)
      cleanup_repo_images "$BACKEND_REPO" "${ENV_NAME}-"
      ;;
    frontend)
      cleanup_repo_images "$FRONTEND_REPO" "${ENV_NAME}-"
      ;;
    all)
      cleanup_repo_images "$BACKEND_REPO" "${ENV_NAME}-"
      cleanup_repo_images "$FRONTEND_REPO" "${ENV_NAME}-"
      ;;
  esac
}

require_base_image() {
  local service="$1" image
  case "$service" in
    backend) image="$BACKEND_BASE_IMAGE" ;;
    frontend) image="$FRONTEND_BASE_IMAGE" ;;
    *) die "基础镜像服务只能是 backend 或 frontend" ;;
  esac
  docker image inspect "$image" >/dev/null 2>&1 || die "未找到基础镜像 $image；先执行 deploy.sh build-base $service"
}

require_base_images() {
  case "$SERVICE" in
    backend) require_base_image backend ;;
    frontend) require_base_image frontend ;;
    all)
      require_base_image backend
      require_base_image frontend
      ;;
  esac
}

build_base_image() {
  local service="$1" image dockerfile
  case "$service" in
    backend)
      image="$BACKEND_BASE_IMAGE"
      dockerfile="$DEPLOY_DIR/docker/backend-base.Dockerfile"
      ;;
    frontend)
      image="$FRONTEND_BASE_IMAGE"
      dockerfile="$DEPLOY_DIR/docker/frontend-base.Dockerfile"
      ;;
    *) die "基础镜像服务只能是 backend 或 frontend" ;;
  esac
  echo "构建基础镜像：$image"
  docker build --file "$dockerfile" --tag "$image" "$REPO_DIR"
}

run_action() {
  local services=()
  mapfile -t services < <(service_args)

  case "$ACTION" in
    build-base)
      if [[ "$SERVICE" == "all" ]]; then
        build_base_image backend
        build_base_image frontend
      else
        build_base_image "$SERVICE"
      fi
      ;;
    build)
      require_base_images
      local release_tag
      # 先释放本部署已经超过保留数量的旧版本，避免旧镜像挤占本次构建空间。
      cleanup_images
      release_tag="$(new_release_tag)"
      set_release_images "$release_tag"
      if [[ "$SERVICE" == "all" ]]; then
        compose build backend frontend
      else
        compose build "${services[@]}"
      fi
      persist_release_state
      cleanup_images
      ;;
    up)
      compose up -d "${services[@]}"
      cleanup_images
      ;;
    down)
      if [[ "$SERVICE" == "all" ]]; then
        # 与 docker compose down 一致：删除本 Compose 项目的容器和网络，不删除卷。
        compose down --timeout 45 --remove-orphans
      else
        # 只销毁指定服务，保留同环境网络和另一个服务。
        compose stop --timeout 45 "${services[@]}"
        compose rm --force "${services[@]}"
      fi
      ;;
    restart)
      compose stop --timeout 45 "${services[@]}"
      compose up -d "${services[@]}"
      cleanup_images
      ;;
    logs)
      # 默认不 follow：这条命令出现在部署验证步骤里，必须会终止。
      # 原先无条件带 -f，管道给 tail 时既不返回、又因为缓冲一行都看不到。
      logs_args=(logs --tail=200)
      [[ "$FOLLOW" == "1" ]] && logs_args+=(-f)
      if [[ "$SERVICE" != "all" ]]; then
        logs_args+=("${services[@]}")
      fi
      compose "${logs_args[@]}"
      ;;
    ps)
      compose ps
      ;;
    config)
      compose config
      ;;
    cleanup)
      cleanup_images
      ;;
    *)
      die "不支持的操作：$ACTION"
      ;;
  esac
}

if [[ "$ACTION" != "build-base" ]]; then
  validate_config
fi
run_action
