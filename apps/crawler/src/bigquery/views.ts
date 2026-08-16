import type { BigQuery } from "@google-cloud/bigquery";
import type { BigQuerySyncConfig } from "./config.js";

function datasetRef(config: BigQuerySyncConfig): string {
  return `\`${config.projectId}.${config.dataset}`;
}

export function buildAnalyticalViewQueries(config: BigQuerySyncConfig): string[] {
  const d = datasetRef(config);
  return [
    `CREATE OR REPLACE VIEW ${d}.transactions_effective\` AS
SELECT
  t.mf_id AS transaction_id,
  t.date,
  t.type,
  t.category,
  t.sub_category,
  t.description,
  t.amount,
  t.is_transfer,
  t.is_excluded_from_calculation,
  t.transfer_target,
  a.mf_id AS account_id,
  a.name AS account_name,
  a.institution,
  t.updated_at
FROM ${d}.mf_transactions\` AS t
LEFT JOIN ${d}.mf_accounts\` AS a ON a.id = t.account_id
WHERE t.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'`,
    `CREATE OR REPLACE VIEW ${d}.holdings_daily\` AS
SELECT
  s.date,
  g.id AS group_id,
  g.name AS group_name,
  h.mf_id AS holding_id,
  h.name AS holding_name,
  h.code,
  h.type AS holding_type,
  c.name AS asset_category,
  h.liability_category,
  a.mf_id AS account_id,
  a.name AS account_name,
  a.institution,
  v.amount,
  v.quantity,
  v.unit_price,
  v.avg_cost_price,
  v.daily_change,
  v.unrealized_gain,
  v.unrealized_gain_pct,
  s.refresh_completed,
  v.updated_at
FROM ${d}.mf_holding_values\` AS v
JOIN ${d}.mf_daily_snapshots\` AS s ON s.id = v.snapshot_id
JOIN ${d}.mf_holdings\` AS h ON h.id = v.holding_id
JOIN ${d}.mf_accounts\` AS a ON a.id = h.account_id
JOIN ${d}.mf_groups\` AS g ON g.id = s.group_id
LEFT JOIN ${d}.mf_asset_categories\` AS c ON c.id = h.category_id
WHERE s.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'`,
    `CREATE OR REPLACE VIEW ${d}.net_worth_daily\` AS
SELECT
  date,
  group_id,
  ANY_VALUE(group_name) AS group_name,
  SUM(IF(holding_type = 'liability', -amount, amount)) AS net_worth,
  SUM(IF(holding_type = 'asset', amount, 0)) AS total_assets,
  SUM(IF(holding_type = 'liability', amount, 0)) AS total_liabilities,
  LOGICAL_AND(refresh_completed) AS refresh_completed
FROM ${d}.holdings_daily\`
GROUP BY date, group_id`,
    `CREATE OR REPLACE VIEW ${d}.account_status_effective\` AS
SELECT
  a.mf_id AS account_id,
  a.name AS account_name,
  a.type AS account_type,
  a.institution,
  c.name AS institution_category,
  s.status,
  s.last_updated,
  s.total_assets,
  s.scheduled_withdrawal_amount,
  s.scheduled_withdrawal_confirmed,
  s.error_message,
  s.updated_at
FROM ${d}.mf_accounts\` AS a
LEFT JOIN ${d}.mf_institution_categories\` AS c ON c.id = a.category_id
LEFT JOIN ${d}.mf_account_statuses\` AS s ON s.account_id = a.id
WHERE a.is_active`,
    `CREATE OR REPLACE VIEW ${d}.asset_history_effective\` AS
SELECT
  h.date,
  h.group_id,
  g.name AS group_name,
  h.total_assets,
  h.change,
  c.category_name,
  c.amount AS category_amount,
  h.updated_at
FROM ${d}.mf_asset_history\` AS h
JOIN ${d}.mf_groups\` AS g ON g.id = h.group_id
LEFT JOIN ${d}.mf_asset_history_categories\` AS c ON c.asset_history_id = h.id
WHERE h.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'`,
  ];
}

export async function createAnalyticalViews(
  bigQuery: BigQuery,
  config: BigQuerySyncConfig,
): Promise<void> {
  for (const query of buildAnalyticalViewQueries(config)) {
    await bigQuery.query({ location: config.location, query });
  }
}
