import type { UsageQuotaInterval } from "@t3tools/contracts";
import type { QuotaForecast } from "@t3tools/shared/usageQuotaForecast";
import type { QuotaPeriod } from "@t3tools/shared/usageQuota";
import { monitoredModels } from "./usageTokenBudget";

const HOUR = 3_600_000;

export function apiPaceInterval(
  interval: UsageQuotaInterval | undefined,
): UsageQuotaInterval | null {
  if (!interval) return null;
  const until = Date.parse(interval.untilTime);
  const since = Math.max(Date.parse(interval.sinceTime), until - 6 * HOUR);
  if (until - since < HOUR) return null;
  const sinceTime = new Date(since).toISOString();
  return { id: `api-pace:${sinceTime}`, sinceTime, untilTime: interval.untilTime };
}

export interface ApiPaceInput {
  readonly interval: UsageQuotaInterval;
  readonly models: ReturnType<typeof monitoredModels>;
  readonly remainingValueUsd: number | null;
}

/** A complete prior cycle used only to provisionally calibrate a new cycle. */
export interface PriorApiPaceInput {
  readonly interval: UsageQuotaInterval;
  readonly models: ReturnType<typeof monitoredModels>;
  readonly period: QuotaPeriod;
  /** Current cycle's observed balance; prior usage only supplies the burn rate. */
  readonly remainingValueUsd: number | null;
  /** Target cycle start after the shared calibration selector validated the bridge. */
  readonly calibrationTargetSince?: string;
}

export type ApiCostPace = NonNullable<ReturnType<typeof apiCostPace>>;

export const DEFAULT_NO_USAGE_TOLERANCE_HOURS = 12;

export interface ManualResetSummary {
  /** Count from a live CUAR readback, or a user-entered estimate when false. */
  readonly availableCount: number;
  readonly verified: boolean;
  readonly expiries?: readonly string[];
  readonly checkedAt?: string;
}

export interface UsageRunwayPlan {
  readonly toleranceHours: number;
  readonly scheduledResetAt: string;
  readonly measuredUsdPerHour: number;
  readonly targetUsdPerHour: number | null;
  readonly targetAt: string | null;
  readonly exhaustionAt: string | null;
  readonly noUsageMs: number | null;
  readonly noUsageHours: number | null;
  readonly remainingAtTargetUsd: number;
  readonly withinTolerance: boolean | null;
  readonly remainingValueUsd: number;
}

export interface ManualResetScenario {
  readonly remainingCount: number;
  readonly fullCycleValueUsd: number | null;
  readonly windowEndsAt: string;
  readonly hoursAtBurn: number | null;
  readonly exhaustionAt: string | null;
  readonly noUsageMs: number | null;
  readonly expiryAt: string | null;
  /** null means expiry data was not supplied, not that the credit is valid. */
  readonly expiryAllowsUse: boolean | null;
}

/** Simulate one manual reset after the current balance is empty. Never mutates account state. */
export function manualResetScenario(
  pace: ApiCostPace | null,
  manualResets: ManualResetSummary,
  now: number,
  scheduledResetAt: string,
  windowHours = 7 * 24,
): ManualResetScenario | null {
  const count = Math.max(0, Math.floor(manualResets.availableCount));
  if (
    !pace ||
    count < 1 ||
    !Number.isFinite(now) ||
    !Number.isFinite(windowHours) ||
    windowHours <= 0
  )
    return null;
  const observed = Date.parse(pace.observedAt);
  const scheduledReset = Date.parse(scheduledResetAt);
  if (!Number.isFinite(observed) || !Number.isFinite(scheduledReset) || scheduledReset <= now)
    return null;
  const currentExhaustion =
    pace.usdPerHour > 0 ? observed + (pace.remainingValueUsd / pace.usdPerHour) * HOUR : null;
  if (currentExhaustion === null || currentExhaustion >= scheduledReset) return null;
  const activationAt = Math.max(now, currentExhaustion);
  if (activationAt >= scheduledReset) return null;
  const windowEndsAt = new Date(activationAt + windowHours * HOUR).toISOString();
  const hoursAtBurn =
    pace.fullCycleValueUsd !== null && pace.usdPerHour > 0
      ? pace.fullCycleValueUsd / pace.usdPerHour
      : null;
  const exhaustionAt =
    hoursAtBurn === null ? null : new Date(activationAt + hoursAtBurn * HOUR).toISOString();
  const noUsageMs =
    pace.fullCycleValueUsd === null
      ? null
      : hoursAtBurn === null
        ? 0
        : Math.max(0, Date.parse(windowEndsAt) - Date.parse(exhaustionAt!));
  const expiryAt = manualResets.expiries?.[0] ?? null;
  const expiry = expiryAt === null ? NaN : Date.parse(expiryAt);
  return {
    remainingCount: count - 1,
    fullCycleValueUsd: pace.fullCycleValueUsd,
    windowEndsAt,
    hoursAtBurn,
    exhaustionAt,
    noUsageMs,
    expiryAt,
    expiryAllowsUse: Number.isFinite(expiry) ? expiry > activationAt : null,
  };
}

