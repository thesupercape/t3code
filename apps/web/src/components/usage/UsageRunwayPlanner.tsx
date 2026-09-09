import { QUOTA_STALE_MS, quotaDuration } from "@t3tools/shared/usageQuotaForecast";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  DEFAULT_NO_USAGE_TOLERANCE_HOURS,
  manualResetScenario,
  usageRunwayPlan,
  type ApiCostPace,
  type ManualResetSummary,
} from "./usageApiPace";
import { useMemo, useState } from "react";

const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

export function UsageRunwayPlanner({
  pace,
  scheduledResetAt,
  manualResets,
  now = Date.now(),
}: {
  readonly pace: ApiCostPace | null;
  /** The account timer, kept separate from any public announcement. */
  readonly scheduledResetAt: string;
  readonly manualResets?: ManualResetSummary | null;
  readonly now?: number;
}) {
  const [toleranceHours, setToleranceHours] = useState(DEFAULT_NO_USAGE_TOLERANCE_HOURS);
  const plan = useMemo(
    () => usageRunwayPlan(pace, scheduledResetAt, now, toleranceHours),
    [pace, scheduledResetAt, now, toleranceHours],
  );

  return (
    <section
      aria-label="Usage runway planner"
      className="mt-4 rounded-lg border border-border bg-card/20 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Runway plan</p>
          <h2 className="mt-1 text-base font-medium">Time without usage at this burn</h2>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <span className="text-muted-foreground">Maximum time without usage</span>
          <select
            aria-label="Maximum time without usage"
            className="min-h-11 rounded-md border border-border bg-background px-2 tabular-nums"
            value={toleranceHours}
            onChange={(event) => setToleranceHours(Number(event.target.value))}
          >
            {[0, 6, 12, 18, 24, 36, 48].map((hours) => (
              <option key={hours} value={hours}>
                {hours}h
              </option>
            ))}
          </select>
        </label>
      </div>

      {plan === null ? (
        <p role="status" className="mt-4 border-l-2 border-amber-500 pl-3 text-sm">
          Waiting for a fresh, fully priced API-cost reading. The planner will not invent a burn
          rate from incomplete transcripts.
        </p>
      ) : (
        <>
          <div className="mt-4 rounded-md border border-border bg-background/50 p-3">
            <p className="text-xs text-muted-foreground">No usage before reset at current burn</p>
            <p className="mt-1 text-3xl font-medium tabular-nums">
              {plan.noUsageHours === null
                ? "Unknown"
                : plan.noUsageHours > 0
                  ? quotaDuration(plan.noUsageMs!)
                  : "None"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {plan.noUsageHours === null
                ? "No spending rate is recorded for this window."
                : plan.noUsageHours <= plan.toleranceHours
                  ? plan.noUsageHours > 0
                    ? `Within your ${plan.toleranceHours}h maximum gap.`
                    : "Your allowance lasts through the scheduled reset at this rate."
                  : `About ${(plan.noUsageHours - plan.toleranceHours).toFixed(1)}h beyond your maximum gap.`}
            </p>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Current API burn</dt>
              <dd className="mt-1 text-lg tabular-nums">
                {formatUsd(plan.measuredUsdPerHour)} / hour
              </dd>
              <dd className="mt-1 text-xs text-muted-foreground">
                Measured {pace ? pace.hours.toFixed(1) : "—"}h, including idle time
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Max burn for this gap</dt>
              <dd className="mt-1 text-lg tabular-nums">
                {plan.targetUsdPerHour === null
                  ? "No cap needed before reset"
                  : `${formatUsd(plan.targetUsdPerHour)} / hour`}
              </dd>
              <dd className="mt-1 text-xs text-muted-foreground">
                {plan.targetAt
                  ? `Earliest acceptable empty: ${date(plan.targetAt)}`
                  : "Reset is within your tolerated gap"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Estimated empty</dt>
              <dd className="mt-1 text-lg tabular-nums">
                {plan.exhaustionAt ? date(plan.exhaustionAt) : "No exhaustion projected"}
              </dd>
              <dd className="mt-1 text-xs text-muted-foreground">
                Scheduled reset: {date(plan.scheduledResetAt)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            The maximum burn spends the current estimated API value by the selected deadline. A
            lower burn leaves usage available longer; a burst can move the actual empty time. The
            baseline uses the account's scheduled timer even when a public reset announcement is
            earlier.
          </p>
        </>
      )}

      {manualResets ? (
        <ManualResetCard
          pace={pace}
          manualResets={manualResets}
          estimatedEmptyAt={plan?.exhaustionAt ?? null}
          scheduledResetAt={scheduledResetAt}
          now={now}
        />
      ) : null}
    </section>
  );
}

function ManualResetCard({
  pace,
  manualResets,
  estimatedEmptyAt,
  scheduledResetAt,
  now,
}: {
  pace: ApiCostPace | null;
  manualResets: ManualResetSummary;
  estimatedEmptyAt: string | null;
  scheduledResetAt: string;
  now: number;
}) {
  const count = Math.max(0, Math.floor(manualResets.availableCount));
  const checkedAt = manualResets.checkedAt ? Date.parse(manualResets.checkedAt) : NaN;
  const fresh =
    manualResets.verified &&
    Number.isFinite(checkedAt) &&
    now - checkedAt >= 0 &&
    now - checkedAt <= QUOTA_STALE_MS;
  const emptyAt = estimatedEmptyAt ? Date.parse(estimatedEmptyAt) : NaN;
  const scenario = useMemo(
    () => manualResetScenario(pace, manualResets, now, scheduledResetAt),
    [pace, manualResets, now, scheduledResetAt],
  );
  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Banked manual resets</h3>
        <span className="text-lg tabular-nums">{count} available</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {fresh
          ? `Verified from the account snapshot${manualResets.checkedAt ? ` · checked ${date(manualResets.checkedAt)}` : ""}.`
          : manualResets.verified
            ? `Last account snapshot${manualResets.checkedAt ? ` was ${date(manualResets.checkedAt)}` : ""}; refresh before relying on the count.`
            : "Entered as an estimate; the account has not verified this count."}{" "}
        They are kept out of the baseline because redeeming one is a manual action that refreshes
        both the short and weekly windows and starts a new timer.
      </p>
      {manualResets.expiries?.length ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="min-h-9 cursor-pointer content-center">Show expiry dates</summary>
          <ul className="space-y-1 pb-2 pt-1">
            {manualResets.expiries.map((expiry) => {
              const at = Date.parse(expiry);
              const usableAt = Number.isFinite(emptyAt) ? emptyAt : now;
              const expiredBeforeEmpty = Number.isFinite(at) && at <= usableAt;
              return (
                <li key={expiry}>
                  {date(expiry)} ·{" "}
                  {expiredBeforeEmpty
                    ? "expires before estimated empty"
                    : "available at estimated empty"}
                </li>
              );
            })}
          </ul>
        </details>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Expiry dates are unavailable in this snapshot; confirm eligibility before redeeming.
        </p>
      )}
      {count > 0 ? (
        <div className="mt-3 rounded-md border border-border bg-background/40 p-3">
          <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Reset 1 when empty · conditional scenario
          </p>
          {scenario?.expiryAllowsUse === false ? (
            <p role="alert" className="mt-2 text-sm">
              The first credit expires before the estimated empty time, so this scenario is not
              currently usable.
            </p>
          ) : scenario ? (
            <>
              <p className="mt-2 text-sm leading-relaxed">
                A manual reset would leave {scenario.remainingCount} credit
                {scenario.remainingCount === 1 ? "" : "s"} and start a new approximately 7-day
                window ending {date(scenario.windowEndsAt)}.
              </p>
              <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Refilled API value</dt>
                  <dd className="mt-1 tabular-nums">
                    {scenario.fullCycleValueUsd === null
                      ? "Unavailable"
                      : `≈ ${formatUsd(scenario.fullCycleValueUsd)}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Next cycle at this burn</dt>
                  <dd className="mt-1 tabular-nums">
                    {scenario.fullCycleValueUsd === null
                      ? "Unknown"
                      : scenario.hoursAtBurn === null
                        ? "At least 7d"
                        : quotaDuration(scenario.hoursAtBurn * 3_600_000)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Next-cycle no usage</dt>
                  <dd className="mt-1 tabular-nums">
                    {scenario.noUsageMs === null ? "Unknown" : quotaDuration(scenario.noUsageMs)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {!fresh ? "The account snapshot may be stale, so treat this as conditional. " : ""}
                {scenario.expiryAllowsUse === null
                  ? "The credit's expiry is unavailable, so eligibility at empty is unconfirmed. "
                  : "The first credit is still within its supplied expiry. "}
                This is a projection at the same measured burn, not a promise of capacity; confirm
                the new weekly timer with the next account reading after redeeming.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              {!pace
                ? "A full-cycle value estimate is unavailable until the current usage is fully priced."
                : pace.usdPerHour <= 0
                  ? "No manual reset is projected because the current burn leaves usage available through the scheduled timer."
                  : "A manual reset is not needed before the scheduled timer at this burn."}
            </p>
          )}
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        If you redeem one after running out, wait for the next account reading before recalculating
        runway. The planner never redeems a reset or assumes a banked credit extends this timer.
      </p>
    </div>
  );
}
