#!/usr/bin/env bash
# =============================================================================
# deploy.sh — idempotently create/update a LiteLLM proxy on GCE.
#
# Safe to re-run: existing resources (APIs, firewall rules, instance) are
# detected and left alone or reconciled in place rather than recreated.
#
# Requires: gcloud CLI, authenticated (`gcloud auth login`), openssl.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_PROD_FILE="$ROOT_DIR/.env.prod"
ENV_LITELLM_FILE="$ROOT_DIR/.env.litellm"
ENV_DB_FILE="$ROOT_DIR/.env.db"

for f in "$ENV_PROD_FILE" "$ENV_LITELLM_FILE" "$ENV_DB_FILE"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
done

set -a
# shellcheck disable=SC1090
source "$ENV_PROD_FILE"
# shellcheck disable=SC1090
source "$ENV_LITELLM_FILE"
# shellcheck disable=SC1090
source "$ENV_DB_FILE"
set +a

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: PROJECT_ID is not set in .env.prod and no default gcloud project is configured." >&2
  exit 1
fi

: "${REGION:?Set REGION in .env.prod}"
: "${ZONE:?Set ZONE in .env.prod}"
: "${INSTANCE_NAME:?Set INSTANCE_NAME in .env.prod}"
: "${MACHINE_TYPE:?Set MACHINE_TYPE in .env.prod}"
: "${LITELLM_IMAGE:?Set LITELLM_IMAGE in .env.prod}"
: "${LITELLM_PORT:?Set LITELLM_PORT in .env.prod}"
: "${POSTGRES_IMAGE:?Set POSTGRES_IMAGE in .env.prod}"
: "${POSTGRES_USER:?Set POSTGRES_USER in .env.db}"
: "${POSTGRES_DB:?Set POSTGRES_DB in .env.db}"

NETWORK="${NETWORK:-default}"
NETWORK_TAG="${NETWORK_TAG:-litellm-server}"
FW_RULE_NAME="${FW_RULE_NAME:-allow-litellm}"
ALLOWED_SOURCE_RANGE="${ALLOWED_SOURCE_RANGE:-0.0.0.0/0}"
IMAGE_FAMILY="${IMAGE_FAMILY:-cos-stable}"
IMAGE_PROJECT="${IMAGE_PROJECT:-cos-cloud}"
BOOT_DISK_SIZE_GB="${BOOT_DISK_SIZE_GB:-10}"
BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-pd-standard}"

echo "==> Project: $PROJECT_ID | Zone: $ZONE | Instance: $INSTANCE_NAME"

# -----------------------------------------------------------------------------
# 0. Generate secrets on first run and persist them (idempotent: only
#    happens once each, subsequent runs reuse the saved values).
# -----------------------------------------------------------------------------
generate_secret_if_placeholder() {
  # $1 = variable name, $2 = file to persist it in, $3 = generated value
  local var_name="$1" file="$2" value="$3"
  local current="${!var_name:-}"
  if [ -z "$current" ] || [ "$current" = "CHANGE_ME" ]; then
    if grep -q "^${var_name}=" "$file"; then
      sed -i.bak "s|^${var_name}=.*|${var_name}=${value}|" "$file"
      rm -f "${file}.bak"
    else
      printf '\n%s=%s\n' "$var_name" "$value" >> "$file"
    fi
    printf -v "$var_name" '%s' "$value"
    echo "==> Generated a new ${var_name} and saved it to $(basename "$file")"
  fi
}

generate_secret_if_placeholder LITELLM_MASTER_KEY "$ENV_LITELLM_FILE" "sk-$(openssl rand -hex 24)"
generate_secret_if_placeholder LITELLM_SALT_KEY "$ENV_LITELLM_FILE" "sk-$(openssl rand -hex 24)"
generate_secret_if_placeholder POSTGRES_PASSWORD "$ENV_DB_FILE" "$(openssl rand -hex 20)"

# -----------------------------------------------------------------------------
# 1. Enable required APIs (idempotent — no-op if already enabled).
# -----------------------------------------------------------------------------
echo "==> Ensuring compute.googleapis.com is enabled"
gcloud services enable compute.googleapis.com --project="$PROJECT_ID"

# -----------------------------------------------------------------------------
# 2. Firewall rules (idempotent — created only if missing).
# -----------------------------------------------------------------------------
echo "==> Ensuring firewall rule '${FW_RULE_NAME}' (tcp:${LITELLM_PORT} from ${ALLOWED_SOURCE_RANGE})"
if ! gcloud compute firewall-rules describe "$FW_RULE_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$FW_RULE_NAME" \
    --project="$PROJECT_ID" \
    --network="$NETWORK" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules="tcp:${LITELLM_PORT}" \
    --source-ranges="$ALLOWED_SOURCE_RANGE" \
    --target-tags="$NETWORK_TAG" \
    --description="Allow inbound traffic to the LiteLLM proxy"
