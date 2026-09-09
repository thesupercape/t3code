import { describe, expect, it } from "@effect/vitest";
import type { UsageDay, UsageSummary, UsageSummaryInput } from "@t3tools/contracts";

import { UsageSummaryCache, usageSummaryCacheKey } from "./usageSummaryCache.ts";

const input: UsageSummaryInput = {
  timeZone: "America/Chicago",
  sinceDay: "2026-07-01" as UsageDay,
  untilDay: "2026-08-29" as UsageDay,
  resolution: "day",
};

const summary: UsageSummary = {
  contractVersion: 6,
  readAt: "2026-08-29T15:00:00.000Z",
  timeZone: input.timeZone,
  sinceDay: input.sinceDay,
  untilDay: input.untilDay,
  buckets: [],
  sources: [],
  pricing: {
    status: "cached",
    source: "test",
    fetchedAt: null,
    knownModels: 0,
  },
  scanDurationMs: 2500,
};

describe("usageSummaryCacheKey", () => {
  it("isolates quota imports and exact cost intervals from ordinary usage summaries", () => {
    const plain = usageSummaryCacheKey(input);
    expect(usageSummaryCacheKey({ ...input, includeQuotaHistory: true })).not.toBe(plain);
    expect(usageSummaryCacheKey({ ...input, quotaHistoryOnly: true })).not.toBe(plain);
    expect(usageSummaryCacheKey({ ...input, quotaIntervals: [] })).not.toBe(plain);
    const request = {
      ...input,
      quotaIntervals: [
        { id: "a", sinceTime: "2026-07-19T00:00:00Z", untilTime: "2026-07-21T00:00:00Z" },
      ],
    };
    expect(usageSummaryCacheKey(request)).not.toBe(plain);
    expect(
      usageSummaryCacheKey({
        ...request,
        quotaIntervals: [{ ...request.quotaIntervals[0]!, untilTime: "2026-07-21T00:01:00Z" }],
      }),
    ).not.toBe(usageSummaryCacheKey(request));
  });
  it("separates different reporting windows", () => {
    expect(usageSummaryCacheKey(input)).not.toBe(
      usageSummaryCacheKey({ ...input, sinceDay: "2026-08-01" as UsageDay }),
    );
  });
});

describe("UsageSummaryCache", () => {
  it("returns a warm summary without reporting the old scan duration", () => {
    const cache = new UsageSummaryCache(60_000, 4);
    const key = usageSummaryCacheKey(input);

    cache.set(key, 1000, summary);

    expect(cache.get(key, 2000)).toEqual({ ...summary, scanDurationMs: 0 });
  });

  it("expires entries at the configured TTL", () => {
    const cache = new UsageSummaryCache(60_000, 4);
    const key = usageSummaryCacheKey(input);

    cache.set(key, 1000, summary);

    expect(cache.get(key, 61_000)).toBeUndefined();
  });

  it("evicts the oldest window when full", () => {
    const cache = new UsageSummaryCache(60_000, 2);
    const first = usageSummaryCacheKey(input);
    const second = usageSummaryCacheKey({ ...input, sinceDay: "2026-08-01" as UsageDay });
    const third = usageSummaryCacheKey({ ...input, sinceDay: "2026-08-15" as UsageDay });

    cache.set(first, 1000, summary);
    cache.set(second, 2000, summary);
    cache.set(third, 3000, summary);

    expect(cache.get(first, 3000)).toBeUndefined();
    expect(cache.get(second, 3000)).toBeDefined();
    expect(cache.get(third, 3000)).toBeDefined();
  });
});
