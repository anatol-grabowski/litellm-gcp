#!/usr/bin/env bash
# =============================================================================
# teardown.sh — idempotently remove everything deploy.sh created.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

set -a
# shellcheck disable=SC1090
source "$ROOT_DIR/.env.prod"
set +a

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
FW_RULE_NAME="${FW_RULE_NAME:-allow-litellm}"

echo "This will delete instance '${INSTANCE_NAME}' and its firewall rules"
echo "in project '${PROJECT_ID}'."
echo "The Postgres data volume lives on the instance's boot disk, so all"
echo "budgets, virtual keys, and spend history are deleted with it too."
read -r -p "Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instances delete "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --quiet
else
  echo "Instance '${INSTANCE_NAME}' not found, skipping."
fi

for RULE in "$FW_RULE_NAME" "${FW_RULE_NAME}-iap-ssh"; do
  if gcloud compute firewall-rules describe "$RULE" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud compute firewall-rules delete "$RULE" --project="$PROJECT_ID" --quiet
  else
    echo "Firewall rule '${RULE}' not found, skipping."
  fi
done

echo "Teardown complete."