else
  echo "    already exists, skipping"
fi

echo "==> Ensuring firewall rule '${FW_RULE_NAME}-iap-ssh' (tcp:22 via Identity-Aware Proxy)"
if ! gcloud compute firewall-rules describe "${FW_RULE_NAME}-iap-ssh" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${FW_RULE_NAME}-iap-ssh" \
    --project="$PROJECT_ID" \
    --network="$NETWORK" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges=35.235.240.0/20 \
    --target-tags="$NETWORK_TAG" \
    --description="Allow SSH via Identity-Aware Proxy tunnel only"
else
  echo "    already exists, skipping"
fi

# -----------------------------------------------------------------------------
# 3. Stage metadata payloads (startup script, config, env, image/port).
# -----------------------------------------------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
cp "$SCRIPT_DIR/startup-script.sh" "$TMP_DIR/startup-script.sh"
cp "$ROOT_DIR/config/config.yaml" "$TMP_DIR/config.yaml"
cp "$ENV_LITELLM_FILE" "$TMP_DIR/litellm.env"
cp "$ENV_DB_FILE" "$TMP_DIR/db.env"

METADATA_FROM_FILE="startup-script=${TMP_DIR}/startup-script.sh,litellm-config=${TMP_DIR}/config.yaml,litellm-env=${TMP_DIR}/litellm.env,litellm-db-env=${TMP_DIR}/db.env"
METADATA="litellm-image=${LITELLM_IMAGE},litellm-port=${LITELLM_PORT},postgres-image=${POSTGRES_IMAGE}"

# -----------------------------------------------------------------------------
# 4. Create or reconcile the instance.
# -----------------------------------------------------------------------------
if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> Instance '${INSTANCE_NAME}' already exists — updating its configuration"
  gcloud compute instances add-metadata "$INSTANCE_NAME" \
    --zone="$ZONE" --project="$PROJECT_ID" \
    --metadata-from-file="$METADATA_FROM_FILE" \
    --metadata="$METADATA"
  echo "==> Resetting instance so the updated startup script re-applies"
  gcloud compute instances reset "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID"
else
  echo "==> Creating instance '${INSTANCE_NAME}'"
  gcloud compute instances create "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="${BOOT_DISK_SIZE_GB}GB" \
    --boot-disk-type="$BOOT_DISK_TYPE" \
    --network="$NETWORK" \
    --subnet="${SUBNET:-default}" \
    --tags="$NETWORK_TAG" \
    --metadata-from-file="$METADATA_FROM_FILE" \
    --metadata="$METADATA"
fi

# -----------------------------------------------------------------------------
# 5. Wait for the proxy to answer, then report.
# -----------------------------------------------------------------------------
echo "==> Fetching external IP"
EXTERNAL_IP=""
for i in $(seq 1 20); do
  EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" \
    --zone="$ZONE" --project="$PROJECT_ID" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
  [ -n "$EXTERNAL_IP" ] && break
  sleep 3
done

if [ -z "$EXTERNAL_IP" ]; then
  echo "ERROR: could not determine external IP." >&2
  exit 1
fi

echo "==> Waiting for LiteLLM to respond at http://${EXTERNAL_IP}:${LITELLM_PORT}/health/liveliness"
echo "    (first boot pulls the image and can take a couple of minutes)"
READY=0
for i in $(seq 1 60); do
  if curl -sf -m 5 "http://${EXTERNAL_IP}:${LITELLM_PORT}/health/liveliness" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 5
done

echo
echo "================================================================"
if [ "$READY" = "1" ]; then
  echo " LiteLLM is up and reachable."
else
  echo " LiteLLM did not respond within the timeout — it may still be"
  echo " starting. Check with:"
  echo "   gcloud compute instances get-serial-port-output ${INSTANCE_NAME} --zone=${ZONE}"
fi
echo " Proxy URL:   http://${EXTERNAL_IP}:${LITELLM_PORT}"
echo " Admin UI:    http://${EXTERNAL_IP}:${LITELLM_PORT}/ui  (user: admin, password: master key below)"
echo " Master key:  ${LITELLM_MASTER_KEY}"
echo " Salt key:    ${LITELLM_SALT_KEY}   (back this up — cannot be rotated once keys exist)"
echo " Test call:"
echo "   curl http://${EXTERNAL_IP}:${LITELLM_PORT}/v1/models \\"
echo "     -H \"Authorization: Bearer ${LITELLM_MASTER_KEY}\""
echo "================================================================"
