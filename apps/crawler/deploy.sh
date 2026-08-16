#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ID=${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}
REGION=${GCP_REGION:-asia-northeast1}
DATASET=${BQ_DATASET:-finance}
BUCKET=${GCS_BUCKET:-${PROJECT_ID}-moneyforward-state}
JOB=moneyforward-scraper
SA="moneyforward-scraper-sa@${PROJECT_ID}.iam.gserviceaccount.com"

DEPLOY_ARGS=(--clear-secrets)
ENV_VARS="GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},BQ_DATASET=${DATASET},GCS_BUCKET=${BUCKET},GCS_STATE_PREFIX=moneyforward,MAX_WAIT_MINUTES=20,CLEANUP_GROUPS=true"
if gcloud secrets describe mf-op-service-account-token --project="${PROJECT_ID}" >/dev/null 2>&1; then
  for value in OP_VAULT OP_ITEM OP_TOTP_FIELD; do
    if [[ -z "${!value:-}" ]]; then
      echo "[deploy] ${value} is required when the 1Password secret is configured" >&2
      exit 10
    fi
  done
  ENV_VARS+=",OP_VAULT=${OP_VAULT},OP_ITEM=${OP_ITEM},OP_TOTP_FIELD=${OP_TOTP_FIELD}"
  DEPLOY_ARGS=(--set-secrets="OP_SERVICE_ACCOUNT_TOKEN=mf-op-service-account-token:latest")
fi

echo "[deploy] Deploying ${JOB} to ${REGION} (project=${PROJECT_ID}, dataset=${DATASET})..."
gcloud run jobs deploy "${JOB}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --source="${ROOT}" \
  --service-account="${SA}" \
  --set-env-vars="${ENV_VARS}" \
  --memory=1Gi \
  --cpu=1 \
  --max-retries=0 \
  --task-timeout=3600s \
  --parallelism=1 \
  --tasks=1 \
  "${DEPLOY_ARGS[@]}"

echo "[deploy] Done"
