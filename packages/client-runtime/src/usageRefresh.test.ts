import { describe, expect, it, vi } from "vite-plus/test";
import { UsageDay, type UsageSummary } from "@t3tools/contracts";
import { refreshCodexMonitor, usageQueryInput } from "./usageRefresh.ts";

const summary: UsageSummary = {
  contractVersion: 6,
  readAt: "2026-08-30T23:00:00Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-08-30"),
  untilDay: UsageDay.make("2026-08-30"),
  buckets: [],
  sources: [],
  scanDurationMs: 0,
  pricing: { status: "cached", source: "test", knownModels: 0, fetchedAt: null },
  quotaHistory: {
    status: "ready",
    source: "test",
    message: null,
    samples: [
      {
        observedAt: "2026-08-30T22:00:00Z",
        remainingPercent: 83,
        resetsAt: "2026-09-05T20:00:00Z",
      },
      {
        observedAt: "2026-08-30T23:00:00Z",
        remainingPercent: 81,
        resetsAt: "2026-09-05T20:00:00Z",
      },
    ],
  },
};
const reply = { environmentId: "desktop", error: null, summary };

describe("Codex monitor refresh", () => {
  it("does not fail successful usage reads when independent reset news fails", async () => {
    expect(
      await refreshCodexMonitor({
        trackerId: "desktop",
        refreshHistory: async () => [reply],
        refreshCosts: async () => [reply],
        refreshNews: async () => false,
      }),
    ).toContain("Refreshed.");
  });
  it("prices the new interval and completes without waiting for reset news", async () => {
    const history = Promise.withResolvers<readonly (typeof reply)[]>();
    const news = Promise.withResolvers<boolean>();
    const refreshCosts = vi.fn().mockResolvedValue([reply]);
    const refreshNews = vi.fn(() => news.promise);
    const onProgress = vi.fn();
    let finished = false;
    const run = refreshCodexMonitor({
      trackerId: "desktop",
      refreshHistory: () => history.promise,
      refreshCosts,
      refreshNews,
      onProgress,
    }).then((message) => {
      finished = true;
      return message;
    });
    expect(refreshNews).toHaveBeenCalledTimes(1);
    expect(refreshCosts).not.toHaveBeenCalled();
    history.resolve([reply]);
    await history.promise;
    expect(refreshCosts).toHaveBeenCalledWith(
      expect.objectContaining({
        quotaIntervals: [
          {
            id: "2026-08-30T22:00:00Z",
            sinceTime: "2026-08-30T22:00:00Z",
            untilTime: "2026-08-30T23:00:00Z",
          },
        ],
      }),
    );
    expect(finished).toBe(false);
    expect(await run).toContain("Refreshed.");
    expect(onProgress).toHaveBeenCalledWith("Saved readings refreshed. Updating API costs…");
    news.resolve(true);
  });
  it("reports disconnected computers without claiming success", async () => {
    const refreshCosts = vi.fn();
    expect(
      await refreshCodexMonitor({
        trackerId: "desktop",
        refreshHistory: async () => [{ ...reply, summary: null, error: "offline" }],
        refreshCosts,
        refreshNews: async () => true,
      }),
    ).toContain("could not be refreshed");
    expect(refreshCosts).not.toHaveBeenCalled();
  });
  it("uses the selected quota source instead of adding account percentages", async () => {
    const laptop = {
      ...reply,
      environmentId: "laptop",
      summary: { ...summary, quotaHistory: { ...summary.quotaHistory!, samples: [] } },
    };
    const refreshCosts = vi.fn();
    await refreshCodexMonitor({
      trackerId: "laptop",
      refreshHistory: async () => [reply, laptop],
      refreshCosts,
      refreshNews: async () => true,
    });
    expect(refreshCosts).not.toHaveBeenCalled();
  });
  it("uses the same query key for rendered and imperative cost reads", () => {
    const a = {
      timeZone: "UTC",
      sinceDay: summary.sinceDay,
      untilDay: summary.untilDay,
      quotaIntervals: [],
    };
    const b = {
      quotaIntervals: [],
      untilDay: summary.untilDay,
      sinceDay: summary.sinceDay,
      timeZone: "UTC",
    };
    expect(JSON.stringify(usageQueryInput(a, 6))).toBe(JSON.stringify(usageQueryInput(b, 6)));
  });
});
