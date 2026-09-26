#!/bin/bash
# =============================================================================
# startup-script.sh — runs as root on every boot of the Container-Optimized OS
# instance. Idempotent: safe to re-run on reboot or after a metadata update.
#
# Runs two containers on a shared Docker network:
#   litellm-postgres  — persistent budgets/keys/spend storage
#   litellm           — the proxy itself, DB-backed (STORE_MODEL_IN_DB=True)
# =============================================================================
set -euo pipefail
exec > >(tee -a /var/log/litellm-startup.log) 2>&1
echo "=== LiteLLM startup run at $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="

NETWORK_NAME="litellm-net"
DB_CONTAINER="litellm-postgres"
APP_CONTAINER="litellm"
DB_DATA_DIR="/var/lib/litellm-postgres-data"
META_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"

fetch_meta() {
  curl -sf -H "Metadata-Flavor: Google" "${META_URL}/$1"
}

container_exists() {
  docker ps -aq -f "name=^/$1\$" | grep -q .
}

show_storage_usage() {
  echo "Docker/stateful storage usage:"
  df -h /var/lib/docker /var/lib 2>/dev/null || true
  docker system df 2>/dev/null || true
}

prune_disposable_docker_data() {
  # Do not use --volumes here. LiteLLM/Postgres durable data must never be
  # reclaimed as part of an image update. Postgres itself uses a bind mount,
  # but avoiding volume cleanup also protects any manually-added volumes.
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
}

remove_old_litellm_for_upgrade() {
  if ! container_exists "$APP_CONTAINER"; then
    return 0
  fi

  local current_image current_image_id
  current_image="$(docker inspect --format='{{.Config.Image}}' "$APP_CONTAINER")"
  if [ "$current_image" = "$IMAGE" ]; then
    return 0
  fi

  current_image_id="$(docker inspect --format='{{.Image}}' "$APP_CONTAINER" 2>/dev/null || true)"
  echo "LiteLLM image changed: ${current_image} -> ${IMAGE}"
  echo "Removing the old LiteLLM container/image before pulling the replacement"
  echo "to avoid temporarily storing two large LiteLLM images at once."
  echo "Postgres data at ${DB_DATA_DIR} is not touched."

  docker rm -f "$APP_CONTAINER"
  if [ -n "$current_image_id" ]; then
    docker image rm -f "$current_image_id" >/dev/null 2>&1 || true
  fi

  # -a removes unused tagged images too, but never an image backing a running
  # container. Volumes are deliberately not included.
  docker image prune -af >/dev/null 2>&1 || true
}

pull_litellm_image() {
  local pull_log="/tmp/litellm-image-pull.log"
  rm -f "$pull_log"

  if docker pull "$IMAGE" 2>&1 | tee "$pull_log"; then
    rm -f "$pull_log"
    return 0
  fi

  if ! grep -qi 'no space left on device' "$pull_log" 2>/dev/null; then
    echo "ERROR: failed to pull LiteLLM image ${IMAGE}." >&2
    rm -f "$pull_log"
    return 1
  fi

  echo
  echo "LiteLLM pull ran out of disk space. Reclaiming disposable Docker data"
  echo "and retrying once. Persistent Postgres files and Docker volumes are kept."

  # A mutable tag can point at a newer image while the container's configured
  # image string stays unchanged. In that case the pre-pull comparison above
  # cannot detect the upgrade, so remove the old container now to free its
  # image layers before retrying.
  if container_exists "$APP_CONTAINER"; then
    local current_image_id
    current_image_id="$(docker inspect --format='{{.Image}}' "$APP_CONTAINER" 2>/dev/null || true)"
    docker rm -f "$APP_CONTAINER"
    if [ -n "$current_image_id" ]; then
      docker image rm -f "$current_image_id" >/dev/null 2>&1 || true
    fi
  fi

  # This removes stopped containers, unused networks/images and build cache.
  # It intentionally omits --volumes, so persisted data is not deleted.
  docker system prune -af >/dev/null 2>&1 || true
  show_storage_usage

  rm -f "$pull_log"
  if docker pull "$IMAGE"; then
    return 0
  fi

  echo "ERROR: LiteLLM image still cannot be pulled after Docker cleanup." >&2
  echo "       Increase BOOT_DISK_SIZE_GB in .env.gcp if the new image itself" >&2
  echo "       no longer fits on this VM together with Postgres and swap." >&2
  return 1
}

LITELLM_CONFIG_DIR="/var/lib/litellm"
mkdir -p "$LITELLM_CONFIG_DIR" "$DB_DATA_DIR"

fetch_meta litellm-config > "$LITELLM_CONFIG_DIR/config.yaml"
fetch_meta litellm-env > "$LITELLM_CONFIG_DIR/litellm.env"
fetch_meta litellm-db-env > "$LITELLM_CONFIG_DIR/db.env"
IMAGE="$(fetch_meta litellm-image)"
POSTGRES_IMAGE="$(fetch_meta postgres-image)"
PORT="$(fetch_meta litellm-port)"

