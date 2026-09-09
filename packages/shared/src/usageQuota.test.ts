import { describe, expect, it } from "vite-plus/test";
import type { UsageQuotaSample, UsageSummary } from "@t3tools/contracts";
import {
  quotaCostWindow,
  quotaIntervals,
  quotaHistoryPoints,
  quotaPeriods,
  quotaValue,
  quotaValueSnapshots,
  quotaValueWithSnapshot,
  quotaValueWithHistoricalCalibration,
  retainQuotaValueSnapshots,
  type QuotaEnvironment,
} from "./usageQuota.ts";

const sample = (
  at: string,
  remaining: number,
  reset = "2026-07-25T03:00:00Z",
): UsageQuotaSample => ({
  observedAt: at,
  remainingPercent: remaining,
  resetsAt: reset,
});
const samples = [
  sample("2026-07-19T17:00:00Z", 35),
  sample("2026-07-21T17:00:00Z", 12),
  sample("2026-07-21T17:10:00Z", 100, "2026-07-28T17:02:00Z"),
  sample("2026-07-22T17:00:00Z", 82, "2026-07-28T17:02:01Z"),
];
const period = quotaPeriods(samples)[0]!;
const fingerprint = {
  hostId: "desktop",
  provider: "codex" as const,
  resolvedHomePath: "/sessions",
  volumeId: "1:2",
};
const summary: UsageSummary = {
  contractVersion: 6,
  readAt: "2026-07-22T18:00:00Z",
  timeZone: "UTC",
  sinceDay: "2026-07-17" as UsageSummary["sinceDay"],
  untilDay: "2026-07-24" as UsageSummary["untilDay"],
  buckets: [],
  sources: [
    {
      fingerprint,
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "cached", source: "fixture", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 0,
  quotaCosts: [
    {
      intervalId: period.id,
      fingerprint,
      costUsd: 230,
      records: 10,
      unpricedRecords: 0,
      complete: true,
    },
  ],
};
const env = (id = "desktop", patch: Partial<UsageSummary> = {}): QuotaEnvironment => ({
  environmentId: id,
  label: id,
  summary: { ...summary, ...patch },
  isPending: false,
  error: null,
});

describe("quota observations", () => {
  it("waits for a second observation instead of reporting a missing-server feature", () => {
    const first = quotaPeriods([samples[0]!])[0]!;
    const value = quotaValue(first, [env("desktop", { quotaCosts: undefined })]);
    expect(value.costUsd).toBeNull();
    expect(value.reason).toBe("Waiting for the next tracker reading to measure usage.");
  });
  it("plots observations by elapsed time and breaks lines at gaps and resets", () => {
    const points = quotaHistoryPoints([
      sample("2026-07-19T17:00:00Z", 35),
      sample("2026-07-19T17:10:00Z", 34),
      sample("2026-07-19T19:00:00Z", 30),
      sample("2026-07-19T19:10:00Z", 100, "2026-07-26T19:00:00Z"),
    ]);
    expect(points.map((p) => p.breakBefore)).toEqual([true, false, true, true]);
    expect(points.map((p) => p.resetChange)).toEqual([false, false, false, true]);
    expect(points[1]!.x).toBeCloseTo(10 / 130);
    expect(points.at(-1)!.x).toBe(1);
    expect(quotaHistoryPoints([])).toEqual([]);
    expect(quotaHistoryPoints([samples[0]!])[0]!.x).toBe(0.5);
  });
  it("detects an unexpected change without confusing clock jitter with resets", () => {
    const periods = quotaPeriods(samples);
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({
      resetKind: "unexpected",
      usedPercentagePoints: 23,
      observationGapMs: 600000,
    });
    expect(periods[1]).toMatchObject({ resetKind: "unobserved", usedPercentagePoints: 18 });
  });
  it("requires a subsequent observation rather than assuming a passed scheduled reset happened", () => {
    expect(quotaPeriods(samples.slice(0, 2))[0]?.resetKind).toBe("unobserved");
  });
  it("recognizes a scheduled boundary and leaves a changed clock without replenishment ambiguous", () => {
    expect(
      quotaPeriods([samples[0]!, sample("2026-07-25T03:10:00Z", 95, "2026-08-01T03:00:00Z")])[0]
        ?.resetKind,
    ).toBe("scheduled");
    expect(
      quotaPeriods([samples[0]!, sample("2026-07-21T17:10:00Z", 30, "2026-07-28T17:00:00Z")])[0]
        ?.resetKind,
    ).toBe("ambiguous");
  });
  it("uses exact observed intervals and pads the scan window", () => {
    const intervals = quotaIntervals(quotaPeriods(samples));
    expect(intervals[0]).toMatchObject({
      sinceTime: samples[0]!.observedAt,
      untilTime: samples[1]!.observedAt,
    });
    expect(quotaCostWindow(intervals)).toMatchObject({
      sinceDay: "2026-07-17",
      untilDay: "2026-07-24",
      timeZone: "UTC",
    });
  });
});

describe("quota value estimates", () => {
  it("uses the immediately completed cycle as provisional calibration after a reset", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80),
      sample("2026-07-21T17:00:00Z", 60),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-28T17:00:00Z"),
      sample("2026-07-21T17:20:00Z", 98, "2026-07-28T17:00:00Z"),
    ]);
    const previous = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "previous",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const current = {
      period: periods[1]!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "At least 5 percentage points of observed usage are needed for a conversion.",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:20:00Z",
    };
    expect(quotaValueWithHistoricalCalibration(current, previous)).toMatchObject({
      costUsd: 4,
      usdPerPercentagePoint: 2,
      remainingValueUsd: 196,
      historicalCalibration: { since: "2026-07-21T16:00:00Z", until: "2026-07-21T17:00:00Z" },
    });
  });

  it("crosses zero-use ambiguous timer-adjustment periods to the last completed calibration", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:00:00Z", 60, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-21T17:30:00Z"),
      sample("2026-07-21T17:20:00Z", 100, "2026-07-21T17:35:00Z"),
      sample("2026-07-21T17:30:00Z", 100, "2026-07-21T17:40:00Z"),
      sample("2026-07-21T17:40:00Z", 98, "2026-07-21T17:40:00Z"),
    ]);
    expect(periods.map((candidate) => candidate.resetKind)).toEqual([
      "unexpected",
      "ambiguous",
      "ambiguous",
      "unobserved",
    ]);
    const source = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "source",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const bridge = (period: (typeof periods)[number], key: string) => ({
      period,
      value: {
        costUsd: null,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key,
      calculatedAt: "2026-07-21T17:30:00Z",
    });
    const current = {
      period: periods[3]!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:30:00Z",
    };
    const bridged = quotaValueWithHistoricalCalibration(current, bridge(periods[2]!, "bridge-2"), [
      source,
      bridge(periods[1]!, "bridge-1"),
    ]);
    expect(bridged).toMatchObject({
      costUsd: 4,
      usdPerPercentagePoint: 2,
      remainingValueUsd: 196,
      historicalCalibration: {
        since: periods[0]!.first.observedAt,
        until: periods[0]!.last.observedAt,
      },
    });
  });

  it("rejects a timer bridge when usage begins across its boundary", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:00:00Z", 60, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-21T17:30:00Z"),
      sample("2026-07-21T17:20:00Z", 100, "2026-07-21T17:35:00Z"),
      sample("2026-07-21T17:30:00Z", 99, "2026-07-21T17:40:00Z"),
      sample("2026-07-21T17:40:00Z", 98, "2026-07-21T17:40:00Z"),
    ]);
    const source = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "source",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const bridge = (period: (typeof periods)[number], key: string) => ({
      period,
      value: {
        costUsd: null,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key,
      calculatedAt: "2026-07-21T17:30:00Z",
    });
    const current = {
      period: periods[3]!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:40:00Z",
    };
    expect(
      quotaValueWithHistoricalCalibration(current, bridge(periods[2]!, "bridge"), [
        source,
        bridge(periods[1]!, "bridge-1"),
      ]),
    ).toMatchObject({ costUsd: 4, usdPerPercentagePoint: null, remainingValueUsd: null });
  });

  it("does not cross a broken adjacency", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:00:00Z", 60, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-21T17:30:00Z"),
      sample("2026-07-21T17:20:00Z", 100, "2026-07-21T17:35:00Z"),
      sample("2026-07-21T17:30:00Z", 100, "2026-07-21T17:40:00Z"),
      sample("2026-07-21T17:40:00Z", 98, "2026-07-21T17:40:00Z"),
    ]);
    const source = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "source",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const bridge = (period: (typeof periods)[number], key: string) => ({
      period,
      value: {
        costUsd: null,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key,
      calculatedAt: "2026-07-21T17:20:00Z",
    });
    const current = {
      period: periods[3]!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:20:00Z",
    };
    const broken = { ...periods[1]!, next: periods[0]!.first };
    expect(
      quotaValueWithHistoricalCalibration(current, bridge(periods[2]!, "bridge"), [
        source,
        bridge(broken, "broken"),
      ]),
    ).toMatchObject({
      costUsd: 4,
      usdPerPercentagePoint: null,
    });
  });

  it("does not cross a long elapsed span when bridge balances remain unchanged", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:00:00Z", 60, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-21T17:30:00Z"),
      sample("2026-07-21T17:20:00Z", 100, "2026-07-21T17:35:00Z"),
      sample("2026-07-21T18:30:00Z", 100, "2026-07-21T18:40:00Z"),
      sample("2026-07-21T18:40:00Z", 98, "2026-07-21T18:40:00Z"),
    ]);
    expect(periods).toHaveLength(4);
    expect(periods[2]!.next?.observedAt).toBe(periods[3]!.first.observedAt);
    const source = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "source",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const bridge = (period: (typeof periods)[number], key: string) => ({
      period,
      value: {
        costUsd: null,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key,
      calculatedAt: "2026-07-21T18:40:00Z",
    });
    const current = {
      period: periods.at(-1)!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T18:40:00Z",
    };
    expect(
      quotaValueWithHistoricalCalibration(current, bridge(periods[2]!, "bridge"), [
        source,
        bridge(periods[1]!, "bridge-1"),
      ]),
    ).toMatchObject({
      costUsd: 4,
      usdPerPercentagePoint: null,
    });
  });

  it("does not cross a timer bridge that contains positive usage", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:00:00Z", 60, "2026-07-21T17:20:00Z"),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-21T17:30:00Z"),
      sample("2026-07-21T17:15:00Z", 99, "2026-07-21T17:30:00Z"),
      sample("2026-07-21T17:20:00Z", 99, "2026-07-21T17:35:00Z"),
      sample("2026-07-21T17:30:00Z", 99, "2026-07-21T17:40:00Z"),
      sample("2026-07-21T17:40:00Z", 98, "2026-07-21T17:40:00Z"),
    ]);
    const source = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "source",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const empty = (period: (typeof periods)[number], key: string) => ({
      period,
      value: {
        costUsd: null,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key,
      calculatedAt: "2026-07-21T17:40:00Z",
    });
    const current = {
      period: periods.at(-1)!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:40:00Z",
    };
    expect(
      quotaValueWithHistoricalCalibration(current, empty(periods[2]!, "bridge"), [
        source,
        empty(periods[1]!, "positive"),
      ]),
    ).toMatchObject({
      costUsd: 4,
      usdPerPercentagePoint: null,
    });
  });

  it("does not borrow calibration across ambiguous or prolonged reset gaps", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80),
      sample("2026-07-21T17:00:00Z", 60),
      sample("2026-07-21T20:00:00Z", 100, "2026-07-28T17:00:00Z"),
      sample("2026-07-21T20:10:00Z", 98, "2026-07-28T17:00:00Z"),
    ]);
    const previous = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "previous",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const current = {
      period: periods[1]!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T20:10:00Z",
    };
    expect(quotaValueWithHistoricalCalibration(current, previous).remainingValueUsd).toBeNull();
  });

  it("preserves current scan warnings and accepts a pending calibration at five points", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80),
      sample("2026-07-21T17:00:00Z", 60),
      sample("2026-07-21T17:10:00Z", 100, "2026-07-28T17:00:00Z"),
      sample("2026-07-21T17:20:00Z", 95, "2026-07-28T17:00:00Z"),
    ]);
    const previous = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "previous",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const current = {
      period: periods[1]!,
      value: {
        costUsd: null,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "desktop scan is incomplete",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:20:00Z",
    };
    expect(quotaValueWithHistoricalCalibration(current, previous)).toMatchObject({
      costUsd: null,
      remainingValueUsd: 190,
      reason: "desktop scan is incomplete",
    });
  });

  it("switches away from historical calibration when current calibration is valid", () => {
    const current = {
      period,
      value: {
        costUsd: 50,
        usdPerPercentagePoint: 3,
        remainingValueUsd: 90,
        unusedValueUsd: null,
        reason: null,
      },
      key: "current",
      calculatedAt: "2026-07-22T18:00:00Z",
    };
    expect(quotaValueWithHistoricalCalibration(current, current)).toBe(current.value);
  });

  it("uses an exact saved snapshot when the live interval cost is unavailable", () => {
    const saved = {
      intervalId: period.id,
      fingerprint,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
      costUsd: 230,
      records: 10,
      recordedAt: "2026-07-22T18:00:00Z",
      firstRemainingPercent: period.first.remainingPercent,
      lastRemainingPercent: period.last.remainingPercent,
      resetsAt: period.last.resetsAt,
    };
    const value = quotaValue(period, [
      env("desktop", { quotaCosts: [], quotaCostSnapshots: [saved] }),
    ]);
    expect(value.costUsd).toBe(230);
    expect(value.usdPerPercentagePoint).toBeCloseTo(10);
  });

  it("uses a same-cycle saved prefix while the current scan is incomplete", () => {
    const extended = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80),
      sample("2026-07-21T17:00:00Z", 60),
      sample("2026-07-21T18:00:00Z", 55),
    ])[0]!;
    const saved = {
      intervalId: extended.id,
      fingerprint,
      sinceTime: extended.first.observedAt,
      untilTime: "2026-07-21T17:00:00Z",
      costUsd: 40,
      records: 10,
      recordedAt: "2026-07-21T18:10:00Z",
      firstRemainingPercent: 80,
      lastRemainingPercent: 60,
      resetsAt: extended.first.resetsAt,
    };
    const value = quotaValue(extended, [
      env("desktop", {
        quotaCosts: undefined,
        quotaCostSnapshots: [saved],
      }),
    ]);
    expect(value).toMatchObject({
      costUsd: 40,
      usdPerPercentagePoint: 2,
      remainingValueUsd: 110,
      unusedValueUsd: null,
      costObservedUntil: "2026-07-21T17:00:00Z",
    });
    const exact = quotaValue(extended, [
      env("desktop", {
        quotaCosts: [
          {
            intervalId: extended.id,
            fingerprint,
            costUsd: 60,
            records: 12,
            unpricedRecords: 0,
            complete: true,
          },
        ],
        quotaCostSnapshots: [saved],
      }),
    ]);
    expect(exact.costUsd).toBe(60);
    const partialExact = quotaValue(extended, [
      env("desktop", {
        sources: summary.sources.map((source) => ({ ...source, status: "partial" as const })),
        quotaCosts: undefined,
        quotaCostSnapshots: [saved, { ...saved, untilTime: extended.last.observedAt, costUsd: 60 }],
      }),
    ]);
    expect(partialExact.costUsd).toBe(60);
    expect(
      quotaValue(extended, [
        env("desktop", {
          quotaCosts: undefined,
          quotaCostSnapshots: [{ ...saved, untilTime: "2026-07-21T19:00:00Z" }],
        }),
      ]).costUsd,
    ).toBeNull();
    const short = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80),
      sample("2026-07-21T17:00:00Z", 79),
      sample("2026-07-21T18:00:00Z", 78),
    ])[0]!;
    expect(
      quotaValue(short, [
        env("desktop", {
          quotaCosts: undefined,
          quotaCostSnapshots: [
            {
              ...saved,
              intervalId: short.id,
              sinceTime: short.first.observedAt,
              untilTime: "2026-07-21T17:00:00Z",
              firstRemainingPercent: 80,
              lastRemainingPercent: 79,
            },
          ],
        }),
      ]),
    ).toMatchObject({
      costUsd: 40,
      usdPerPercentagePoint: null,
      costObservedUntil: "2026-07-21T17:00:00Z",
    });
  });
  it("reads saved costs from a history-only summary without live sources", () => {
    const saved = {
      intervalId: period.id,
      fingerprint,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
      costUsd: 230,
      records: 10,
      recordedAt: "2026-07-22T18:00:00Z",
      firstRemainingPercent: period.first.remainingPercent,
      lastRemainingPercent: period.last.remainingPercent,
      resetsAt: period.last.resetsAt,
    };
    const value = quotaValue(period, [
      env("desktop", { sources: [], quotaCosts: undefined, quotaCostSnapshots: [saved] }),
    ]);
    expect(value.costUsd).toBe(230);
    expect(value.historicalCostRecordedAt).toBe("2026-07-22T18:00:00Z");
  });

  it("uses an exact saved cost when the current environment request failed", () => {
    const saved = {
      intervalId: period.id,
      fingerprint,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
      costUsd: 230,
      records: 10,
      recordedAt: "2026-07-22T18:00:00Z",
      firstRemainingPercent: period.first.remainingPercent,
      lastRemainingPercent: period.last.remainingPercent,
      resetsAt: period.last.resetsAt,
    };
    const value = quotaValue(period, [
      {
        environmentId: "laptop",
        label: "Laptop",
        summary: { ...summary, quotaCosts: undefined, quotaCostSnapshots: [saved] },
        isPending: false,
        error: "current request failed",
      },
    ]);
    expect(value.costUsd).toBe(230);
    expect(value.historicalCostRecordedAt).toBe("2026-07-22T18:00:00Z");
    expect(value.reason).toContain("Laptop could not report current usage");
  });

  it("does not use a failed environment's live cost without an exact saved row", () => {
    const value = quotaValue(period, [
      {
        environmentId: "laptop",
        label: "Laptop",
        summary,
        isPending: false,
        error: "current request failed",
      },
    ]);
    expect(value.costUsd).toBeNull();
    expect(value.reason).toContain("Laptop could not report usage");
  });

  it("uses an exact saved source row when the live scan is incomplete", () => {
    const saved = {
      intervalId: period.id,
      fingerprint,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
      costUsd: 230,
      records: 10,
      recordedAt: "2026-07-22T18:00:00Z",
      firstRemainingPercent: period.first.remainingPercent,
      lastRemainingPercent: period.last.remainingPercent,
      resetsAt: period.last.resetsAt,
    };
    const value = quotaValue(period, [
      env("desktop", {
        sources: summary.sources.map((source) => ({ ...source, status: "partial" })),
        quotaCosts: [],
        quotaCostSnapshots: [saved],
      }),
    ]);
    expect(value.costUsd).toBe(230);
  });

  it("prefers the exact saved row over a complete live row from a partial source", () => {
    const saved = {
      intervalId: period.id,
      fingerprint,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
      costUsd: 230,
      records: 10,
      recordedAt: "2026-07-22T18:00:00Z",
      firstRemainingPercent: period.first.remainingPercent,
      lastRemainingPercent: period.last.remainingPercent,
      resetsAt: period.last.resetsAt,
    };
    const value = quotaValue(period, [
      env("desktop", {
        sources: summary.sources.map((source) => ({ ...source, status: "partial" })),
        quotaCosts: summary.quotaCosts!.map((row) => ({ ...row, costUsd: 460 })),
        quotaCostSnapshots: [saved],
      }),
    ]);
    expect(value.costUsd).toBe(230);
    expect(value.reason).toContain("transcript scan is incomplete");
  });

  it("rejects a failed environment when one known source lacks an exact saved row", () => {
    const otherFingerprint = { ...fingerprint, hostId: "laptop" };
    const value = quotaValue(period, [
      {
        ...env("desktop", {
          sources: [...summary.sources, { ...summary.sources[0]!, fingerprint: otherFingerprint }],
          quotaCosts: undefined,
          quotaCostSnapshots: [
            {
              intervalId: period.id,
              fingerprint,
              sinceTime: period.first.observedAt,
              untilTime: period.last.observedAt,
              costUsd: 230,
              records: 10,
              recordedAt: "2026-07-22T18:00:00Z",
              firstRemainingPercent: period.first.remainingPercent,
              lastRemainingPercent: period.last.remainingPercent,
              resetsAt: period.last.resetsAt,
            },
          ],
        }),
        error: "offline",
      },
    ]);
    expect(value.costUsd).toBeNull();
    expect(value.reason).toContain("could not report usage");
  });

  it("rejects saved rows with a mismatched observed interval", () => {
    const saved = {
      intervalId: period.id,
      fingerprint,
      sinceTime: period.first.observedAt,
      untilTime: "2026-07-22T18:00:00Z",
      costUsd: 230,
      records: 10,
      recordedAt: "2026-07-22T18:00:00Z",
      firstRemainingPercent: period.first.remainingPercent,
      lastRemainingPercent: period.last.remainingPercent,
      resetsAt: period.last.resetsAt,
    };
    expect(
      quotaValue(period, [env("desktop", { quotaCosts: undefined, quotaCostSnapshots: [saved] })])
        .costUsd,
    ).toBeNull();
  });

  it("rejects an ambiguous clock-only boundary", () => {
    const periods = quotaPeriods([
      sample("2026-07-21T16:00:00Z", 80),
      sample("2026-07-21T17:00:00Z", 60),
      sample("2026-07-21T17:10:00Z", 60, "2026-07-28T17:02:00Z"),
      sample("2026-07-21T17:20:00Z", 59, "2026-07-28T17:02:00Z"),
    ]);
    const previous = {
      period: periods[0]!,
      value: {
        costUsd: 40,
        usdPerPercentagePoint: 2,
        remainingValueUsd: 80,
        unusedValueUsd: 40,
        reason: null,
      },
      key: "previous",
      calculatedAt: "2026-07-21T17:00:00Z",
    };
    const current = {
      period: periods[1]!,
      value: {
        costUsd: 4,
        usdPerPercentagePoint: null,
        remainingValueUsd: null,
        unusedValueUsd: null,
        reason: "waiting",
      },
      key: "current",
      calculatedAt: "2026-07-21T17:20:00Z",
    };
    expect(quotaValueWithHistoricalCalibration(current, previous).remainingValueUsd).toBeNull();
  });
  it("retains complete calculations through partial refreshes without caching partial totals", () => {
    const complete = quotaValueSnapshots("tracker", [period], [env()]);
    const cache = retainQuotaValueSnapshots(new Map(), complete);
    const partial = quotaValueSnapshots(
      "tracker",
      [period],
      [
        env("desktop", {
          sources: summary.sources.map((source) => ({ ...source, status: "partial" })),
        }),
      ],
    );
    expect(partial[0]!.value.costUsd).toBeNull();
    expect(quotaValueWithSnapshot(partial[0]!, cache)).toMatchObject({
      costUsd: 230,
      remainingValueUsd: 120,
      cachedAt: complete[0]!.calculatedAt,
    });
    expect(retainQuotaValueSnapshots(cache, partial)).toBe(cache);
    expect(quotaValueWithSnapshot(partial[0]!, new Map()).costUsd).toBeNull();
    const updated = quotaValueSnapshots(
      "tracker",
      [period],
      [
        env("desktop", {
          quotaCosts: summary.quotaCosts!.map((row) => ({ ...row, costUsd: 460 })),
        }),
      ],
    );
    expect(quotaValueWithSnapshot(updated[0]!, cache).remainingValueUsd).toBe(240);
    expect(quotaValueWithSnapshot(updated[0]!, cache).cachedAt).toBeUndefined();
  });
  it("never reuses a cached calculation for a different tracker, selection, source, or period", () => {
    const cache = retainQuotaValueSnapshots(
      new Map(),
      quotaValueSnapshots("tracker", [period], [env()]),
    );
    const offline = { ...env(), error: "offline" };
    const changedSource = {
      ...offline,
      summary: {
        ...summary,
        sources: summary.sources.map((source) => ({
          ...source,
          fingerprint: { ...fingerprint, volumeId: "other" },
        })),
      },
    };
    for (const current of [
      quotaValueSnapshots("other-tracker", [period], [offline]),
      quotaValueSnapshots("tracker", [period], [{ ...offline, environmentId: "other-computer" }]),
      quotaValueSnapshots("tracker", [{ ...period, usedPercentagePoints: 24 }], [offline]),
      quotaValueSnapshots("tracker", [period], [changedSource]),
    ])
      expect(quotaValueWithSnapshot(current[0]!, cache).remainingValueUsd).toBeNull();
  });
  it("keeps a complete same-window result visible while refreshing", () => {
    expect(quotaValue(period, [{ ...env(), isPending: true }])).toMatchObject({
      costUsd: 230,
      remainingValueUsd: 120,
    });
  });
  it("estimates value at the last reading without claiming an unobserved reset", () => {
    const value = quotaValue({ ...period, resetKind: "unobserved", next: null }, [env()]);
    expect(value.remainingValueUsd).toBe(120);
    expect(value.unusedValueUsd).toBeNull();
    expect(value.reason).toContain("Usage after that reading is not included");
  });
  it("retains the last-reading estimate when reset evidence is distant or ambiguous", () => {
    for (const p of [
      { ...period, observationGapMs: 3_600_001 },
      { ...period, resetKind: "ambiguous" as const },
    ]) {
      const value = quotaValue(p, [env()]);
      expect(value.remainingValueUsd).toBe(120);
      expect(value.unusedValueUsd).toBeNull();
    }
  });
  it("calibrates only the observed percentage drop, not 100 minus the ending balance", () => {
    expect(quotaValue(period, [env()])).toMatchObject({
      costUsd: 230,
      usdPerPercentagePoint: 10,
      unusedValueUsd: 120,
    });
  });
  it("does not count the same physical source twice", () => {
    expect(quotaValue(period, [env(), env("alias")]).costUsd).toBe(230);
  });
  it("adds a distinct laptop's costs, without adding its account percentage", () => {
    const laptopFingerprint = { ...fingerprint, hostId: "laptop", volumeId: "3:4" };
    const laptop = env("laptop", {
      sources: summary.sources.map((source) => ({ ...source, fingerprint: laptopFingerprint })),
      quotaCosts: summary.quotaCosts!.map((row) => ({ ...row, fingerprint: laptopFingerprint })),
    });
    expect(quotaValue(period, [env(), laptop])).toMatchObject({
      costUsd: 460,
      usdPerPercentagePoint: 20,
      unusedValueUsd: 240,
    });
  });
  it("calculates an assumption-labeled estimate without a confirmation gate", () => {
    expect(quotaValue(period, [env()])).toMatchObject({
      costUsd: 230,
      remainingValueUsd: 120,
      unusedValueUsd: 120,
    });
  });
  it("withholds estimates when a selected computer is unavailable, partial, or unpriced", () => {
    expect(quotaValue(period, [{ ...env(), error: "offline" }]).costUsd).toBeNull();
    expect(quotaValue(period, [{ ...env(), error: "offline" }]).reason).toContain(
      "could not report usage",
    );
    expect(quotaValue(period, [{ ...env(), summary: null, isPending: true }]).reason).toContain(
      "still reading Codex transcripts",
    );
    expect(
      quotaValue(period, [
        env("desktop", {
          sources: summary.sources.map((source) => ({ ...source, status: "partial" })),
        }),
      ]).costUsd,
    ).toBeNull();
    expect(
      quotaValue(period, [
        env("desktop", {
          quotaCosts: summary.quotaCosts!.map((row) => ({ ...row, unpricedRecords: 1 })),
        }),
      ]).costUsd,
    ).toBeNull();
  });
  it("does not turn missing transcripts into zero dollars", () => {
    expect(
      quotaValue(period, [
        env("desktop", {
          quotaCosts: summary.quotaCosts!.map((row) => ({ ...row, costUsd: 0, records: 0 })),
        }),
      ]).costUsd,
    ).toBeNull();
  });
  it("withholds costs if a transcript read failed despite an otherwise healthy source", () => {
    expect(
      quotaValue(period, [
        env("desktop", {
          quotaCosts: summary.quotaCosts!.map((row) => ({ ...row, complete: false })),
        }),
      ]).costUsd,
    ).toBeNull();
  });
  it("withholds unused value for distant reset observations, tiny percentage changes, or no reset evidence", () => {
    expect(
      quotaValue({ ...period, observationGapMs: 3_600_001 }, [env()]).unusedValueUsd,
    ).toBeNull();
    expect(
      quotaValue({ ...period, usedPercentagePoints: 1 }, [env()]).usdPerPercentagePoint,
    ).toBeNull();
    expect(
      quotaValue({ ...period, resetKind: "unobserved", next: null }, [env()]).unusedValueUsd,
    ).toBeNull();
  });
});
