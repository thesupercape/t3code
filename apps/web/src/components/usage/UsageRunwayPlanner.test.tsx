/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { quotaForecast } from "@t3tools/shared/usageQuotaForecast";
import { apiCostPace, type ApiPaceInput } from "./usageApiPace";
import { UsageRunwayPlanner } from "./UsageRunwayPlanner";

const now = Date.parse("2026-09-05T12:00:00.000Z");
const samples = [
  {
    observedAt: "2026-09-05T00:00:00.000Z",
    remainingPercent: 70,
    resetsAt: "2026-09-05T15:00:00.000Z",
  },
  {
    observedAt: new Date(now).toISOString(),
    remainingPercent: 50,
    resetsAt: "2026-09-05T15:00:00.000Z",
  },
];
const input: ApiPaceInput = {
  interval: {
    id: "pace",
    sinceTime: "2026-09-05T06:00:00.000Z",
    untilTime: "2026-09-05T12:00:00.000Z",
  },
  remainingValueUsd: 50,
  models: [
    {
      model: "gpt-5.6-luna",
      costUsd: 60,
      unpricedRecords: 0,
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50e6,
        reasoningTokens: 0,
      },
    },
  ],
};

describe("usage runway planner", () => {
  it("explains the quiet window, target burn and verified banked credits", () => {
    const pace = apiCostPace(quotaForecast(samples, now)!, input, now)!;
    const markup = renderToStaticMarkup(
      <UsageRunwayPlanner
        pace={pace}
        scheduledResetAt="2026-09-06T12:00:00.000Z"
        manualResets={{
          availableCount: 3,
          verified: true,
          checkedAt: new Date(now).toISOString(),
          expiries: ["2026-09-21T08:10:23.000Z"],
        }}
        now={now}
      />,
    );
    expect(markup).toContain("19h 0m");
    expect(markup).toContain("7.0h beyond your maximum gap");
    expect(markup).toContain("Maximum time without usage");
    expect(markup).toContain("$4.17 / hour");
    expect(markup).toContain("3 available");
    expect(markup).toContain("Verified from the account snapshot");
    expect(markup).toContain("refreshes both the short and weekly windows");
  });

  it("states when priced history is not available", () => {
    const markup = renderToStaticMarkup(
      <UsageRunwayPlanner pace={null} scheduledResetAt="2026-09-06T12:00:00.000Z" now={now} />,
    );
    expect(markup).toContain("Waiting for a fresh, fully priced API-cost reading");
  });
  it("labels an old verified snapshot and missing expiry as conditional", () => {
    const pace = apiCostPace(quotaForecast(samples, now)!, input, now)!;
    const markup = renderToStaticMarkup(
      <UsageRunwayPlanner
        pace={pace}
        scheduledResetAt="2026-09-06T12:00:00.000Z"
        manualResets={{
          availableCount: 3,
          verified: true,
          checkedAt: new Date(now - 16 * 60_000).toISOString(),
        }}
        now={now}
      />,
    );
    expect(markup).toContain("refresh before relying on the count");
    expect(markup).toContain("Expiry dates are unavailable");
    expect(markup).toContain("expiry is unavailable");
  });
});
