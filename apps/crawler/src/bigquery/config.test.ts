import { describe, expect, it } from "vitest";
import { loadBigQuerySyncConfig } from "./config.js";

describe("loadBigQuerySyncConfig", () => {
  it("uses the same project and region conventions as asken-sync", () => {
    expect(loadBigQuerySyncConfig({ GCP_PROJECT_ID: "test-project-123" })).toEqual({
      dataset: "finance",
      location: "asia-northeast1",
      projectId: "test-project-123",
    });
  });

  it("accepts explicit dataset and location", () => {
    expect(
      loadBigQuerySyncConfig({
        BQ_DATASET: "finance_test",
        GCP_PROJECT_ID: "test-project-123",
        GCP_REGION: "US",
      }),
    ).toEqual({ dataset: "finance_test", location: "US", projectId: "test-project-123" });
  });

  it("rejects unsafe identifiers", () => {
    expect(() =>
      loadBigQuerySyncConfig({
        BQ_DATASET: "finance`; DROP TABLE x; --",
        GCP_PROJECT_ID: "test-project-123",
      }),
    ).toThrow("BQ_DATASET is invalid");
  });
});
