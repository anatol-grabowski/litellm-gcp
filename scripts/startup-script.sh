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

# --- Pull images --------------------------------------------------------------
echo "Desired LiteLLM image: ${IMAGE}"
echo "Desired Postgres image: ${POSTGRES_IMAGE}"
docker pull "$POSTGRES_IMAGE"
docker pull "$IMAGE"

# --- Postgres: recreate the container, keep the database files on disk -------
# Recreating applies env/image changes while the bind-mounted database directory
# survives normal deploys, VM resets, and container replacement.
if docker ps -aq -f "name=^/${DB_CONTAINER}\$" | grep -q .; then
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
for i in $(seq 1 30); do
  if docker exec "$DB_CONTAINER" pg_isready -U "${POSTGRES_USER}" >/dev/null 2>&1; then
    echo "Postgres is ready (after ${i} check(s))."
    break
  fi
  sleep 2
done

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${DB_CONTAINER}:5432/${POSTGRES_DB}"

# --- LiteLLM: always recreate from the freshly pulled configured image -------
# This makes a LITELLM_IMAGE version change in .env.gcp take effect on the VM
# on the very next deploy, while all durable LiteLLM data remains in Postgres.
if docker ps -aq -f "name=^/${APP_CONTAINER}\$" | grep -q .; then
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

# --- Reclaim disk space from superseded image layers -------------------------
docker image prune -f >/dev/null 2>&1 || true

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
