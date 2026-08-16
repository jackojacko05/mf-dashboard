import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BigQuery, type Dataset, type TableField } from "@google-cloud/bigquery";
import type { Db } from "@mf-dashboard/db";
import { info, log } from "../logger.js";
import type { BigQuerySyncConfig } from "./config.js";
import { buildFieldMappings, mapRows, SOURCE_TABLES, type SourceTable } from "./table-mapping.js";
import { createAnalyticalViews } from "./views.js";

export interface BigQuerySyncSummary {
  rows: Record<string, number>;
  syncedAt: string;
}

async function ensureDataset(bigQuery: BigQuery, config: BigQuerySyncConfig): Promise<Dataset> {
  const dataset = bigQuery.dataset(config.dataset);
  const [exists] = await dataset.exists();
  if (!exists) {
    await bigQuery.createDataset(config.dataset, { location: config.location });
    info(`Created BigQuery dataset ${config.dataset}`);
  }
  return dataset;
}

async function replaceTable(
  bigQuery: BigQuery,
  dataset: Dataset,
  config: BigQuerySyncConfig,
  source: SourceTable,
  rows: Record<string, unknown>[],
  tempDir: string,
): Promise<void> {
  const fieldMappings = buildFieldMappings(source.table);
  const fields: TableField[] = fieldMappings.map(({ sourceKey: _sourceKey, ...field }) => field);
  const table = dataset.table(source.name);
  const [exists] = await table.exists();

  if (rows.length === 0) {
    if (!exists) {
      await dataset.createTable(source.name, {
        clustering: source.clusteringFields ? { fields: source.clusteringFields } : undefined,
        schema: { fields },
        timePartitioning: source.partitionField
          ? { field: source.partitionField, requirePartitionFilter: true, type: "DAY" }
          : undefined,
      });
    } else {
      await bigQuery.query({
        location: config.location,
        query: `TRUNCATE TABLE \`${config.projectId}.${config.dataset}.${source.name}\``,
      });
    }
    return;
  }

  const filePath = path.join(tempDir, `${source.name}.ndjson`);
  const body = `${mapRows(rows, fieldMappings)
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
  await writeFile(filePath, body, { encoding: "utf8", mode: 0o600 });
  await table.load(filePath, {
    clustering: source.clusteringFields ? { fields: source.clusteringFields } : undefined,
    createDisposition: "CREATE_IF_NEEDED",
    location: config.location,
    schema: { fields },
    sourceFormat: "NEWLINE_DELIMITED_JSON",
    timePartitioning: source.partitionField
      ? { field: source.partitionField, requirePartitionFilter: true, type: "DAY" }
      : undefined,
    writeDisposition: "WRITE_TRUNCATE",
  });
}

export async function syncDatabaseToBigQuery(
  db: Db,
  config: BigQuerySyncConfig,
): Promise<BigQuerySyncSummary> {
  const bigQuery = new BigQuery({ projectId: config.projectId });
  const dataset = await ensureDataset(bigQuery, config);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mf-bigquery-"));
  const rowCounts: Record<string, number> = {};

  try {
    for (const source of SOURCE_TABLES) {
      const rows = (await db.select().from(source.table).all()) as Record<string, unknown>[];
      await replaceTable(bigQuery, dataset, config, source, rows, tempDir);
      rowCounts[source.name] = rows.length;
      log(`BigQuery ${source.name}: ${rows.length} rows`);
    }
    await createAnalyticalViews(bigQuery, config);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }

  const syncedAt = new Date().toISOString();
  const syncRuns = dataset.table("mf_sync_runs");
  const [syncRunsExists] = await syncRuns.exists();
  if (!syncRunsExists) {
    await dataset.createTable("mf_sync_runs", {
      clustering: { fields: ["status"] },
      schema: {
        fields: [
          { mode: "REQUIRED", name: "synced_at", type: "TIMESTAMP" },
          { mode: "REQUIRED", name: "status", type: "STRING" },
          { mode: "REQUIRED", name: "row_counts_json", type: "STRING" },
        ],
      },
      timePartitioning: { field: "synced_at", requirePartitionFilter: true, type: "DAY" },
    });
  }
  await syncRuns.insert(
    [
      {
        insertId: syncedAt,
        json: {
          row_counts_json: JSON.stringify(rowCounts),
          status: "success",
          synced_at: syncedAt,
        },
      },
    ],
    { raw: true },
  );
  info(`BigQuery sync completed at ${syncedAt}`);
  return { rows: rowCounts, syncedAt };
}
