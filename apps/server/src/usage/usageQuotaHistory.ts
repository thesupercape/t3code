import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import type { UsageQuotaHistory, UsageQuotaInterval, UsageQuotaSample } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { priceUsage, type RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const SOURCE = "Codex Limits saved history";
const decodeHistoryJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);
const encodeHistoryJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** This boundary reads only the tracker's sanitized percentage samples. */
export function decodeQuotaHistory(document: unknown): UsageQuotaHistory {
  const root = object(document);
  const rows = root?.Samples;
  const invalid: UsageQuotaHistory = {
    status: "invalid",
    source: SOURCE,
    samples: [],
    message: "The saved tracker history is invalid. No quota values were inferred.",
  };
  const main = object(object(root?.Snapshot)?.MainLimit);
  if (main?.LimitId !== "codex" || object(main.Window)?.DurationMinutes !== 10080) return invalid;
  if (!Array.isArray(rows) || rows.length > 5000) return invalid;
  const snapshot = object(root?.Snapshot);
  const emergencyResetCount = snapshot?.EmergencyResetCount;
  const bankedResetCount =
    typeof emergencyResetCount === "number" &&
    Number.isSafeInteger(emergencyResetCount) &&
    emergencyResetCount >= 0
      ? emergencyResetCount
      : undefined;
  const fetchedAt = snapshot?.FetchedAt;
  const fetchedAtMs = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : NaN;
  const samples = new Map<number, UsageQuotaSample>();
  for (const row of rows) {
    const item = object(row);
    if (item === null) return invalid;
    const { ObservedAt, RemainingPercent, ResetsAt } = item;
    if (
      typeof ObservedAt !== "string" ||
      typeof ResetsAt !== "string" ||
      typeof RemainingPercent !== "number" ||
      !Number.isFinite(RemainingPercent) ||
      RemainingPercent < 0 ||
      RemainingPercent > 100
    )
      return invalid;
    const observed = Date.parse(ObservedAt);
    const reset = Date.parse(ResetsAt);
    if (!Number.isFinite(observed) || !Number.isFinite(reset) || observed > reset) return invalid;
    const sample = {
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(observed)),
      remainingPercent: RemainingPercent,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)),
    };
    const prior = samples.get(observed);
    if (
      prior &&
      (prior.remainingPercent !== RemainingPercent || prior.resetsAt !== sample.resetsAt)
    ) {
      return invalid;
    }
    samples.set(observed, sample);
  }
  return {
    status: "ready",
    source: SOURCE,
    samples: [...samples.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
    ...(bankedResetCount === undefined ? {} : { bankedResetCount }),
    ...(bankedResetCount === undefined || !Number.isFinite(fetchedAtMs)
      ? {}
      : { bankedResetCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(fetchedAtMs)) }),
    message: null,
  };
}

/** Encode native samples in the Codex Limits tracker's PascalCase schema. */
export function encodeQuotaHistory(samples: readonly UsageQuotaSample[]): string {
  return encodeHistoryJson({
    Snapshot: { MainLimit: { LimitId: "codex", Window: { DurationMinutes: 10080 } } },
    Samples: samples.map((sample) => ({
      ObservedAt: sample.observedAt,
      RemainingPercent: sample.remainingPercent,
      ResetsAt: sample.resetsAt,
    })),
  });
}

export const readQuotaHistory = Effect.fn("UsageQuotaHistory.read")(
  function* (override: string | null | undefined) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const filePath =
      override === undefined
        ? process.env.T3CODE_QUOTA_HISTORY_PATH ||
          (process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "CodexLimits", "state.json")
            : platform === "darwin"
              ? path.join(
                  NodeOS.homedir(),
                  "Library",
                  "Application Support",
                  "CodexLimits",
                  "state.json",
                )
              : null)
        : override;
    const missing: UsageQuotaHistory = {
      status: "missing",
      source: SOURCE,
      samples: [],
      message: "No saved Codex Limits history is available on this environment.",
    };
    if (filePath === null) return missing;
    if (!(yield* fileSystem.exists(filePath))) return missing;
    const stat = yield* fileSystem.stat(filePath);
    if (Number(stat.size) > MAX_HISTORY_BYTES) return decodeQuotaHistory(null);
    const text = yield* fileSystem.readFileString(filePath);
    if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) return decodeQuotaHistory(null);
    const json = yield* decodeHistoryJson(text);
    return decodeQuotaHistory(json);
  },
  Effect.catchCause(() => Effect.succeed(decodeQuotaHistory(null))),
);

/** Intervals must be ordered, disjoint, bounded and inside the scanned days. */
export function validQuotaIntervals(
  intervals: readonly UsageQuotaInterval[],
  sinceDay: string,
  untilDay: string,
): boolean {
  if (intervals.length > 64) return false;
  const earliest = Date.parse(`${sinceDay}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  const latest = Date.parse(`${untilDay}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  let previousEnd = -Infinity;
  const ids = new Set<string>();
  return intervals.every((interval) => {
    const start = Date.parse(interval.sinceTime);
    const end = Date.parse(interval.untilTime);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      start < earliest ||
      end > latest ||
      start < previousEnd ||
      ids.has(interval.id)
    )
      return false;
    previousEnd = end;
    ids.add(interval.id);
    return true;
  });
}

/** Only records accepted by the existing deduplication pass enter this accumulator. */
export class QuotaCostAccumulator {
  readonly rows;
  readonly rates: RateTable;
  readonly overrides: RateTable | undefined;
  constructor(intervals: readonly UsageQuotaInterval[], rates: RateTable, overrides?: RateTable) {
    this.rates = rates;
    this.overrides = overrides;
    this.rows = intervals.map((interval) => ({
      intervalId: interval.id,
      start: Date.parse(interval.sinceTime),
      end: Date.parse(interval.untilTime),
      costUsd: 0,
      records: 0,
      unpricedRecords: 0,
      models: [] as {
        model: string;
        totals: UsageRecord["totals"];
        costUsd: number;
        records: number;
        unpricedRecords: number;
      }[],
    }));
  }

  add(record: UsageRecord): void {
    // Spark has its own quota and is not part of the main weekly percentage.
    if (record.provider !== "codex" || /spark|bengalfox/i.test(record.model)) return;
    // Binary search keeps a 90-day scan independent of the number of reset periods.
    let low = 0;
    let high = this.rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.rows[mid]!.end < record.timestampMs) low = mid + 1;
      else high = mid;
    }
    const row = this.rows[low];
    if (!row || record.timestampMs <= row.start) return;
    const priced = priceUsage(
      this.rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
      record.serviceTier,
      this.overrides,
    );
    row.costUsd += priced.costUsd;
    row.records++;
    if (priced.costSource === "unpriced") row.unpricedRecords++;
    let model = row.models.find((entry) => entry.model === record.model);
    if (!model) {
      model = {
        model: record.model,
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0,
        records: 0,
        unpricedRecords: 0,
      };
      row.models.push(model);
    }
    model.totals = {
      uncachedInputTokens: model.totals.uncachedInputTokens + record.totals.uncachedInputTokens,
      cachedInputTokens: model.totals.cachedInputTokens + record.totals.cachedInputTokens,
      cacheCreationTokens: model.totals.cacheCreationTokens + record.totals.cacheCreationTokens,
      outputTokens: model.totals.outputTokens + record.totals.outputTokens,
      reasoningTokens: model.totals.reasoningTokens + record.totals.reasoningTokens,
    };
    model.costUsd += priced.costUsd;
    model.records++;
    if (priced.costSource === "unpriced") model.unpricedRecords++;
  }
}
