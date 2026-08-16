export interface BigQuerySyncConfig {
  dataset: string;
  location: string;
  projectId: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const PROJECT_ID = /^[a-z][a-z0-9.:_-]{4,62}[a-z0-9]$/;

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadBigQuerySyncConfig(env: NodeJS.ProcessEnv = process.env): BigQuerySyncConfig {
  const projectId = requireValue(env, "GCP_PROJECT_ID");
  const dataset = env.BQ_DATASET?.trim() || "finance";
  const location = env.GCP_REGION?.trim() || "asia-northeast1";

  if (!PROJECT_ID.test(projectId)) throw new Error("GCP_PROJECT_ID is invalid");
  if (!IDENTIFIER.test(dataset)) throw new Error("BQ_DATASET is invalid");
  if (!/^[A-Za-z0-9-]+$/.test(location)) throw new Error("GCP_REGION is invalid");

  return { dataset, location, projectId };
}
