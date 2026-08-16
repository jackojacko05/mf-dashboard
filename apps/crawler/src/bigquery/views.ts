import type { BigQuery } from "@google-cloud/bigquery";
import type { BigQuerySyncConfig } from "./config.js";

function datasetRef(config: BigQuerySyncConfig): string {
  return `\`${config.projectId}.${config.dataset}`;
}

export function buildAnalyticalViewQueries(config: BigQuerySyncConfig): string[] {
  const d = datasetRef(config);
  return [
    `CREATE OR REPLACE VIEW ${d}.silver_daily_snapshots\` AS
SELECT * EXCEPT(snapshot_rank)
FROM (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s.group_id, s.date
      ORDER BY s.refresh_completed DESC, s.updated_at DESC, s.id DESC
    ) AS snapshot_rank
  FROM ${d}.mf_daily_snapshots\` AS s
  WHERE s.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
)
WHERE snapshot_rank = 1`,
    `CREATE OR REPLACE VIEW ${d}.silver_transactions\` AS
WITH normalized AS (
  SELECT
    t.*,
    LOWER(TRIM(REGEXP_REPLACE(IFNULL(t.description, ''), r'\\s+', ' '))) AS normalized_description
  FROM ${d}.mf_transactions\` AS t
  WHERE t.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
),
ranked AS (
  SELECT
    n.*,
    COUNT(*) OVER (
      PARTITION BY
        n.date,
        n.type,
        n.amount,
        IFNULL(n.account_id, -1),
        IFNULL(n.category, ''),
        IFNULL(n.sub_category, ''),
        n.normalized_description,
        n.is_transfer,
        n.is_excluded_from_calculation,
        IFNULL(n.transfer_target, ''),
        IFNULL(n.transfer_target_account_id, -1)
    ) AS duplicate_count,
    ROW_NUMBER() OVER (
      PARTITION BY
        n.date,
        n.type,
        n.amount,
        IFNULL(n.account_id, -1),
        IFNULL(n.category, ''),
        IFNULL(n.sub_category, ''),
        n.normalized_description,
        n.is_transfer,
        n.is_excluded_from_calculation,
        IFNULL(n.transfer_target, ''),
        IFNULL(n.transfer_target_account_id, -1)
      ORDER BY n.updated_at DESC, SAFE_CAST(n.mf_id AS INT64) DESC, n.mf_id DESC
    ) AS duplicate_rank
  FROM normalized AS n
)
SELECT
  r.* EXCEPT(duplicate_rank),
  TO_HEX(SHA256(CONCAT(
    CAST(r.date AS STRING), '|', r.type, '|', CAST(r.amount AS STRING), '|',
    CAST(IFNULL(r.account_id, -1) AS STRING), '|', IFNULL(r.category, ''), '|',
    IFNULL(r.sub_category, ''), '|', r.normalized_description, '|',
    CAST(r.is_transfer AS STRING), '|', CAST(r.is_excluded_from_calculation AS STRING), '|',
    IFNULL(r.transfer_target, ''), '|',
    CAST(IFNULL(r.transfer_target_account_id, -1) AS STRING)
  ))) AS transaction_key
FROM ranked AS r
WHERE duplicate_rank = 1`,
    `CREATE OR REPLACE VIEW ${d}.silver_holdings_daily\` AS
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
JOIN ${d}.silver_daily_snapshots\` AS s ON s.id = v.snapshot_id
JOIN ${d}.mf_holdings\` AS h ON h.id = v.holding_id
JOIN ${d}.mf_accounts\` AS a ON a.id = h.account_id
JOIN ${d}.mf_groups\` AS g ON g.id = s.group_id
LEFT JOIN ${d}.mf_asset_categories\` AS c ON c.id = h.category_id`,
    `CREATE OR REPLACE VIEW ${d}.silver_asset_history\` AS
SELECT * EXCEPT(history_rank)
FROM (
  SELECT
    h.*,
    ROW_NUMBER() OVER (
      PARTITION BY h.group_id, h.date
      ORDER BY h.updated_at DESC, h.id DESC
    ) AS history_rank
  FROM ${d}.mf_asset_history\` AS h
  WHERE h.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
)
WHERE history_rank = 1`,
    `CREATE OR REPLACE VIEW ${d}.silver_asset_history_categories\` AS
SELECT * EXCEPT(category_rank)
FROM (
  SELECT
    h.date,
    h.group_id,
    c.asset_history_id,
    c.category_name,
    c.amount,
    c.created_at,
    c.updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY h.group_id, h.date, c.category_name
      ORDER BY c.updated_at DESC, c.id DESC
    ) AS category_rank
  FROM ${d}.silver_asset_history\` AS h
  JOIN ${d}.mf_asset_history_categories\` AS c ON c.asset_history_id = h.id
)
WHERE category_rank = 1`,
    `CREATE OR REPLACE VIEW ${d}.silver_asset_history_corrections\` AS
SELECT * EXCEPT(correction_rank)
FROM (
  SELECT
    c.*,
    ROW_NUMBER() OVER (
      PARTITION BY c.group_id, c.date
      ORDER BY c.updated_at DESC, c.created_at DESC
    ) AS correction_rank
  FROM ${d}.mf_asset_history_corrections\` AS c
  WHERE c.date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
)
WHERE correction_rank = 1`,
    `CREATE OR REPLACE VIEW ${d}.gold_assets_daily\` AS
WITH category_totals AS (
  SELECT
    group_id,
    date,
    SUM(amount) AS category_sum,
    COUNT(*) AS category_count,
    SUM(IF(category_name = '預金・現金', amount, 0)) AS deposits_cash,
    SUM(IF(category_name = '株式(現物)', amount, 0)) AS stocks_spot,
    SUM(IF(category_name = '投資信託', amount, 0)) AS investment_trusts,
    SUM(IF(category_name = '年金', amount, 0)) AS pension,
    SUM(IF(category_name = 'ポイント', amount, 0)) AS points
  FROM ${d}.silver_asset_history_categories\`
  GROUP BY group_id, date
),
effective AS (
  SELECT
    h.date,
    h.group_id,
    g.name AS group_name,
    COALESCE(x.total_assets, h.total_assets) AS total_assets,
    COALESCE(x.deposits_cash, c.deposits_cash) AS deposits_cash,
    COALESCE(x.stocks_spot, c.stocks_spot) AS stocks_spot,
    COALESCE(x.investment_trusts, c.investment_trusts) AS investment_trusts,
    COALESCE(x.pension, c.pension) AS pension,
    COALESCE(x.points, c.points) AS points,
    c.category_count,
    x.reason AS correction_reason,
    x.group_id IS NOT NULL AS correction_applied,
    GREATEST(h.updated_at, IFNULL(x.updated_at, h.updated_at)) AS updated_at
  FROM ${d}.silver_asset_history\` AS h
  JOIN ${d}.mf_groups\` AS g ON g.id = h.group_id
  LEFT JOIN category_totals AS c USING (group_id, date)
  LEFT JOIN ${d}.silver_asset_history_corrections\` AS x USING (group_id, date)
)
SELECT
  date,
  group_id,
  group_name,
  total_assets,
  IFNULL(
    total_assets - LAG(total_assets) OVER (PARTITION BY group_id ORDER BY date),
    0
  ) AS change,
  deposits_cash,
  stocks_spot,
  investment_trusts,
  pension,
  points,
  deposits_cash + stocks_spot + investment_trusts + pension + points AS category_sum,
  total_assets - (
    deposits_cash + stocks_spot + investment_trusts + pension + points
  ) AS reconciliation_difference,
  category_count,
  correction_applied,
  correction_reason,
  updated_at
FROM effective`,
    `CREATE OR REPLACE VIEW ${d}.gold_net_worth_daily\` AS
WITH liabilities AS (
  SELECT
    date,
    group_id,
    SUM(IF(holding_type = 'liability', amount, 0)) AS total_liabilities,
    LOGICAL_AND(refresh_completed) AS refresh_completed
  FROM ${d}.silver_holdings_daily\`
  GROUP BY date, group_id
)
SELECT
  a.date,
  a.group_id,
  a.group_name,
  a.total_assets,
  l.total_liabilities,
  IF(l.total_liabilities IS NULL, NULL, a.total_assets - l.total_liabilities) AS net_worth,
  IFNULL(l.refresh_completed, FALSE) AS refresh_completed,
  a.reconciliation_difference,
  a.updated_at
FROM ${d}.gold_assets_daily\` AS a
LEFT JOIN liabilities AS l USING (date, group_id)`,
    `CREATE OR REPLACE VIEW ${d}.gold_cash_flow_transactions\` AS
SELECT
  t.mf_id AS transaction_id,
  t.transaction_key,
  t.duplicate_count,
  t.date,
  t.type,
  t.category,
  t.sub_category,
  t.description,
  t.amount,
  a.mf_id AS account_id,
  a.name AS account_name,
  a.institution,
  t.updated_at
FROM ${d}.silver_transactions\` AS t
LEFT JOIN ${d}.mf_accounts\` AS a ON a.id = t.account_id
WHERE NOT t.is_transfer AND NOT t.is_excluded_from_calculation`,
    `CREATE OR REPLACE VIEW ${d}.transactions_effective\` AS
SELECT
  t.mf_id AS transaction_id,
  t.transaction_key,
  t.duplicate_count,
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
FROM ${d}.silver_transactions\` AS t
LEFT JOIN ${d}.mf_accounts\` AS a ON a.id = t.account_id`,
    `CREATE OR REPLACE VIEW ${d}.holdings_daily\` AS
SELECT * FROM ${d}.silver_holdings_daily\``,
    `CREATE OR REPLACE VIEW ${d}.net_worth_daily\` AS
SELECT * FROM ${d}.gold_net_worth_daily\``,
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
SELECT * FROM ${d}.gold_assets_daily\``,
    `CREATE OR REPLACE VIEW ${d}.asset_history_categories_effective\` AS
SELECT
  c.date,
  c.group_id,
  g.name AS group_name,
  c.category_name,
  c.amount AS category_amount,
  c.updated_at
FROM ${d}.silver_asset_history_categories\` AS c
JOIN ${d}.mf_groups\` AS g ON g.id = c.group_id`,
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
