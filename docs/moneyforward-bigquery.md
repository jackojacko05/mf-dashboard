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

The finance dataset uses the same raw-table plus effective-view pattern as the
health ingestion, with explicit Medallion responsibilities:

- Bronze: the `mf_*` tables are a lossless SQLite mirror. Repeated snapshots
  and source transaction IDs are retained for audit and replay.
- Silver: `silver_daily_snapshots`, `silver_transactions`,
  `silver_holdings_daily`, `silver_asset_history`, and
  `silver_asset_history_categories` select canonical records. The optional
  `silver_asset_history_corrections` view selects the latest dated correction
  without changing the raw source. `silver_transactions` has one row per
  accounting event: transfer/excluded mirror rows are removed first, then
  repeated source rows are canonicalized by date, type, amount, account, and
  normalized description. `source_record_count` keeps the source multiplicity
  inspectable.
- Gold: `gold_assets_daily` is the authoritative one-row-per-day asset history,
  `gold_net_worth_daily` combines it with canonical liabilities when available,
  and `gold_cash_flow_daily`, `gold_cash_flow_monthly`, and
  `gold_spending_monthly_by_category` contain only aggregated measures. Gold
  never exposes transaction-level rows.

`gold_assets_daily` includes the five Money Forward asset categories,
`category_sum`, and `reconciliation_difference`. A healthy row has
`reconciliation_difference = 0`. Source revisions can be overlaid in
`mf_asset_history_corrections`; `correction_applied` and `correction_reason`
make every use visible to consumers. Correction values are operational data and
must not be committed to Git.

Compatibility views remain available for existing consumers:

- `transactions_effective` reads from `silver_transactions`; transfer and
  excluded mirrors are no longer part of this compatibility view.
- `holdings_daily` reads from `silver_holdings_daily`.
- `net_worth_daily` reads from `gold_net_worth_daily`.
- `asset_history_effective` reads from `gold_assets_daily`, so `total_assets`
  appears once per date rather than once per category.
- `asset_history_categories_effective` provides the normalized category rows.
- `account_status_effective` provides the latest institution refresh state.

Partitioned Bronze objects require a date filter. Use `silver_transactions`
for transaction-level analysis and a matching Gold view only when aggregation
is required. Transfer or excluded source records remain available in Bronze
for audits but are not accounting entries.

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
