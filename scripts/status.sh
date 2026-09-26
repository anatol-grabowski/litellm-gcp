#!/usr/bin/env bash
# =============================================================================
# status.sh — get the VM status and output useful debug info
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_GCP_FILE="$ROOT_DIR/.env.gcp"
ENV_LITELLM_FILE="$ROOT_DIR/.env.litellm"

if [ ! -f "$ENV_GCP_FILE" ]; then
  echo "ERROR: missing $ENV_GCP_FILE (copy .env.gcp.example to .env.gcp first)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_GCP_FILE"
# shellcheck disable=SC1090
[ -f "$ENV_LITELLM_FILE" ] && source "$ENV_LITELLM_FILE"
set +a

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: PROJECT_ID is not set in .env.gcp and no default gcloud project is configured." >&2
  exit 1
fi

: "${ZONE:?Set ZONE in .env.gcp}"
: "${INSTANCE_NAME:?Set INSTANCE_NAME in .env.gcp}"

echo "========================================================================"
echo " LiteLLM GCP Status"
echo " Project: $PROJECT_ID | Zone: $ZONE | Instance: $INSTANCE_NAME"
echo "========================================================================"

echo "1. VM Instance Details:"
gcloud compute instances describe "$INSTANCE_NAME" \
  --zone="$ZONE" --project="$PROJECT_ID" \
  --format="table(status, machineType.basename(), networkInterfaces[0].accessConfigs[0].natIP, networkInterfaces[0].networkIP)" 2>/dev/null || echo "Instance not found or error fetching details."

echo ""
echo "2. Startup Script Status (last 30 lines):"
# Attempt to fetch serial output or fallback to instructions
gcloud compute instances get-serial-port-output "$INSTANCE_NAME" \
  --zone="$ZONE" --project="$PROJECT_ID" \
  --port=1 2>/dev/null | grep -A 1000 "=== LiteLLM startup" | tail -n 30 || echo "Could not read serial port output or startup script hasn't run."

echo ""
echo "3. Useful SSH Commands for manual debugging:"
echo " - SSH into VM:"
echo "   gcloud compute ssh \"$INSTANCE_NAME\" --zone=\"$ZONE\" --project=\"$PROJECT_ID\""
echo " - View startup logs:"
echo "   gcloud compute ssh \"$INSTANCE_NAME\" --zone=\"$ZONE\" --project=\"$PROJECT_ID\" --command='cat /var/log/litellm-startup.log'"
echo " - View LiteLLM container logs:"
echo "   gcloud compute ssh \"$INSTANCE_NAME\" --zone=\"$ZONE\" --project=\"$PROJECT_ID\" --command='docker logs litellm --tail 50 -f'"
echo " - View Postgres container logs:"
echo "   gcloud compute ssh \"$INSTANCE_NAME\" --zone=\"$ZONE\" --project=\"$PROJECT_ID\" --command='docker logs litellm-postgres --tail 50 -f'"

if [ -n "${LITELLM_PORT:-}" ]; then
  EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" \
    --zone="$ZONE" --project="$PROJECT_ID" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
  if [ -n "$EXTERNAL_IP" ]; then
    echo ""
    echo "4. Health Check Endpoint:"
    echo "   curl -v http://${EXTERNAL_IP}:${LITELLM_PORT}/health/liveliness"
    
    echo ""
    echo "5. Quick Access URLs:"
    echo "   Proxy URL: http://${EXTERNAL_IP}:${LITELLM_PORT}"
    echo "   Admin UI:  http://${EXTERNAL_IP}:${LITELLM_PORT}/ui"
  fi
fi

echo "========================================================================"