/**
 * Turn the observed API-value burn into the practical question: when would
 * allowance run out, and what average burn reaches zero at the user's target?
 * The scheduled reset is deliberately kept separate from any news deadline.
 */
export function usageRunwayPlan(
  pace: ApiCostPace | null,
  scheduledResetAt: string,
  now: number,
  toleranceHours = DEFAULT_NO_USAGE_TOLERANCE_HOURS,
): UsageRunwayPlan | null {
  if (!pace || !Number.isFinite(now)) return null;
  const reset = Date.parse(scheduledResetAt);
  const tolerance = Number.isFinite(toleranceHours) ? Math.max(0, toleranceHours) : 0;
  if (!Number.isFinite(reset) || reset <= now) return null;

  const observed = Date.parse(pace.observedAt);
  if (!Number.isFinite(observed)) return null;
  const remainingNow = Math.max(
    0,
    pace.remainingValueUsd - (pace.usdPerHour * Math.max(0, now - observed)) / HOUR,
  );
  const targetDeadlineMs = reset - tolerance * HOUR;
  const targetMs = Math.max(targetDeadlineMs, now);
  const targetHours = (targetMs - now) / HOUR;
  const targetUsdPerHour = targetHours > 0 ? remainingNow / targetHours : null;
  const remainingAtTargetUsd = Math.max(
    0,
    remainingNow - pace.usdPerHour * Math.max(0, targetHours),
  );
  const exhaustionMs =
    pace.remainingValueUsd === 0
      ? observed
      : pace.usdPerHour > 0
        ? observed + (pace.remainingValueUsd / pace.usdPerHour) * HOUR
        : null;
  const exhaustionAtMs = exhaustionMs;
  // A zero-burn interval is known to have no outage before reset; it simply
  // cannot provide an exhaustion timestamp. Keep that distinct from missing
  // evidence, which returns null for the whole plan above.
  const noUsageMs =
    exhaustionAtMs === null ? 0 : Math.max(0, reset - Math.max(exhaustionAtMs, now));
  const noUsageHours = noUsageMs === null ? null : noUsageMs / HOUR;

  return {
    toleranceHours: tolerance,
    scheduledResetAt,
    measuredUsdPerHour: pace.usdPerHour,
    targetUsdPerHour,
    targetAt: targetDeadlineMs > now ? new Date(targetDeadlineMs).toISOString() : null,
    exhaustionAt: exhaustionAtMs === null ? null : new Date(exhaustionAtMs).toISOString(),
    noUsageMs,
    noUsageHours,
    remainingAtTargetUsd,
    withinTolerance: noUsageHours === null ? null : noUsageHours <= tolerance + 1e-9,
    remainingValueUsd: remainingNow,
  };
}

