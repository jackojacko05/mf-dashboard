#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}
REGION=${GCP_REGION:-asia-northeast1}
JOB=moneyforward-scraper

case "${1:-}" in
  "")
    echo "[run-mf] normal mode"
    gcloud run jobs execute "${JOB}" --project="${PROJECT_ID}" --region="${REGION}" --wait
    ;;
  history|month)
    echo "[run-mf] SCRAPE_MODE=$1"
    gcloud run jobs execute "${JOB}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --wait \
      --update-env-vars="SCRAPE_MODE=$1"
    ;;
  *)
    echo "Usage: $0 [history|month]" >&2
    exit 10
    ;;
esac

gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${JOB}" \
  --project="${PROJECT_ID}" \
  --limit=50 \
  --freshness=2h \
  --format='value(textPayload)' || true
