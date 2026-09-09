import type {
  UsageQuotaInterval,
  UsageQuotaCostSnapshot,
  UsageQuotaSample,
  UsageSourceFingerprint,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Start a new monitoring run after a day without readings; retain the source history. */
export function quotaMonitoringSamples(samples: readonly UsageQuotaSample[]) {
  const sorted = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  let start = 0;
  for (let index = 1; index < sorted.length; index++) {
    if (
      Date.parse(sorted[index]!.observedAt) - Date.parse(sorted[index - 1]!.observedAt) >
      DAY_MS
    ) {
      start = index;
    }
  }
  return sorted.slice(start);
}

export interface QuotaPeriod {
  readonly id: string;
  readonly first: UsageQuotaSample;
  readonly last: UsageQuotaSample;
  readonly next: UsageQuotaSample | null;
  readonly sampleCount: number;
  readonly resetKind: "scheduled" | "unexpected" | "ambiguous" | "unobserved";
  readonly usedPercentagePoints: number;
  readonly observationGapMs: number | null;
}

/** A changed reset clock alone is not proof that a reset was used. */
export function quotaPeriods(samples: readonly UsageQuotaSample[]): readonly QuotaPeriod[] {
  const sorted = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const groups: UsageQuotaSample[][] = [];
  for (const sample of sorted) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    // A clock-only adjustment may be ambiguous, but it is safe to cross only
    // when the period used nothing and its balance is unchanged at both edges.
    if (
      !group ||
      !previous ||
      sample.remainingPercent > previous.remainingPercent ||
      Math.abs(Date.parse(sample.resetsAt) - Date.parse(previous.resetsAt)) > MINUTE_MS
    ) {
      groups.push([sample]);
    } else if (sample.observedAt !== previous.observedAt) group.push(sample);
  }
  return groups.slice(-64).map((group, index, retained) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const next = retained[index + 1]?.[0] ?? null;
    const observationGapMs =
      next === null ? null : Date.parse(next.observedAt) - Date.parse(last.observedAt);
    let resetKind: QuotaPeriod["resetKind"] = "unobserved";
    if (next !== null) {
      const reset = Date.parse(last.resetsAt);
      if (
        Date.parse(next.observedAt) >= reset &&
        Date.parse(last.observedAt) <= reset &&
        Date.parse(next.resetsAt) > reset + MINUTE_MS
      )
        resetKind = "scheduled";
      else if (
        Date.parse(next.observedAt) < reset &&
        next.remainingPercent > last.remainingPercent + 2
      ) {
        resetKind = "unexpected";
      } else resetKind = "ambiguous";
    }
    return {
      id: first.observedAt,
      first,
      last,
      next,
      resetKind,
      observationGapMs,
      sampleCount: group.length,
      usedPercentagePoints: first.remainingPercent - last.remainingPercent,
    };
  });
}

export function quotaIntervals(periods: readonly QuotaPeriod[]): readonly UsageQuotaInterval[] {
  return periods
    .filter((period) => period.first.observedAt < period.last.observedAt)
    .map((period) => ({
      id: period.id,
      sinceTime: period.first.observedAt,
      untilTime: period.last.observedAt,
    }));
}

/** UTC padding avoids clipping observations at a client's local day boundary. */
export function quotaCostWindow(
  intervals: readonly UsageQuotaInterval[],
): UsageSummaryInput | null {
  const first = intervals[0];
  const last = intervals.at(-1);
  if (!first || !last) return null;
  return {
    sinceDay: DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(first.sinceTime) - 2 * DAY_MS),
    ).slice(0, 10) as UsageSummaryInput["sinceDay"],
    untilDay: DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(last.untilTime) + 2 * DAY_MS),
    ).slice(0, 10) as UsageSummaryInput["untilDay"],
    timeZone: "UTC",
    quotaIntervals: intervals,
  };
}

export interface QuotaEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly summary: UsageSummary | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface QuotaValue {
  readonly cachedAt?: string;
  readonly costUsd: number | null;
  readonly usdPerPercentagePoint: number | null;
  readonly remainingValueUsd: number | null;
  readonly unusedValueUsd: number | null;
  readonly reason: string | null;
  readonly historicalCalibration?: { readonly since: string; readonly until: string };
  readonly historicalCostRecordedAt?: string;
  readonly costObservedUntil?: string;
}

export interface QuotaValueSnapshot {
  readonly key: string;
  readonly period: QuotaPeriod;
  readonly value: QuotaValue;
  readonly calculatedAt: string;
}

