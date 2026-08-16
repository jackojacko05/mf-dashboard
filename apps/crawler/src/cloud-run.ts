import { closeDb, initDb } from "@mf-dashboard/db";
import { loadBigQuerySyncConfig } from "./bigquery/config.js";
import { syncDatabaseToBigQuery } from "./bigquery/sync.js";
import { downloadStateFile, uploadStateFile } from "./cloud-run/state-gcs.js";
import { runWithCrawlerRunLock } from "./crawler-run-lock.js";
import { error, info } from "./logger.js";
import { runCrawler } from "./run.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const bucket = requireEnv("GCS_BUCKET");
  const statePrefix = process.env.GCS_STATE_PREFIX?.trim() || "moneyforward";
  const dbPath = process.env.DB_PATH?.trim() || "/tmp/moneyforward.db";
  const authStatePath = process.env.AUTH_STATE_PATH?.trim() || "/tmp/auth-state.json";
  process.env.DB_PATH = dbPath;
  process.env.AUTH_STATE_PATH = authStatePath;
  process.env.CRAWLER_STATE_PATH ||= "/tmp/crawler-state.json";

  const dbObject = `${statePrefix}/moneyforward.db`;
  const authObject = `${statePrefix}/auth-state.json`;
  const [dbRestored, authRestored] = await Promise.all([
    downloadStateFile(bucket, dbObject, dbPath),
    downloadStateFile(bucket, authObject, authStatePath),
  ]);
  info(`Cloud state restored: database=${dbRestored}, auth=${authRestored}`);

  let crawlSucceeded = false;
  try {
    await runWithCrawlerRunLock("cloud-run", runCrawler, {
      lockPath: "/tmp/crawler-run.lock",
      statePath: process.env.CRAWLER_STATE_PATH,
    });
    crawlSucceeded = true;
  } finally {
    if (await uploadStateFile(bucket, authObject, authStatePath)) {
      info("Uploaded browser authentication state to GCS");
    }
    if (crawlSucceeded && (await uploadStateFile(bucket, dbObject, dbPath))) {
      info("Uploaded crawler database checkpoint to GCS");
    }
  }

  const db = await initDb();
  try {
    await syncDatabaseToBigQuery(db, loadBigQuerySyncConfig());
  } finally {
    closeDb();
  }
}

main().catch((failure) => {
  error("Cloud Run sync failed:", failure);
  process.exitCode = 1;
});