# --- 2GB swapfile: headroom for running Postgres + LiteLLM together ---------
SWAPFILE=/var/lib/litellm-swapfile
if [ ! -f "$SWAPFILE" ]; then
  fallocate -l 2G "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
fi
swapon "$SWAPFILE" 2>/dev/null || true

# --- Shared network so containers can resolve each other by name ------------
docker network inspect "$NETWORK_NAME" >/dev/null 2>&1 || docker network create "$NETWORK_NAME"

# --- Reclaim leftovers before downloading any new layers ---------------------
echo "Desired LiteLLM image: ${IMAGE}"
echo "Desired Postgres image: ${POSTGRES_IMAGE}"
show_storage_usage
prune_disposable_docker_data

# A versioned LiteLLM upgrade used to pull the new large image while the old
# one was still referenced by the running container. On a 10GB COS disk that
# can require several GB of avoidable temporary space. Remove only the old
# LiteLLM container/image first when the configured image changed.
remove_old_litellm_for_upgrade

# Postgres is much smaller and its running image stays referenced until the new
# image is available. Its persistent database is a host bind mount either way.
docker pull "$POSTGRES_IMAGE"
pull_litellm_image

# --- Postgres: recreate the container, keep the database files on disk -------
# Recreating applies env/image changes while the bind-mounted database directory
# survives normal deploys, VM resets, and container replacement.
if container_exists "$DB_CONTAINER"; then
  CURRENT_DB_IMAGE="$(docker inspect --format='{{.Config.Image}}' "$DB_CONTAINER")"
  echo "Replacing ${DB_CONTAINER}: ${CURRENT_DB_IMAGE} -> ${POSTGRES_IMAGE}"
  echo "Postgres data remains at ${DB_DATA_DIR}"
  docker rm -f "$DB_CONTAINER"
fi

docker run -d \
  --name "$DB_CONTAINER" \
  --restart=always \
  --network "$NETWORK_NAME" \
  --env-file "$LITELLM_CONFIG_DIR/db.env" \
  -v "${DB_DATA_DIR}:/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE"

# shellcheck disable=SC1091
source "$LITELLM_CONFIG_DIR/db.env"

echo "Waiting for Postgres to accept connections..."
DB_READY=0
for i in $(seq 1 30); do
  if docker exec "$DB_CONTAINER" pg_isready -U "${POSTGRES_USER}" >/dev/null 2>&1; then
    echo "Postgres is ready (after ${i} check(s))."
    DB_READY=1
    break
  fi
  sleep 2
done
if [ "$DB_READY" != "1" ]; then
  echo "ERROR: Postgres did not become ready. Check 'docker logs ${DB_CONTAINER}'." >&2
  exit 1
fi

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${DB_CONTAINER}:5432/${POSTGRES_DB}"

# --- LiteLLM: recreate from the freshly pulled configured image --------------
# Durable LiteLLM data remains in Postgres; replacing this container is safe.
if container_exists "$APP_CONTAINER"; then
  CURRENT_APP_IMAGE="$(docker inspect --format='{{.Config.Image}}' "$APP_CONTAINER")"
  echo "Replacing ${APP_CONTAINER}: ${CURRENT_APP_IMAGE} -> ${IMAGE}"
  docker rm -f "$APP_CONTAINER"
fi

docker run -d \
  --name "$APP_CONTAINER" \
  --restart=always \
  --network "$NETWORK_NAME" \
  -p "${PORT}:${PORT}" \
  --env-file "$LITELLM_CONFIG_DIR/litellm.env" \
  -e DATABASE_URL="${DATABASE_URL}" \
  -v "$LITELLM_CONFIG_DIR/config.yaml:/app/config.yaml:ro" \
  "$IMAGE" \
  --config /app/config.yaml \
  --port "${PORT}"

echo "LiteLLM container now uses: $(docker inspect --format='{{.Config.Image}}' "$APP_CONTAINER")"

# --- Reclaim all superseded image layers after a successful replacement ------
# Images backing the running LiteLLM/Postgres containers are retained. No
# volumes are pruned, and the host database directory is untouched.
docker image prune -af >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true
show_storage_usage

# --- Wait for the health endpoint --------------------------------------------
echo "Waiting for LiteLLM to become healthy on port ${PORT}..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/health/liveliness" >/dev/null 2>&1; then
    echo "LiteLLM is healthy (after ${i} check(s))."
    exit 0
  fi
  sleep 3
done

echo "WARNING: LiteLLM did not report healthy within the timeout. Check 'docker logs ${APP_CONTAINER}' and 'docker logs ${DB_CONTAINER}'."
