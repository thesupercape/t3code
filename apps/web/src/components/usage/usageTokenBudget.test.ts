import { describe, expect, it } from "vite-plus/test";
import {
  TOKEN_PRICES,
  tokenBudget,
  tokenCount,
  formatTokens,
  monitoredModels,
} from "./usageTokenBudget";
import type { QuotaEnvironment } from "@t3tools/shared/usageQuota";

describe("remaining API token scenarios", () => {
  it("converts dollars to millions and billions at the selected output price", () => {
    const result = tokenBudget(1200, TOKEN_PRICES[3], {
      input: 0,
      cached: 0,
      writes: 0,
      output: 1,
    })!;
    expect(result.total).toBe(1e9);
    expect(result.output).toBe(1e9);
    expect(result.input).toBe(0);
    expect(formatTokens(result.total)).toBe("1.00B");
    expect(formatTokens(12_500_000)).toBe("12.50M");
  });
  it("prices the disjoint mix and reconciles its output back to the dollar budget", () => {
    const mix = { input: 0.15, cached: 0.7, writes: 0.05, output: 0.1 };
    const result = tokenBudget(200, TOKEN_PRICES[1], mix)!;
    expect(result.perMillion).toBeCloseTo(0.15 * 4 + 0.7 * 0.4 + 0.05 * 5 + 0.1 * 20);
    expect((result.total * result.perMillion) / 1e6).toBeCloseTo(200);
    expect(result.input + result.output).toBeCloseTo(result.total);
  });
  it("applies long-context rates to input/cache and output separately, then Fast mode", () => {
    expect(
      tokenBudget(
        100,
        TOKEN_PRICES[0],
        { input: 0.5, cached: 0, writes: 0, output: 0.5 },
        true,
        true,
      )?.perMillion,
    ).toBe(95);
  });
  it("withholds missing or invalid budgets and mixes without treating them as free tokens", () => {
    const mix = { input: 0, cached: 0, writes: 0, output: 1 };
    for (const budget of [null, NaN, Infinity, -1])
      expect(tokenBudget(budget, TOKEN_PRICES[3], mix)).toBeNull();
    expect(tokenBudget(0, TOKEN_PRICES[3], mix)?.total).toBe(0);
    expect(tokenBudget(1, TOKEN_PRICES[3], { ...mix, input: 1 })).toBeNull();
  });
  it("counts reasoning inside output once", () => {
    expect(
      tokenCount({
        uncachedInputTokens: 10,
        cachedInputTokens: 70,
        cacheCreationTokens: 5,
        outputTokens: 15,
        reasoningTokens: 12,
      }),
    ).toBe(100);
  });
  it("keeps exact interval models and deduplicates repeated physical sources", () => {
    const fingerprint = {
      hostId: "host",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "one",
    };
    const model = {
      model: "gpt-5.6-luna",
      costUsd: 2,
      unpricedRecords: 0,
      records: 1,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 70,
        cacheCreationTokens: 5,
        outputTokens: 15,
        reasoningTokens: 12,
      },
    };
    const environment = {
      environmentId: "one",
      label: "Desktop",
      error: null,
      isPending: false,
      summary: {
        sources: [{ fingerprint, status: "ok" }],
        quotaCosts: [
          {
            intervalId: "old",
            fingerprint,
            complete: true,
            unpricedRecords: 0,
            models: [{ ...model, costUsd: 999 }],
          },
          {
            intervalId: "current",
            fingerprint,
            complete: true,
            unpricedRecords: 0,
            models: [model],
          },
        ],
      },
    } as unknown as QuotaEnvironment;
    expect(
      monitoredModels("current", [environment, { ...environment, environmentId: "two" }]),
    ).toMatchObject([{ costUsd: 2 }]);
    expect(monitoredModels("missing", [environment])).toBeNull();
    expect(monitoredModels("current", [{ ...environment, error: "disconnected" }])).toBeNull();
    expect(
      monitoredModels("current", [
        environment,
        {
          ...environment,
          environmentId: "empty",
          summary: { ...environment.summary!, sources: [] },
        },
      ]),
    ).toBeNull();
  });
  it("reads models from an exact saved interval when live costs are absent", () => {
    const fingerprint = {
      hostId: "host",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "one",
    };
    const model = {
      model: "gpt-5.6-luna",
      costUsd: 2,
      unpricedRecords: 0,
      records: 1,
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    };
    const environment = {
      environmentId: "one",
      label: "Desktop",
      error: null,
      isPending: false,
      summary: {
        sources: [],
        quotaCostSnapshots: [
          {
            intervalId: "current",
            fingerprint,
            sinceTime: "2026-08-30T20:00:00Z",
            untilTime: "2026-08-30T21:00:00Z",
            costUsd: 2,
            records: 1,
            recordedAt: "2026-08-31T00:00:00Z",
            firstRemainingPercent: 80,
            lastRemainingPercent: 70,
            resetsAt: "2026-09-05T00:00:00Z",
            models: [model],
          },
        ],
      },
    } as unknown as QuotaEnvironment;
    expect(
      monitoredModels(
        { id: "current", sinceTime: "2026-08-30T20:00:00Z", untilTime: "2026-08-30T21:00:00Z" },
        [environment],
      ),
    ).toMatchObject([{ costUsd: 2 }]);
  });
  it("uses exact saved models for a failed current request", () => {
    const fingerprint = {
      hostId: "host",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "one",
    };
    const model = {
      model: "gpt-6-astra",
      costUsd: 20,
      unpricedRecords: 0,
      records: 4,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 2,
        cacheCreationTokens: 1,
        outputTokens: 7,
        reasoningTokens: 3,
      },
    };
    const environment = {
      environmentId: "one",
      label: "Desktop",
      error: "current scan failed",
      isPending: false,
      summary: {
        sources: [{ fingerprint, status: "error" }],
        quotaCostSnapshots: [
          {
            intervalId: "current",
            fingerprint,
            sinceTime: "2026-08-30T20:00:00Z",
            untilTime: "2026-08-30T21:00:00Z",
            costUsd: 20,
            records: 4,
            recordedAt: "2026-08-31T00:00:00Z",
            firstRemainingPercent: 80,
            lastRemainingPercent: 70,
            resetsAt: "2026-09-05T00:00:00Z",
            models: [model],
          },
        ],
      },
    } as unknown as QuotaEnvironment;
    expect(
      monitoredModels(
        { id: "current", sinceTime: "2026-08-30T20:00:00Z", untilTime: "2026-08-30T21:00:00Z" },
        [environment],
      ),
    ).toMatchObject([{ model: "gpt-6-astra", costUsd: 20 }]);
  });
  it("does not hide a failed source when another source has saved models", () => {
    const good = {
      hostId: "host-a",
      provider: "codex",
      resolvedHomePath: "/sessions-a",
      volumeId: "one",
    };
    const failed = {
      hostId: "host-b",
      provider: "codex",
      resolvedHomePath: "/sessions-b",
      volumeId: "two",
    };
    const environment = {
      environmentId: "one",
      label: "Desktop",
      error: null,
      isPending: false,
      summary: {
        sources: [
          { fingerprint: good, status: "ok" },
          { fingerprint: failed, status: "error" },
        ],
        quotaCostSnapshots: [
          {
            intervalId: "current",
            fingerprint: good,
            sinceTime: "2026-08-30T20:00:00Z",
            untilTime: "2026-08-30T21:00:00Z",
            costUsd: 2,
            records: 1,
            recordedAt: "2026-08-31T00:00:00Z",
            firstRemainingPercent: 80,
            lastRemainingPercent: 70,
            resetsAt: "2026-09-05T00:00:00Z",
            models: [],
          },
        ],
      },
    } as unknown as QuotaEnvironment;
    expect(
      monitoredModels(
        { id: "current", sinceTime: "2026-08-30T20:00:00Z", untilTime: "2026-08-30T21:00:00Z" },
        [environment],
      ),
    ).toBeNull();
  });
  it("rejects a saved model rollup with the wrong interval boundary", () => {
    const fingerprint = {
      hostId: "host",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "one",
    };
    const environment = {
      environmentId: "one",
      label: "Desktop",
      error: null,
      isPending: false,
      summary: {
        sources: [{ fingerprint, status: "ok" }],
        quotaCostSnapshots: [
          {
            intervalId: "current",
            fingerprint,
            sinceTime: "2026-08-30T20:00:00Z",
            untilTime: "2026-08-30T21:00:00Z",
            costUsd: 2,
            records: 1,
            recordedAt: "2026-08-31T00:00:00Z",
            firstRemainingPercent: 80,
            lastRemainingPercent: 70,
            resetsAt: "2026-09-05T00:00:00Z",
            models: [],
          },
        ],
      },
    } as unknown as QuotaEnvironment;
    expect(
      monitoredModels(
        { id: "current", sinceTime: "2026-08-30T20:00:00Z", untilTime: "2026-08-30T22:00:00Z" },
        [environment],
      ),
    ).toBeNull();
  });
});