/** A complete calculation belongs to one tracker, selection, and exact observed period. */
export function quotaValueSnapshots(
  trackerId: string | undefined,
  periods: readonly QuotaPeriod[],
  environments: readonly QuotaEnvironment[],
): readonly QuotaValueSnapshot[] {
  const selection = environments
    .map((environment) => ({
      id: environment.environmentId,
      sources:
        environment.summary?.sources
          .filter((source) => source.fingerprint.provider === "codex")
          .map((source) => sourceKey(source.fingerprint))
          .sort() ?? [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const calculatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  return periods.map((period) => ({
    key: JSON.stringify([trackerId, selection, period]),
    period,
    value: quotaValue(period, environments),
    calculatedAt,
  }));
}

export function retainQuotaValueSnapshots(
  previous: ReadonlyMap<string, QuotaValueSnapshot>,
  current: readonly QuotaValueSnapshot[],
): ReadonlyMap<string, QuotaValueSnapshot> {
  const complete = current.filter((snapshot) => snapshot.value.costUsd !== null);
  if (complete.every((snapshot) => previous.get(snapshot.key) === snapshot)) return previous;
  const next = new Map(previous);
  for (const snapshot of complete) {
    next.delete(snapshot.key);
    next.set(snapshot.key, snapshot);
  }
  while (next.size > 128) next.delete(next.keys().next().value!);
  return next;
}

/** A labeled past calculation, never a conversion of incomplete costs. */
export function quotaValueWithSnapshot(
  current: QuotaValueSnapshot,
  cached: ReadonlyMap<string, QuotaValueSnapshot>,
): QuotaValue {
  if (current.value.costUsd !== null) return current.value;
  const previous = cached.get(current.key);
  if (!previous) return current.value;
  return {
    ...previous.value,
    cachedAt: previous.calculatedAt,
    reason: `Showing the last complete calculation. ${current.value.reason ?? "Updated costs are not yet available."}`,
  };
}

/**
 * Carries a completed cycle's price calibration across a confirmed reset.
 * The current cycle's measured cost is deliberately left untouched.
 */
export function quotaValueWithHistoricalCalibration(
  current: QuotaValueSnapshot,
  previous: QuotaValueSnapshot | undefined,
  earlier: readonly QuotaValueSnapshot[] = [],
): QuotaValue {
  if (current.value.usdPerPercentagePoint !== null || previous === undefined) return current.value;
  const candidates = [previous, ...[...earlier].reverse()];
  let source: QuotaValueSnapshot | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const next = index === 0 ? current : candidates[index - 1];
    if (candidate.period.next?.observedAt !== next?.period.first.observedAt) break;
    if (
      Date.parse(current.period.first.observedAt) - Date.parse(candidate.period.last.observedAt) >
      60 * MINUTE_MS
    )
      break;
    if (
      (candidate.period.resetKind === "scheduled" || candidate.period.resetKind === "unexpected") &&
      candidate.value.usdPerPercentagePoint !== null &&
      Number.isFinite(candidate.value.usdPerPercentagePoint) &&
      candidate.value.usdPerPercentagePoint > 0
    ) {
      source = candidate;
      break;
    }
    if (
      (candidate.period.resetKind !== "scheduled" && candidate.period.resetKind !== "ambiguous") ||
      candidate.period.usedPercentagePoints !== 0 ||
      candidate.period.first.remainingPercent !== candidate.period.last.remainingPercent ||
      candidate.period.last.remainingPercent !== next?.period.first.remainingPercent
    )
      break;
  }
  if (source === undefined) return current.value;
  const calibration = source.value.usdPerPercentagePoint!;
  return {
    ...current.value,
    usdPerPercentagePoint: calibration,
    remainingValueUsd: calibration * current.period.last.remainingPercent,
    historicalCalibration: {
      since: source.period.first.observedAt,
      until: source.period.last.observedAt,
    },
  };
}

function sourceKey(source: UsageSourceFingerprint): string {
  return JSON.stringify([source.hostId, source.provider, source.resolvedHomePath, source.volumeId]);
}

export interface QuotaSavedCostPrefix {
  readonly interval: UsageQuotaInterval;
  readonly rows: readonly UsageQuotaCostSnapshot[];
}

/** Finds the newest complete same-cycle prefix shared by every selected source. */
export function quotaSavedCostPrefix(
  period: QuotaPeriod,
  environments: readonly QuotaEnvironment[],
): QuotaSavedCostPrefix | null {
  const expected = new Set<string>();
  const candidates = new Map<string, UsageQuotaCostSnapshot[]>();
  const environmentRequirements: Array<{
    readonly keys: Set<string>;
    readonly byUntil: Map<string, Set<string>>;
  }> = [];
  for (const environment of environments) {
    const summary = environment.summary;
    if (!summary) return null;
    const requirement = { keys: new Set<string>(), byUntil: new Map<string, Set<string>>() };
    environmentRequirements.push(requirement);
    const sources = summary.sources.filter(
      (source) => source.fingerprint.provider === "codex" && source.status !== "missing",
    );
    for (const source of sources) {
      const key = sourceKey(source.fingerprint);
      expected.add(key);
      requirement.keys.add(key);
    }
  }
  for (const [environmentIndex, environment] of environments.entries()) {
    const summary = environment.summary;
    if (!summary) return null;
    const requirement = environmentRequirements[environmentIndex]!;
    for (const row of summary.quotaCostSnapshots ?? []) {
      const key = sourceKey(row.fingerprint);
      if (
        row.fingerprint.provider !== "codex" ||
        (expected.size > 0 && !expected.has(key)) ||
        row.intervalId !== period.id ||
        row.sinceTime !== period.first.observedAt ||
        !Number.isFinite(Date.parse(row.sinceTime)) ||
        !Number.isFinite(Date.parse(row.untilTime)) ||
        Date.parse(row.sinceTime) >= Date.parse(row.untilTime) ||
        row.untilTime >= period.last.observedAt ||
        row.firstRemainingPercent !== period.first.remainingPercent ||
        row.resetsAt !== period.first.resetsAt ||
        !Number.isFinite(row.costUsd) ||
        row.costUsd < 0 ||
        !Number.isSafeInteger(row.records) ||
        row.records < 0 ||
        !Number.isFinite(row.firstRemainingPercent) ||
        !Number.isFinite(row.lastRemainingPercent) ||
        row.lastRemainingPercent < 0 ||
        row.lastRemainingPercent > 100 ||
        row.firstRemainingPercent <= row.lastRemainingPercent ||
        row.lastRemainingPercent < period.last.remainingPercent
      )
        continue;
      const rows = candidates.get(row.untilTime) ?? [];
      rows.push(row);
      candidates.set(row.untilTime, rows);
      const keys = requirement.byUntil.get(row.untilTime) ?? new Set<string>();
      keys.add(key);
      requirement.byUntil.set(row.untilTime, keys);
    }
  }
  if (expected.size === 0) {
    for (const rows of candidates.values())
      for (const row of rows) expected.add(sourceKey(row.fingerprint));
  }
  const untilTimes = [...candidates.keys()].sort((a, b) => Date.parse(b) - Date.parse(a));
  for (const untilTime of untilTimes) {
    const rows = candidates.get(untilTime)!;
    const bySource = new Map(rows.map((row) => [sourceKey(row.fingerprint), row]));
    if (![...expected].every((key) => bySource.has(key))) continue;
    if (
      !environmentRequirements.every((requirement) => {
        const keys = requirement.byUntil.get(untilTime);
        return (
          keys !== undefined &&
          (requirement.keys.size === 0
            ? keys.size > 0
            : [...requirement.keys].every((key) => keys.has(key)))
        );
      })
    )
      continue;
    const selected = [...expected].map((key) => bySource.get(key)!);
    if (!selected.every((row) => row.lastRemainingPercent === selected[0]!.lastRemainingPercent))
      continue;
    if (selected.reduce((total, row) => total + row.records, 0) === 0) continue;
    return {
      interval: { id: period.id, sinceTime: period.first.observedAt, untilTime },
      rows: selected,
    };
  }
  return null;
}

/** Estimates assume selected transcripts cover one account; percentages are never summed. */
function quotaValueExact(
  period: QuotaPeriod,
  environments: readonly QuotaEnvironment[],
): QuotaValue {
  const unavailable = (reason: string): QuotaValue => ({
    costUsd: null,
    usdPerPercentagePoint: null,
    remainingValueUsd: null,
    unusedValueUsd: null,
    reason,
  });
  if (environments.length === 0)
    return unavailable("Select the computers containing this account's history.");
  if (period.first.observedAt === period.last.observedAt)
    return unavailable("Waiting for the next tracker reading to measure usage.");
  const seen = new Set<string>();
  let costUsd = 0;
  let records = 0;
  let unpricedRecords = 0;
  let savedCostRecordedAt: string | undefined;
  let savedFallbackReason: string | undefined;
  for (const environment of [...environments].sort((a, b) =>
    a.environmentId.localeCompare(b.environmentId),
  )) {
    const { summary, label } = environment;
    if (environment.isPending && !summary) {
      return unavailable(`${label} is still reading Codex transcripts.`);
    }
    if (!summary) {
      return unavailable(`${label} has not supplied a complete usage result.`);
    }
    const savedOnly = (summary.quotaCostSnapshots ?? []).filter(
      (candidate) =>
        candidate.fingerprint.provider === "codex" &&
        candidate.intervalId === period.id &&
        candidate.sinceTime === period.first.observedAt &&
        candidate.untilTime === period.last.observedAt,
    );
    const requiredSavedSources = summary.sources.filter(
      (source) => source.fingerprint.provider === "codex" && source.status !== "missing",
    );
    const savedForRequiredSources = new Set(
      savedOnly.map((candidate) => sourceKey(candidate.fingerprint)),
    );
    // A history-only response can be merged into a failed current request.
    // Consume only the exact persisted interval in that case; never treat the
    // failed request's live totals as authoritative.
    const canUseSavedOnly =
      savedOnly.length > 0 &&
      requiredSavedSources.every((source) =>
        savedForRequiredSources.has(sourceKey(source.fingerprint)),
      );
    if (canUseSavedOnly && (environment.error !== null || summary.quotaCosts === undefined)) {
      const savedRows =
        requiredSavedSources.length === 0
          ? savedOnly
          : savedOnly.filter((saved) =>
              requiredSavedSources.some(
                (source) => sourceKey(source.fingerprint) === sourceKey(saved.fingerprint),
              ),
            );
      for (const saved of savedRows) {
        if (
          !Number.isFinite(saved.costUsd) ||
          saved.costUsd < 0 ||
          !Number.isSafeInteger(saved.records) ||
          saved.records < 0 ||
          !Number.isFinite(Date.parse(saved.recordedAt))
        )
          return unavailable("A saved cost result is invalid.");
        const key = sourceKey(saved.fingerprint);
        if (seen.has(key)) continue;
        seen.add(key);
        costUsd += saved.costUsd;
        records += saved.records;
        savedCostRecordedAt = saved.recordedAt;
      }
      if (environment.error !== null) {
        savedFallbackReason = `${label} could not report current usage; showing the saved cost for this observed period.`;
      }
      continue;
    }
    if (environment.error) {
      return unavailable(`${label} could not report usage. Refresh to retry.`);
    }
    if (summary.quotaCosts === undefined)
      return unavailable(`${label} needs a server with reset-history support.`);
    const sources = summary.sources.filter(
      (source) => source.fingerprint.provider === "codex" && source.status !== "missing",
    );
    if (sources.length === 0)
      return unavailable(`${label} has no readable Codex transcript source.`);
    for (const source of sources) {
      const key = sourceKey(source.fingerprint);
      if (seen.has(key)) continue;
      const row = summary.quotaCosts.find(
        (candidate) =>
          candidate.intervalId === period.id && sourceKey(candidate.fingerprint) === key,
      );
      const saved = summary.quotaCostSnapshots?.find(
        (candidate) =>
          candidate.intervalId === period.id &&
          candidate.sinceTime === period.first.observedAt &&
          candidate.untilTime === period.last.observedAt &&
          sourceKey(candidate.fingerprint) === key,
      );
      if (source.status !== "ok" && saved === undefined)
        return unavailable(`${label}'s transcript scan is incomplete.`);
      const cost =
        source.status === "ok" && row?.complete && row.unpricedRecords === 0 ? row : saved;
      if (!cost) return unavailable(`${label} has not supplied costs for this observed period.`);
      if (!Number.isFinite(cost.costUsd) || cost.costUsd < 0)
        return unavailable("A cost result is invalid.");
      seen.add(key);
      costUsd += cost.costUsd;
      records += cost.records;
      unpricedRecords += "unpricedRecords" in cost ? cost.unpricedRecords : 0;
      if (row !== cost && saved !== undefined) {
        savedCostRecordedAt = saved.recordedAt;
        if (source.status !== "ok") {
          savedFallbackReason = `${label}'s transcript scan is incomplete; showing the saved cost for this observed period.`;
        }
      }
    }
  }
  if (records === 0)
    return unavailable("No matching transcript usage was found. Missing history is not zero cost.");
  if (unpricedRecords > 0)
    return unavailable("Some matching usage has no model price. Dollar estimates are withheld.");
  const measured: QuotaValue = {
    costUsd,
    usdPerPercentagePoint: null,
    remainingValueUsd: null,
    unusedValueUsd: null,
    reason: savedFallbackReason ?? null,
    ...(savedCostRecordedAt === undefined ? {} : { historicalCostRecordedAt: savedCostRecordedAt }),
  };
  const withFallbackReason = (reason: string) =>
    savedFallbackReason === undefined ? reason : `${reason} ${savedFallbackReason}`;
  if (period.usedPercentagePoints < 5)
    return {
      ...measured,
      reason: withFallbackReason(
        "At least 5 percentage points of observed usage are needed for a conversion.",
      ),
    };
  const usdPerPercentagePoint = costUsd / period.usedPercentagePoints;
  const calibrated = {
    ...measured,
    usdPerPercentagePoint,
    remainingValueUsd: usdPerPercentagePoint * period.last.remainingPercent,
  };
  if (period.resetKind === "unobserved")
    return {
      ...calibrated,
      reason: withFallbackReason(
        "Based on the last reading and current model mix. Usage after that reading is not included.",
      ),
    };
  if (period.resetKind === "ambiguous")
    return {
      ...calibrated,
      reason: withFallbackReason(
        "Value left is estimated at the last reading. This change cannot be identified as a reset.",
      ),
    };
  if (period.observationGapMs === null || period.observationGapMs > 60 * MINUTE_MS) {
    return {
      ...calibrated,
      reason: withFallbackReason(
        "Value left is estimated at the last reading. The reset observations are over an hour apart, so value left at the reset is unknown.",
      ),
    };
  }
  return {
    ...calibrated,
    unusedValueUsd: usdPerPercentagePoint * period.last.remainingPercent,
    reason: withFallbackReason(
      "Based on the last pre-reset observation and the same model mix. Usage between observations is unknown.",
    ),
  };
}

export function quotaValue(
  period: QuotaPeriod,
  environments: readonly QuotaEnvironment[],
): QuotaValue {
  const exact = quotaValueExact(period, environments);
  if (exact.costUsd !== null) return exact;
  const savedPrefix = quotaSavedCostPrefix(period, environments);
  if (savedPrefix === null) return exact;
  const costUsd = savedPrefix.rows.reduce((total, row) => total + row.costUsd, 0);
  const records = savedPrefix.rows.reduce((total, row) => total + row.records, 0);
  const firstRemaining = savedPrefix.rows[0]!.firstRemainingPercent;
  const lastRemaining = savedPrefix.rows[0]!.lastRemainingPercent;
  const used = firstRemaining - lastRemaining;
  if (records === 0) return exact;
  if (used < 5)
    return {
      costUsd,
      usdPerPercentagePoint: null,
      remainingValueUsd: null,
      unusedValueUsd: null,
      reason: `Current transcript scan is incomplete; observed cost is complete through ${savedPrefix.interval.untilTime}. At least 5 percentage points of observed usage are needed for a conversion.`,
      costObservedUntil: savedPrefix.interval.untilTime,
    };
  const usdPerPercentagePoint = costUsd / used;
  return {
    costUsd,
    usdPerPercentagePoint,
    remainingValueUsd: usdPerPercentagePoint * period.last.remainingPercent,
    unusedValueUsd: null,
    reason: `Current transcript scan is incomplete; observed cost is complete through ${savedPrefix.interval.untilTime}.`,
    costObservedUntil: savedPrefix.interval.untilTime,
  };
}

/** Lines stop across missing hours and reset changes; every point is a saved observation. */
export function quotaHistoryPoints(samples: readonly UsageQuotaSample[]) {
  const sorted = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const firstTime = sorted[0] ? Date.parse(sorted[0].observedAt) : 0;
  const lastTime = sorted.at(-1) ? Date.parse(sorted.at(-1)!.observedAt) : firstTime;
  return sorted.map((sample, index) => {
    const previous = sorted[index - 1];
    const resetChange =
      previous !== undefined &&
      (sample.remainingPercent > previous.remainingPercent ||
        Math.abs(Date.parse(sample.resetsAt) - Date.parse(previous.resetsAt)) > MINUTE_MS);
    return {
      ...sample,
      x:
        lastTime === firstTime
          ? 0.5
          : (Date.parse(sample.observedAt) - firstTime) / (lastTime - firstTime),
      resetChange,
      breakBefore:
        previous === undefined ||
        resetChange ||
        Date.parse(sample.observedAt) - Date.parse(previous.observedAt) > 60 * MINUTE_MS,
    };
  });
}
