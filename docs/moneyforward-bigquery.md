# Money Forward → BigQuery

This deployment keeps the upstream Money Forward ME crawler and replaces the
dashboard as the consumption layer with BigQuery. It follows the existing
`asken-sync` operating model:

```text
Cloud Scheduler
  -> Cloud Run Job moneyforward-scraper
  -> Money Forward ME (Playwright)
  -> GCS authentication state + SQLite crawl checkpoint
  -> BigQuery finance dataset
  -> Hermes read-only BigQuery Toolbox
```

The SQLite database is an internal crawler checkpoint. BigQuery is the
analytical interface. No dashboard, Cloudflare Tunnel, or web service is
deployed.

## BigQuery objects

Bronze mirror tables use the `mf_` prefix. The main Silver views are:

- `transactions_effective`: transactions joined to account metadata.
- `holdings_daily`: daily holding values joined to accounts and groups.
- `net_worth_daily`: daily assets, liabilities, and net worth.
- `account_status_effective`: latest institution refresh state.
- `asset_history_effective`: Money Forward asset history by category.

Partitioned objects require a date filter. Transfers and excluded transactions
remain available in `transactions_effective`; analyses must use
`is_transfer` and `is_excluded_from_calculation` deliberately.

## Setup

Copy `.env.example` to `.env` and set these values without committing them:

```dotenv
GCP_PROJECT_ID=your-project-id
GCP_REGION=asia-northeast1
BQ_DATASET=finance
GCS_BUCKET=your-project-id-moneyforward-state
# Optional; local browser-login wait time:
# AUTH_BOOTSTRAP_TIMEOUT_MINUTES=30
# Optional for unattended re-login:
# OP_SERVICE_ACCOUNT_TOKEN=...
# OP_VAULT=...
# OP_ITEM=...
# OP_TOTP_FIELD=...
```

Then run:

```bash
GCP_PROJECT_ID="$(gcloud config get-value project)" bash scripts/setup-mf-gcp.sh
cd apps/crawler
GCP_PROJECT_ID="$(gcloud config get-value project)" pnpm bootstrap:cloud-auth
cd ../..
GCP_PROJECT_ID="$(gcloud config get-value project)" bash scripts/run-mf.sh history
```

Browser authentication state and the SQLite checkpoint are stored in the
dedicated GCS bucket. Neither is written to Git or BigQuery. A 1Password
Service Account token can optionally be stored in Secret Manager for automatic
re-login; without it, rerun the browser bootstrap when the session expires.

Account refresh waits at most five minutes per run. A still-updating institution
is kept in `account_status_effective` as stale/incomplete instead of blocking the
entire daily ingestion for the upstream crawler's twenty-minute default.

The crawler has two cash-flow modes:

- `month` (the default when the GCS checkpoint database exists) refreshes only
  the current and previous accounting periods for daily operation.
- `history` follows Money Forward's previous-month control until the displayed
  month no longer changes. It re-reads existing periods, replacing them safely,
  so a resumed run can fill older periods missing from the SQLite checkpoint.
  `HISTORY_MAX_MONTHS` defaults to 240 as a defensive loop bound; it is not a
  fixed history start month and should be raised for an account with more than
  20 years of available history.

The SQLite checkpoint is uploaded to GCS only after a successful crawler run.
If a history run fails, the previous checkpoint remains intact and can be
retried. The job uses 2 GiB of memory and a two-hour task timeout to allow the
bounded historical navigation to finish without being terminated by Cloud Run.

The setup grants `HERMES_READER_SA` read-only access to the finance dataset. It
defaults to `hermes-vps-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com`.