/** Price recent transcript usage, then spend the calibrated balance at that hourly rate. */
export function apiCostPace(
  forecast: QuotaForecast,
  input: ApiPaceInput | null,
  now: number,
  priorCycle?: PriorApiPaceInput | null,
) {
  if (forecast.stale) return null;
  const currentUsable =
    input !== null &&
    input.models !== null &&
    input.remainingValueUsd !== null &&
    Number.isFinite(input.remainingValueUsd) &&
    input.remainingValueUsd >= 0 &&
    input.interval.untilTime === forecast.latest.observedAt &&
    Date.parse(input.interval.untilTime) - Date.parse(input.interval.sinceTime) >= HOUR &&
    input.models.every(
      (row) => row.unpricedRecords === 0 && Number.isFinite(row.costUsd) && row.costUsd >= 0,
    );
  if (!currentUsable) {
    if (!priorCycle || priorCycle.models === null) return null;
    const priorSince = Date.parse(priorCycle.interval.sinceTime);
    const priorUntil = Date.parse(priorCycle.interval.untilTime);
    const currentStart = Date.parse(forecast.first.observedAt);
    const observed = Date.parse(forecast.latest.observedAt);
    if (
      !Number.isFinite(priorSince) ||
      !Number.isFinite(priorUntil) ||
      priorUntil - priorSince < HOUR ||
      !Number.isFinite(currentStart) ||
      currentStart - priorUntil > HOUR ||
      priorUntil > currentStart ||
      priorUntil >= observed ||
      (priorCycle.period.resetKind !== "scheduled" &&
        priorCycle.period.resetKind !== "unexpected") ||
      (priorCycle.period.next?.observedAt !== forecast.first.observedAt &&
        priorCycle.calibrationTargetSince !== forecast.first.observedAt) ||
      priorCycle.period.first.observedAt !== priorCycle.interval.sinceTime ||
      priorCycle.period.last.observedAt !== priorCycle.interval.untilTime ||
      (priorCycle.period.observationGapMs ?? Infinity) > 60 * 60_000 ||
      priorCycle.models.some(
        (row) => row.unpricedRecords > 0 || !Number.isFinite(row.costUsd) || row.costUsd < 0,
      )
    )
      return null;
    const costUsd = priorCycle.models.reduce((sum, row) => sum + row.costUsd, 0);
    const hours = (priorUntil - priorSince) / HOUR;
    const remainingValueUsd = priorCycle.remainingValueUsd;
    if (remainingValueUsd === null || !Number.isFinite(remainingValueUsd) || remainingValueUsd < 0)
      return null;
    return projectApiCostPace(
      forecast,
      now,
      costUsd,
      hours,
      remainingValueUsd,
      true,
      priorCycle.interval.sinceTime,
      priorCycle.interval.untilTime,
    );
  }
  if (!input || input.models === null) return null;
  const { interval, models, remainingValueUsd } = input;
  const observed = Date.parse(interval.untilTime);
  const since = Date.parse(interval.sinceTime);
  if (
    interval.untilTime !== forecast.latest.observedAt ||
    since < Date.parse(forecast.first.observedAt) ||
    observed - since < HOUR ||
    remainingValueUsd === null ||
    !Number.isFinite(remainingValueUsd) ||
    remainingValueUsd < 0 ||
    models.some(
      (row) => row.unpricedRecords > 0 || !Number.isFinite(row.costUsd) || row.costUsd < 0,
    )
  )
    return null;
  const costUsd = models.reduce((sum, row) => sum + row.costUsd, 0);
  const hours = (observed - since) / HOUR;
  return projectApiCostPace(
    forecast,
    now,
    costUsd,
    hours,
    remainingValueUsd,
    false,
    interval.sinceTime,
    interval.untilTime,
  );
}

function projectApiCostPace(
  forecast: QuotaForecast,
  now: number,
  costUsd: number,
  hours: number,
  remainingValueUsd: number,
  provisional: boolean,
  sourceSince: string,
  sourceUntil: string,
) {
  const usdPerHour = costUsd / hours;
  const observed = Date.parse(forecast.latest.observedAt);
  const reset = Date.parse(forecast.planningResetAt);
  const exhaustion =
    remainingValueUsd === 0
      ? observed
      : usdPerHour > 0
        ? observed + (remainingValueUsd / usdPerHour) * HOUR
        : null;
  const remainingAtResetUsd = Math.max(
    0,
    remainingValueUsd - (usdPerHour * Math.max(0, reset - observed)) / HOUR,
  );
  const endAt = Math.min(exhaustion ?? reset, reset);
  const start = Date.parse(forecast.first.observedAt);
  return {
    observedAt: forecast.latest.observedAt,
    costUsd,
    hours,
    usdPerHour,
    remainingValueUsd,
    fullCycleValueUsd:
      forecast.latest.remainingPercent > 0
        ? remainingValueUsd / (forecast.latest.remainingPercent / 100)
        : null,
    remainingAtResetUsd,
    exhaustionAt:
      exhaustion !== null && exhaustion - observed < 100_000 * 24 * HOUR
        ? new Date(exhaustion).toISOString()
        : null,
    exhaustionInMs: exhaustion === null ? null : Math.max(0, exhaustion - now),
    exhaustsBeforeReset: exhaustion !== null && exhaustion < reset,
    projectionEndX: Math.max(0, Math.min(1, (endAt - start) / Math.max(reset - start, 1))),
    projectionEndPercent:
      remainingValueUsd > 0
        ? (forecast.latest.remainingPercent * remainingAtResetUsd) / remainingValueUsd
        : 0,
    provisional,
    sourceSince,
    sourceUntil,
  };
}
