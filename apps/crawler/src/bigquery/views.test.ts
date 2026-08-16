import { describe, expect, it } from "vitest";
import { buildAnalyticalViewQueries } from "./views.js";

describe("buildAnalyticalViewQueries", () => {
  it("fully qualifies every finance object", () => {
    const queries = buildAnalyticalViewQueries({
      dataset: "finance",
      location: "asia-northeast1",
      projectId: "test-project-123",
    });
    expect(queries).toHaveLength(5);
    expect(queries.join("\n")).toContain("`test-project-123.finance.transactions_effective`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.mf_transactions`");
    expect(queries.join("\n")).toContain("`test-project-123.finance.net_worth_daily`");
  });
});
