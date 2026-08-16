#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi

PROJECT_ID=${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}
REGION=${GCP_REGION:-asia-northeast1}
DATASET=${BQ_DATASET:-finance}
BUCKET=${GCS_BUCKET:-${PROJECT_ID}-moneyforward-state}
SCHEDULE=${SCHEDULE:-30 6 * * *}
SCHEDULER_REGION=${SCHEDULER_REGION:-${REGION}}
JOB=moneyforward-scraper
SCHEDULER_JOB=moneyforward-scraper-daily
SA_NAME=moneyforward-scraper-sa
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
HERMES_READER_SA=${HERMES_READER_SA:-hermes-vps-sa@${PROJECT_ID}.iam.gserviceaccount.com}

echo "[setup-mf-gcp] project=${PROJECT_ID} region=${REGION} dataset=${DATASET} bucket=${BUCKET}"

gcloud services enable \
  artifactregistry.googleapis.com \
  bigquery.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --project="${PROJECT_ID}"

if ! bq --project_id="${PROJECT_ID}" show --dataset "${PROJECT_ID}:${DATASET}" >/dev/null 2>&1; then
  bq --project_id="${PROJECT_ID}" --location="${REGION}" mk --dataset "${PROJECT_ID}:${DATASET}"
fi

if ! gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi
gcloud storage buckets update "gs://${BUCKET}" --public-access-prevention >/dev/null

if ! gcloud iam service-accounts describe "${SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Money Forward scraper"
fi
for _ in {1..12}; do
  if gcloud iam service-accounts describe "${SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.jobUser" \
  --quiet
dataset_policy="$(mktemp)"
trap 'rm -f "$dataset_policy"' EXIT
bq show --format=prettyjson "${PROJECT_ID}:${DATASET}" \
  | jq --arg writer "${SA}" --arg reader "${HERMES_READER_SA}" \
    'if any(.access[]; .role == "WRITER" and .userByEmail == $writer)
     then .
     else .access += [{"role":"WRITER","userByEmail":$writer}]
     end
     | if any(.access[]; .role == "READER" and .userByEmail == $reader)
       then .
       else .access += [{"role":"READER","userByEmail":$reader}]
       end' > "${dataset_policy}"
bq update --source "${dataset_policy}" "${PROJECT_ID}:${DATASET}" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA}" \
  --role="roles/storage.objectUser" \
  --quiet

if ! gcloud secrets describe mf-op-service-account-token --project="${PROJECT_ID}" >/dev/null 2>&1 \
  && [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  gcloud secrets create mf-op-service-account-token \
    --project="${PROJECT_ID}" \
    --replication-policy=automatic
  printf '%s' "${OP_SERVICE_ACCOUNT_TOKEN}" | gcloud secrets versions add \
    mf-op-service-account-token \
    --project="${PROJECT_ID}" \
    --data-file=-
elif gcloud secrets describe mf-op-service-account-token --project="${PROJECT_ID}" >/dev/null 2>&1 \
  && [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  printf '%s' "${OP_SERVICE_ACCOUNT_TOKEN}" | gcloud secrets versions add \
    mf-op-service-account-token \
    --project="${PROJECT_ID}" \
    --data-file=-
fi
if gcloud secrets describe mf-op-service-account-token --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets add-iam-policy-binding mf-op-service-account-token \
    --project="${PROJECT_ID}" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet
fi

(
  cd "${ROOT}/apps/crawler"
  GCP_PROJECT_ID="${PROJECT_ID}" \
  GCP_REGION="${REGION}" \
  BQ_DATASET="${DATASET}" \
  GCS_BUCKET="${BUCKET}" \
  OP_VAULT="${OP_VAULT:-}" \
  OP_ITEM="${OP_ITEM:-}" \
  OP_TOTP_FIELD="${OP_TOTP_FIELD:-}" \
  bash deploy.sh
)

gcloud run jobs add-iam-policy-binding "${JOB}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${SA}" \
  --role="roles/run.invoker" \
  --quiet

URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "${SCHEDULER_JOB}" \
  --project="${PROJECT_ID}" \
  --location="${SCHEDULER_REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_JOB}" \
    --project="${PROJECT_ID}" \
    --location="${SCHEDULER_REGION}" \
    --schedule="${SCHEDULE}" \
    --time-zone="Asia/Tokyo" \
    --uri="${URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SA}" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
else
  gcloud scheduler jobs create http "${SCHEDULER_JOB}" \
    --project="${PROJECT_ID}" \
    --location="${SCHEDULER_REGION}" \
    --schedule="${SCHEDULE}" \
    --time-zone="Asia/Tokyo" \
    --uri="${URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SA}" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
fi

echo "[setup-mf-gcp] Done."
echo "[setup-mf-gcp] Bootstrap auth: cd apps/crawler && GCP_PROJECT_ID=${PROJECT_ID} pnpm bootstrap:cloud-auth"
echo "[setup-mf-gcp] Initial sync: GCP_PROJECT_ID=${PROJECT_ID} bash scripts/run-mf.sh history"
