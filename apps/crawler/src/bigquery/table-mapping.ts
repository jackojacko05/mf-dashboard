import { schema } from "@mf-dashboard/db";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";

interface BigQueryField {
  mode: "NULLABLE" | "REQUIRED";
  name: string;
  type: "BOOLEAN" | "DATE" | "FLOAT" | "INTEGER" | "STRING" | "TIMESTAMP";
}

export interface SourceTable {
  clusteringFields?: string[];
  name: string;
  partitionField?: string;
  table: SQLiteTable;
}

export interface FieldMapping extends BigQueryField {
  sourceKey: string;
}

export const SOURCE_TABLES: SourceTable[] = [
  { name: "mf_groups", table: schema.groups },
  { name: "mf_group_accounts", table: schema.groupAccounts },
  { name: "mf_institution_categories", table: schema.institutionCategories },
  { name: "mf_accounts", table: schema.accounts },
  { name: "mf_asset_categories", table: schema.assetCategories },
  { name: "mf_account_statuses", table: schema.accountStatuses },
  { name: "mf_holdings", table: schema.holdings },
  {
    clusteringFields: ["group_id"],
    name: "mf_daily_snapshots",
    partitionField: "date",
    table: schema.dailySnapshots,
  },
  { clusteringFields: ["snapshot_id"], name: "mf_holding_values", table: schema.holdingValues },
  {
    clusteringFields: ["type", "account_id"],
    name: "mf_transactions",
    partitionField: "date",
    table: schema.transactions,
  },
  { name: "mf_cash_flow_periods", table: schema.cashFlowPeriods },
  {
    clusteringFields: ["group_id"],
    name: "mf_asset_history",
    partitionField: "date",
    table: schema.assetHistory,
  },
  { name: "mf_asset_history_categories", table: schema.assetHistoryCategories },
  { name: "mf_spending_targets", table: schema.spendingTargets },
];

const DATE_COLUMNS = new Set(["date", "period_start", "period_end"]);
const TIMESTAMP_COLUMNS = new Set(["created_at", "last_scraped_at", "updated_at"]);

function resolveType(column: SQLiteColumn): BigQueryField["type"] {
  if (DATE_COLUMNS.has(column.name)) return "DATE";
  if (TIMESTAMP_COLUMNS.has(column.name)) return "TIMESTAMP";
  if (column.dataType === "boolean") return "BOOLEAN";
  if (column.dataType === "number") {
    return column.columnType.toLowerCase().includes("real") ? "FLOAT" : "INTEGER";
  }
  return "STRING";
}

export function buildFieldMappings(table: SQLiteTable): FieldMapping[] {
  const tableEntries = Object.entries(table);
  return getTableConfig(table).columns.map((column) => {
    const sourceKey = tableEntries.find(([, value]) => value === column)?.[0];
    if (!sourceKey) throw new Error(`Could not resolve source key for ${column.name}`);
    return {
      mode: column.notNull ? "REQUIRED" : "NULLABLE",
      name: column.name,
      sourceKey,
      type: resolveType(column),
    };
  });
}

export function mapRows(
  rows: Record<string, unknown>[],
  fields: FieldMapping[],
): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      fields.map(({ name, sourceKey }) => {
        const value = row[sourceKey];
        return [name, value === undefined ? null : value];
      }),
    ),
  );
}
