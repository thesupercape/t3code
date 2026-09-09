import { describe, expect, it } from "@effect/vitest";
import {
  decodeQuotaHistory,
  encodeQuotaHistory,
  QuotaCostAccumulator,
  readQuotaHistory,
  validQuotaIntervals,
} from "./usageQuotaHistory.ts";
import { createOverrideRateTable } from "./usagePricing.ts";
import { EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

const sample = {
  ObservedAt: "2026-07-21T12:00:00-05:00",
  RemainingPercent: 12,
  ResetsAt: "2026-07-24T22:24:49-05:00",
};
const document = (Samples: unknown[]) => ({
  Snapshot: { MainLimit: { LimitId: "codex", Window: { DurationMinutes: 10080 } } },
  Samples,
});
const intervals = [
  { id: "one", sinceTime: "2026-07-21T16:00:00Z", untilTime: "2026-07-21T17:00:00Z" },
];

describe("saved quota history", () => {
  it("imports only sanitized observations and deduplicates timestamps", () => {
    const result = decodeQuotaHistory({
      ...document([sample, sample]),
      Snapshot: {
        MainLimit: { LimitId: "codex", Window: { DurationMinutes: 10080 } },
        EmergencyResetCount: 3,
        FetchedAt: "2026-07-21T12:00:00-05:00",
      },
      OtherPrivateData: "not returned",
    });
    expect(result.samples).toEqual([
      {
        observedAt: "2026-07-21T17:00:00.000Z",
        remainingPercent: 12,
        resetsAt: "2026-07-25T03:24:49.000Z",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("not returned");
    expect(result.bankedResetCount).toBe(3);
    expect(result.bankedResetCheckedAt).toBe("2026-07-21T17:00:00.000Z");
  });
  it("rejects malformed, conflicting, non-weekly, and other-account-limit records", () => {
    expect(decodeQuotaHistory(document([{ ...sample, RemainingPercent: 101 }])).status).toBe(
      "invalid",
    );
    expect(decodeQuotaHistory(document([sample, { ...sample, RemainingPercent: 13 }])).status).toBe(
      "invalid",
    );
    expect(decodeQuotaHistory({ Samples: [sample] }).status).toBe("invalid");
    expect(decodeQuotaHistory(document([{ ...sample, ObservedAt: "bad" }])).status).toBe("invalid");
    const malformedCount = decodeQuotaHistory({
      ...document([sample]),
      Snapshot: {
        MainLimit: { LimitId: "codex", Window: { DurationMinutes: 10080 } },
        EmergencyResetCount: -1,
      },
    });
    expect(malformedCount.status).toBe("ready");
    expect(malformedCount.bankedResetCount).toBeUndefined();
  });
  it.effect("reports missing input without inventing a balance", () =>
    Effect.gen(function* () {
      expect(yield* readQuotaHistory(null)).toMatchObject({ status: "missing", samples: [] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("reads saved files and rejects truncated or oversized history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-quota-history-test-" });
      const file = path.join(directory, "state.json");
      expect((yield* readQuotaHistory(file)).status).toBe("missing");
      yield* fs.writeFileString(
        file,
        '{"Snapshot":{"MainLimit":{"LimitId":"codex","Window":{"DurationMinutes":10080}}},"Samples":[{"ObservedAt":"2026-07-21T17:00:00Z","RemainingPercent":12,"ResetsAt":"2026-07-25T03:24:49Z"}]}',
      );
      expect(yield* readQuotaHistory(file)).toMatchObject({
        status: "ready",
        samples: [{ remainingPercent: 12 }],
      });
      yield* fs.writeFileString(file, '{"Samples":[');
      expect((yield* readQuotaHistory(file)).status).toBe("invalid");
      yield* fs.writeFileString(file, " ".repeat(2 * 1024 * 1024 + 1));
      expect((yield* readQuotaHistory(file)).status).toBe("invalid");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("round-trips native samples through the Codex Limits schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-native-quota-history-test-",
      });
      const file = path.join(directory, "state.json");
      yield* fs.writeFileString(
        file,
        encodeQuotaHistory([
          {
            observedAt: "2026-08-30T12:00:00.000Z",
            remainingPercent: 83,
            resetsAt: "2026-09-05T20:00:00.000Z",
          },
        ]),
      );
      expect(yield* readQuotaHistory(file)).toMatchObject({
        status: "ready",
        samples: [
          {
            observedAt: "2026-08-30T12:00:00.000Z",
            remainingPercent: 83,
            resetsAt: "2026-09-05T20:00:00.000Z",
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it("bounds and validates cost intervals independently of client schemas", () => {
    expect(validQuotaIntervals(intervals, "2026-07-19", "2026-07-23")).toBe(true);
    expect(validQuotaIntervals([...intervals, ...intervals], "2026-07-19", "2026-07-23")).toBe(
      false,
    );
    expect(validQuotaIntervals(intervals, "2026-07-21", "2026-07-21")).toBe(false);
    expect(
      validQuotaIntervals([{ ...intervals[0]!, untilTime: "bad" }], "2026-07-19", "2026-07-23"),
    ).toBe(false);
  });
});

describe("quota cost matching", () => {
  const record = (timestamp: string, model = "unknown"): UsageRecord => ({
    timestampMs: Date.parse(timestamp),
    provider: "codex",
    model,
    sessionId: "chat",
    totals: { ...EMPTY_TOTALS, uncachedInputTokens: 100 },
    dedupeKey: null,
    reportedCostUsd: 2,
  });
  it("matches exact snapshot boundaries without adding the first observation's already-used tokens", () => {
    const accumulator = new QuotaCostAccumulator(intervals, new Map());
    accumulator.add(record(intervals[0]!.sinceTime));
    accumulator.add(record("2026-07-21T16:30:00Z"));
    accumulator.add(record(intervals[0]!.untilTime));
    accumulator.add(record("2026-07-21T17:00:01Z"));
    expect(accumulator.rows[0]).toMatchObject({ records: 2, costUsd: 4 });
    expect(accumulator.rows[0]?.models).toMatchObject([
      { model: "unknown", costUsd: 4, records: 2, totals: { uncachedInputTokens: 200 } },
    ]);
  });
  it("excludes other providers and Spark's independent quota", () => {
    const accumulator = new QuotaCostAccumulator(intervals, new Map());
    accumulator.add({ ...record("2026-07-21T16:30:00Z"), provider: "claude" });
    accumulator.add(record("2026-07-21T16:30:00Z", "gpt-5.3-codex-spark"));
    expect(accumulator.rows[0]?.records).toBe(0);
  });
  it("keeps unknown prices visible as missing, not free usage", () => {
    const accumulator = new QuotaCostAccumulator(intervals, new Map());
    accumulator.add({ ...record("2026-07-21T16:30:00Z"), reportedCostUsd: null });
    expect(accumulator.rows[0]).toMatchObject({ records: 1, costUsd: 0, unpricedRecords: 1 });
  });
  it("uses custom prices when quota records have no provider-reported cost", () => {
    const accumulator = new QuotaCostAccumulator(
      intervals,
      new Map([
        [
          "example-model",
          {
            inputCostPerToken: 1e-6,
            outputCostPerToken: 1e-6,
            cacheReadCostPerToken: 1e-6,
            cacheCreationCostPerToken: 1e-6,
          },
        ],
      ]),
      createOverrideRateTable({
        "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 8 },
      }),
    );
    accumulator.add({
      ...record("2026-07-21T16:30:00Z", "example-model"),
      reportedCostUsd: null,
    });
    expect(accumulator.rows[0]).toMatchObject({ records: 1, unpricedRecords: 0 });
    expect(accumulator.rows[0]?.costUsd).toBeCloseTo(0.0004, 12);
    expect(accumulator.rows[0]?.models).toMatchObject([
      { model: "example-model", unpricedRecords: 0 },
    ]);
    expect(accumulator.rows[0]?.models[0]?.costUsd).toBeCloseTo(0.0004, 12);
  });
});
