#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${NOUS_ENV_FILE:-"$ROOT/.env.production"}
SUPABASE_DIR="$ROOT/deploy/supabase-project"
COMMAND=${1:-status}
shift || true

preflight() {
  OS=$(uname -s 2>/dev/null || printf unknown)
  ARCH=$(uname -m 2>/dev/null || printf unknown)
  case "$OS/$ARCH" in
    Linux/x86_64|Linux/aarch64|Darwin/x86_64|Darwin/arm64) ;;
    *) echo "Unsupported deployment host: $OS/$ARCH." >&2; exit 1 ;;
  esac
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Use the official Docker Engine/Desktop installer." >&2
    exit 1
  fi
  DOCKER_INFO=$(docker info 2>&1) || {
    case "$DOCKER_INFO" in
      *permission\ denied*|*Permission\ denied*)
        echo "Docker is installed, but this account lacks permission to use the daemon." >&2 ;;
      *)
        echo "Docker is installed, but the daemon is not running or reachable." >&2 ;;
    esac
    exit 1
  }
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is missing. Install the Docker Compose plugin; standalone Compose is unsupported." >&2
    exit 1
  fi
  COMPOSE_VERSION=$(docker compose version --short | sed 's/^v//')
  COMPOSE_MAJOR=${COMPOSE_VERSION%%.*}
  COMPOSE_REST=${COMPOSE_VERSION#*.}
  COMPOSE_MINOR=${COMPOSE_REST%%.*}
  if [ "$COMPOSE_MAJOR" -lt 2 ] || { [ "$COMPOSE_MAJOR" -eq 2 ] && [ "$COMPOSE_MINOR" -lt 24 ]; }; then
    echo "Docker Compose 2.24 or newer is required for safe self-hosted port overrides." >&2
    exit 1
  fi
  if [ ! -w "$ROOT/deploy" ]; then
    echo "$ROOT/deploy is not writable by the current account." >&2
    exit 1
  fi
}

ensure_env_file() {
  if [ -f "$ENV_FILE" ]; then
    return
  fi
  if [ "$COMMAND" != setup ]; then
    echo "Missing $ENV_FILE. Run setup to create the template." >&2
    exit 1
  fi
  cp "$ROOT/deploy/.env.production.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "Created $ENV_FILE. Fill the public URLs and external provider credentials, then rerun setup." >&2
  exit 2
}

env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

deployment_profile() {
  PROFILE=$(env_value SUPABASE_DEPLOYMENT)
  case "$PROFILE" in
    managed|self-hosted) printf '%s' "$PROFILE" ;;
    *) echo "SUPABASE_DEPLOYMENT must be managed or self-hosted." >&2; exit 1 ;;
  esac
}

compose() {
  if [ "$PROFILE" = self-hosted ]; then
    docker compose --project-name nous-reader --env-file "$ENV_FILE" \
      -f "$ROOT/compose.yml" -f "$ROOT/deploy/compose.self-hosted.yml" "$@"
  else
    docker compose --project-name nous-reader --env-file "$ENV_FILE" -f "$ROOT/compose.yml" "$@"
  fi
}

supabase_compose() {
  docker compose --project-name nous-reader-supabase --env-file "$SUPABASE_DIR/.env" \
    -f "$SUPABASE_DIR/docker-compose.yml" -f "$ROOT/deploy/supabase.override.yml" "$@"
}

config_tool() {
  ENV_DIR=$(CDPATH= cd -- "$(dirname -- "$ENV_FILE")" && pwd)
  ENV_NAME=$(basename -- "$ENV_FILE")
  docker run --rm \
    --mount "type=bind,source=$ROOT,target=/workspace" \
    --mount "type=bind,source=$ENV_DIR,target=/nous-config" \
    --workdir /workspace \
    node:22-alpine node deploy/config.mjs "$1" "/nous-config/$ENV_NAME" ${2:+"$2"}
}

