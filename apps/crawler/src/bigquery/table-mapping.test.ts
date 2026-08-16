import { schema } from "@mf-dashboard/db";
import { describe, expect, it } from "vitest";
import { buildFieldMappings, mapRows } from "./table-mapping.js";

describe("BigQuery table mapping", () => {
  it("maps transaction dates and booleans to analytical BigQuery types", () => {
    const fields = buildFieldMappings(schema.transactions);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "date", type: "DATE" }),
        expect.objectContaining({ name: "amount", type: "INTEGER" }),
        expect.objectContaining({ name: "is_transfer", type: "BOOLEAN" }),
        expect.objectContaining({ name: "created_at", type: "TIMESTAMP" }),
      ]),
    );
  });

  it("renames Drizzle camelCase properties to SQLite/BigQuery snake_case", () => {
    const fields = buildFieldMappings(schema.groups);
    expect(
      mapRows(
        [
          {
            createdAt: "2026-08-16T00:00:00.000Z",
            id: "group-a",
            isCurrent: true,
            lastScrapedAt: undefined,
            name: "Group A",
            updatedAt: "2026-08-16T00:00:00.000Z",
          },
        ],
        fields,
      ),
    ).toEqual([
      expect.objectContaining({
        created_at: "2026-08-16T00:00:00.000Z",
        is_current: true,
        last_scraped_at: null,
      }),
    ]);
  });
});
