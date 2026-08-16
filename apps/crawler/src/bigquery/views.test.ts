import { describe, expect, it } from "vitest";
import { buildAnalyticalViewQueries } from "./views.js";

describe("buildAnalyticalViewQueries", () => {
  it("fully qualifies every finance object", () => {
    const queries = buildAnalyticalViewQueries({
      dataset: "finance",
      location: "asia-northeast1",
      projectId: "test-project-123",
    });
    expect(queries).toHaveLength(18);
    expect(queries.join("\n")).toContain("`test-project-123.finance.silver_transactions`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.gold_assets_daily`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.gold_cash_flow_daily`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.gold_cash_flow_monthly`");
    expect(queries.join("\n")).toContain(
      "`test-project-123.finance.gold_spending_monthly_by_category`",
    );
    expect(queries.join("\n")).toContain("`test-project-123.finance.transactions_effective`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.mf_transactions`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.net_worth_daily`");
  });

  it("makes Silver one row per accounting event and Gold aggregate-only", () => {
    const sql = buildAnalyticalViewQueries({
      dataset: "finance",
      location: "asia-northeast1",
      projectId: "test-project-123",
    }).join("\n");

    expect(sql).toContain("PARTITION BY s.group_id, s.date");
    expect(sql).toContain("WHERE duplicate_rank = 1");
    expect(sql).toContain("AND NOT t.is_transfer");
    expect(sql).toContain("AND NOT t.is_excluded_from_calculation");
    expect(sql).toContain("PARTITION BY\n        n.date,\n        n.type,\n        n.amount");
    expect(sql).toContain("GROUP BY date");
    expect(sql).toContain("GROUP BY month");
    expect(sql).toContain(
      "DROP VIEW IF EXISTS `test-project-123.finance.gold_cash_flow_transactions`",
    );
    expect(sql).toContain("silver_asset_history_corrections");
    expect(sql).toContain("correction_applied");
    expect(sql).toContain(") AS reconciliation_difference");
  });
});