ensure_self_hosted_supabase() {
  VERSION=$(tr -d '[:space:]' < "$ROOT/deploy/SUPABASE_VERSION")
  docker run --rm \
    --mount "type=bind,source=$ROOT/deploy,target=/work" \
    --env SUPABASE_VERSION="$VERSION" \
    --entrypoint sh \
    alpine/git@sha256:fac7bc2c12aa52bff1c78a26359990e149954a60cdd5d6e20e7e009666c73e0a -ec '
      destination=/work/supabase-project
      if [ -d "$destination" ]; then
        [ -f "$destination/.nous-version" ] && [ "$(cat "$destination/.nous-version")" = "$SUPABASE_VERSION" ] || {
          echo "Existing Supabase bundle does not match deploy/SUPABASE_VERSION; back up and follow the documented upgrade procedure." >&2
          exit 1
        }
        exit 0
      fi
      work=/work/.supabase-download
      rm -rf "$work"
      git init "$work"
      cd "$work"
      git remote add origin https://github.com/supabase/supabase.git
      git sparse-checkout init --cone
      git sparse-checkout set docker
      git -c protocol.version=2 fetch --depth=1 --filter=blob:none origin "$SUPABASE_VERSION"
      [ "$(git rev-parse FETCH_HEAD)" = "$SUPABASE_VERSION" ]
      git checkout --detach FETCH_HEAD
      mv docker "$destination"
      printf "%s\n" "$SUPABASE_VERSION" > "$destination/.nous-version"
      cp "$destination/.env.example" "$destination/.env"
      cd /work
      rm -rf "$work"
    '

  if [ ! -f "$SUPABASE_DIR/.nous-secrets-generated" ]; then
    docker run --rm \
      --mount "type=bind,source=$SUPABASE_DIR,target=/workspace" \
      --workdir /workspace \
      node:22-alpine sh -ec '
        apk add --no-cache openssl >/dev/null
        sh utils/generate-keys.sh --update-env >/dev/null
        sh utils/add-new-auth-keys.sh --update-env >/dev/null
        touch .nous-secrets-generated
      '
  fi

  config_tool configure /workspace/deploy/supabase-project/.env
  chmod 600 "$ENV_FILE" "$SUPABASE_DIR/.env" 2>/dev/null || true
}

run_smoke() {
  compose --profile tools run --rm smoke
  compose --profile tools run --rm -T db-tools sh -ec \
    'pg_isready --dbname="$DATABASE_URL" >/dev/null && [ "$(psql "$DATABASE_URL" -Atqc "select 1")" = "1" ]'
  echo "Healthy: database"
}

preflight
ensure_env_file
PROFILE=$(deployment_profile)

case "$COMMAND" in
  config)
    config_tool check
    compose config --quiet
    ;;
  setup)
    if [ "$PROFILE" = self-hosted ]; then
      config_tool check-bootstrap
      ensure_self_hosted_supabase
      config_tool check
      supabase_compose up -d --wait
    else
      config_tool check
    fi
    compose config --quiet
    compose up -d --build --remove-orphans --wait
    run_smoke
    compose ps
    ;;
  up)
    config_tool check
    if [ "$PROFILE" = self-hosted ]; then
      [ -f "$SUPABASE_DIR/.nous-version" ] || {
        echo "Run setup before up for a self-hosted deployment." >&2
        exit 1
      }
      supabase_compose up -d --wait
    fi
    compose up -d --remove-orphans --wait
    ;;
  status)
    config_tool check
    compose ps
    if [ "$PROFILE" = self-hosted ]; then
      supabase_compose ps
    fi
    ;;
  logs)
    compose logs -f "$@"
    ;;
  redeploy)
    config_tool check
    compose config --quiet
    compose build
    compose run --rm migrate
    compose up -d --remove-orphans --wait
    run_smoke
    compose ps
    ;;
  smoke)
    config_tool check
    run_smoke
    ;;
  contract)
    config_tool check
    [ -n "$(env_value SUPABASE_JWT_SECRET)" ] || {
      echo "The canonical Auth/RLS contract test requires SUPABASE_JWT_SECRET on a disposable self-hosted or staging environment." >&2
      exit 1
    }
    compose --profile tools run --rm contract-test
    ;;
  down)
    compose down
    ;;
  admin)
    compose --profile tools run --rm admin-bootstrap
    ;;
  backup)
    mkdir -p "$ROOT/deploy/backups"
    BACKUP_PATH="$ROOT/deploy/backups/nous-$(date -u +%Y%m%dT%H%M%SZ).dump"
    compose --profile tools run --rm -T db-tools sh -c 'pg_dump "$DATABASE_URL" --format=custom' > "$BACKUP_PATH"
    compose --profile tools run --rm -T db-tools pg_restore --list < "$BACKUP_PATH" >/dev/null
    echo "$BACKUP_PATH"
    ;;
  restore)
    BACKUP_PATH=${1:-}
    if [ ! -f "$BACKUP_PATH" ] || [ "${CONFIRM_RESTORE:-}" != "nous-reader" ]; then
      echo "Set CONFIRM_RESTORE=nous-reader and pass an existing dump path." >&2
      exit 1
    fi
    compose --profile tools run --rm -T db-tools sh -c 'pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner' < "$BACKUP_PATH"
    ;;
  *)
    echo "Usage: deploy/nous.sh config|setup|up|status|logs [service]|redeploy|smoke|contract|down|admin|backup|restore <dump>" >&2
    exit 1
    ;;
esac
