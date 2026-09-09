import type { UsageQuotaSample } from "@t3tools/contracts";
import {
  currentResetAnnouncement,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import { quotaDuration, quotaForecast } from "@t3tools/shared/usageQuotaForecast";
import {
  apiCostPace,
  type ApiPaceInput,
  type ManualResetSummary,
  type PriorApiPaceInput,
} from "./usageApiPace";
import { UsageRunwayPlanner } from "./UsageRunwayPlanner";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { useEffect, useMemo, useState, type ReactNode } from "react";

const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

export function UsagePaceChart({
  samples,
  news,
  resetCheck,
  apiPace = null,
  priorApiPace = null,
  manualResets = null,
}: {
  readonly samples: readonly UsageQuotaSample[];
  readonly news?: ResetNews;
  readonly resetCheck?: ReactNode;
  readonly apiPace?: ApiPaceInput | null;
  readonly priorApiPace?: PriorApiPaceInput | null;
  readonly manualResets?: ManualResetSummary | null;
}) {
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<"forecast" | "observed">("forecast");
  const [showApiPace, setShowApiPace] = useState(true);
  const [inspected, setInspected] = useState<number | null>(null);
  const [pointerX, setPointerX] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), [samples]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const announced = currentResetAnnouncement(news, samples.at(-1), now);
  const forecast = useMemo(
    () => quotaForecast(samples, now, 3, announced?.targetAt),
    [samples, now, announced],
  );
  if (!forecast) return null;
  const f = forecast;
  const costPace = apiCostPace(f, apiPace, now, priorApiPace);
  const observed = view === "observed";
  const y = (percent: number) => 196 - percent * 1.92;
  const pointX = (p: (typeof f.points)[number]) =>
    observed
      ? (Date.parse(p.observedAt) - Date.parse(f.first.observedAt)) /
        Math.max(Date.parse(f.latest.observedAt) - Date.parse(f.first.observedAt), 1)
      : p.x;
  const path = f.points
    .map((p) => `${p.breakBefore ? "M" : "L"}${pointX(p) * 960},${y(p.remainingPercent)}`)
    .join(" ");
  const ending = observed ? f.latest.observedAt : f.planningResetAt;
  const inspectedPoint = f.points[Math.min(inspected ?? f.points.length - 1, f.points.length - 1)]!;
  const futureFraction =
    pointerX !== null && !observed && pointerX > f.observationX ? pointerX : null;
  const futureAt =
    futureFraction === null
      ? null
      : new Date(
          Date.parse(f.first.observedAt) +
            futureFraction * (Date.parse(f.planningResetAt) - Date.parse(f.first.observedAt)),
        ).toISOString();
  const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
  const targetAtFuture =
    futureFraction === null
      ? null
      : clampPercent(
          f.latest.remainingPercent +
            (f.reserve - f.latest.remainingPercent) *
              ((futureFraction - f.observationX) / Math.max(1 - f.observationX, 1e-9)),
        );
  const blendedAtFuture =
    futureFraction === null
      ? null
      : clampPercent(
          f.latest.remainingPercent +
            (f.projectionEndPercent - f.latest.remainingPercent) *
              ((futureFraction - f.observationX) /
                Math.max(f.projectionEndX - f.observationX, 1e-9)),
        );
  const apiAtFuture =
    futureFraction === null || !showApiPace || !costPace
      ? null
      : clampPercent(
          f.latest.remainingPercent +
            (costPace.projectionEndPercent - f.latest.remainingPercent) *
              ((futureFraction - f.observationX) /
                Math.max(costPace.projectionEndX - f.observationX, 1e-9)),
        );
  const hourly = f.resetInMs < 86_400_000;
  return (
    <section
      aria-label="Current Codex usage"
      className="min-w-0 rounded-xl border border-border bg-card/20 p-4 sm:p-5"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Current weekly limit</span>
        <span role="status" className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${f.stale ? "bg-amber-500" : "bg-emerald-500"}`}
          />
          {f.stale ? "Reading is stale" : `Updated ${time(f.latest.observedAt)}`}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-4xl font-medium tracking-tight tabular-nums">
            {f.latest.remainingPercent}%
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            remaining{f.stale ? " at last reading" : ""}
          </p>
        </div>
        <div className="hidden sm:block pb-1">
          <p className="text-xs text-muted-foreground">
            {f.usesAnnouncement ? "Announced reset in" : "Weekly reset in"}
          </p>
          <p className="mt-1 text-xl font-medium tabular-nums">{quotaDuration(f.resetInMs)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{date(f.planningResetAt)}</p>
        </div>
        <div className="pb-1 text-right">
          <p className="text-2xl tabular-nums">{f.usedPercent}%</p>
          <p className="mt-1 text-sm text-muted-foreground">used this cycle</p>
        </div>
      </div>
      <div className="mt-4 flex h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="bg-primary" style={{ width: `${f.latest.remainingPercent}%` }} />
      </div>
      {f.stale ? (
        <p role="alert" className="mt-4 border-l-2 border-amber-500 pl-3 text-sm">
          No fresh reading. Check the background collector. Forecasts below use the last saved
          reading.
        </p>
      ) : null}
      {f.historicalPace ? (
        <p role="status" className="mt-3 border-l-2 border-sky-500 pl-3 text-sm">
          Provisional pace uses the completed cycle from {date(f.historicalPace.since)} through{" "}
          {date(f.historicalPace.until)} while this cycle warms. Fresh current-cycle readings
          replace it automatically.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Usage over time</h2>
        <div className="flex rounded-lg bg-muted p-1" role="group" aria-label="Chart view">
          {(
            [
              ["observed", "Recorded"],
              ["forecast", "To reset"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={`min-h-11 rounded-md px-3 text-xs focus-visible:outline-2 focus-visible:outline-ring ${view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 flex gap-2">
        <div aria-hidden className="relative h-48 w-9 shrink-0 text-xs text-muted-foreground">
          {[100, 50, 0].map((p) => (
            <span
              key={p}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${2 + (100 - p) * 0.96}%` }}
            >
              {p}%
            </span>
          ))}
        </div>
        <div className="relative h-48 min-w-0 flex-1">
          <svg
            viewBox="0 0 960 200"
            preserveAspectRatio="none"
            className="h-full w-full overflow-visible"
            role="img"
            tabIndex={0}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
              setPointerX(fraction);
              const nearest = f.points.reduce(
                (best, point, index) =>
                  Math.abs(pointX(point) - fraction) < Math.abs(pointX(f.points[best]!) - fraction)
                    ? index
                    : best,
                0,
              );
              setInspected(nearest);
            }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
              setPointerX(fraction);
              const nearest = f.points.reduce(
                (best, point, index) =>
                  Math.abs(pointX(point) - fraction) < Math.abs(pointX(f.points[best]!) - fraction)
                    ? index
                    : best,
                0,
              );
              setInspected(nearest);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setPointerX(null);
              const delta = event.key === "ArrowLeft" ? -1 : 1;
              setInspected((current) =>
                Math.max(
                  0,
                  Math.min(f.points.length - 1, (current ?? f.points.length - 1) + delta),
                ),
              );
            }}
            aria-label={
              observed
                ? "Recorded Codex remaining usage"
                : "Codex remaining usage and pace to next reset"
            }
          >
            <desc>
              Solid: saved readings. Dashed: target pace. Orange: blended projection.
              {showApiPace && costPace && !observed ? " Cyan: API cost projection." : ""}
              {" Gaps are not joined."}
            </desc>
            {[4, 100, 196].map((lineY) => (
              <line
                key={lineY}
                x1={0}
                x2={960}
                y1={lineY}
                y2={lineY}
                stroke="currentColor"
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {!observed ? (
              <>
                <line
                  x1={f.observationX * 960}
                  y1={y(f.latest.remainingPercent)}
                  x2={960}
                  y2={y(f.reserve)}
                  stroke="currentColor"
                  className="text-muted-foreground"
                  strokeDasharray="4 5"
                  vectorEffect="non-scaling-stroke"
                />
                {showApiPace && costPace ? (
                  <path
                    aria-label="API cost projection"
                    d={`M${f.observationX * 960},${y(f.latest.remainingPercent)} L${costPace.projectionEndX * 960},${y(costPace.projectionEndPercent)} L960,${y(costPace.projectionEndPercent)}`}
                    fill="none"
                    stroke="#52b8bf"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                <line
                  x1={f.observationX * 960}
                  y1={y(f.latest.remainingPercent)}
                  x2={f.projectionEndX * 960}
                  y2={y(f.projectionEndPercent)}
                  stroke="#d88d42"
                  strokeWidth={2}
                  strokeDasharray="7 4"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null}
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span
            role="status"
            className="pointer-events-none absolute left-2 top-2 rounded bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm"
          >
            {futureAt
              ? `Projection ${date(futureAt)} · target ${targetAtFuture!.toFixed(0)}% · blended ${blendedAtFuture!.toFixed(0)}%${apiAtFuture === null ? "" : ` · API ${apiAtFuture.toFixed(0)}%`}`
              : `Recorded ${date(inspectedPoint.observedAt)} · ${inspectedPoint.remainingPercent}% remaining`}
          </span>
          <span
            aria-hidden
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
            style={{
              left: `${observed ? (f.points.length > 1 ? 100 : 0) : f.observationX * 100}%`,
              top: `${2 + (100 - f.latest.remainingPercent) * 0.96}%`,
            }}
          />
        </div>
      </div>
      <div className="ml-11 mt-2 flex justify-between gap-3 text-xs text-muted-foreground">
        <span>{time(f.first.observedAt)}</span>
        <span className="text-right">{observed ? time(ending) : date(ending)}</span>
      </div>
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="min-h-9 cursor-pointer content-center">
          Inspect recorded readings
        </summary>
        <div className="flex flex-wrap items-center gap-3 pb-3">
          <input
            type="range"
            aria-label="Inspect recorded usage"
            className="min-w-32 flex-1 accent-current"
            min={0}
            max={Math.max(0, f.points.length - 1)}
            value={Math.min(inspected ?? f.points.length - 1, f.points.length - 1)}
            onChange={(event) => setInspected(Number(event.target.value))}
          />
          <output className="font-mono tabular-nums">
            {date(inspectedPoint.observedAt)} · {inspectedPoint.remainingPercent}% remaining
          </output>
        </div>
      </details>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <span>━━ Recorded</span>
        {!observed ? (
          <>
            <span className="text-muted-foreground">┄┄ Target</span>
            <span style={{ color: "#d88d42" }}>┄┄ Blended pace</span>
          </>
        ) : null}
      </div>
      {!observed ? (
        <div className="mt-2">
          <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              aria-label="Show API cost pace"
              className="size-4 accent-[#52b8bf]"
              checked={showApiPace}
              onChange={(event) => setShowApiPace(event.target.checked)}
            />
            <span style={{ color: "#52b8bf" }}>┄ API cost pace</span>
          </label>
          {showApiPace ? (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              {costPace
                ? `${costPace.provisional ? "Provisional: " : ""}${formatUsd(costPace.usdPerHour)}/hour ${costPace.provisional ? `over its ${costPace.hours.toFixed(1)}-hour source interval` : `over the last ${costPace.hours.toFixed(1)} hours`}, including idle time. ${formatUsd(costPace.remainingValueUsd)} estimated at the last reading.${costPace.provisional ? ` Source cycle: ${date(costPace.sourceSince)} to ${date(costPace.sourceUntil)}.` : ""} ${costPace.exhaustionInMs === null ? "No spending in this interval; no exhaustion time projected." : costPace.exhaustsBeforeReset ? `Empty in ${quotaDuration(costPace.exhaustionInMs)} if this spending rate continues.` : `About ${formatUsd(costPace.remainingAtResetUsd)} left at reset.`}`
                : f.historicalPace
                  ? `Current API burn is warming. The chart's orange pace uses the completed cycle from ${date(f.historicalPace.since)} through ${date(f.historicalPace.until)} as a provisional baseline.`
                  : f.stale
                    ? "API cost pace needs a fresh account reading."
                    : "API cost pace needs at least an hour of monitored history and complete, priced costs for the same interval and remaining balance."}
            </p>
          ) : null}
        </div>
      ) : null}
      {showApiPace && !observed && costPace ? (
        <dl className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-border p-4">
          <div>
            <dt className="text-xs text-muted-foreground">API spending rate</dt>
            <dd className="mt-1 font-mono text-lg">{formatUsd(costPace.usdPerHour)} / hour</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">API value runs out</dt>
            <dd className="mt-1 text-sm">
              {costPace.exhaustionAt ? date(costPace.exhaustionAt) : "No spending recorded"}
            </dd>
          </div>
        </dl>
      ) : null}
      {!observed ? (
        <UsageRunwayPlanner
          pace={costPace}
          scheduledResetAt={f.latest.resetsAt}
          manualResets={manualResets}
          now={now}
        />
      ) : null}
      <dl className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-x-5 gap-y-5 border-t border-border pt-5 [&>div]:min-w-0">
        <div>
          <dt className="text-xs text-muted-foreground">
            {f.stale ? "Last run-out estimate" : "Blended quota pace"}
          </dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {f.exhaustsBeforeReset
              ? f.exhaustionInMs === null
                ? "No burn recorded"
                : `${quotaDuration(f.exhaustionInMs)} to empty`
              : `${f.remainingAtReset.toFixed(0)}% left at reset`}
          </dd>
          <dd className="mt-1 text-xs text-muted-foreground">
            {f.exhaustsBeforeReset ? "Runs out before reset" : "Reset comes first"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Pace to reset</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {(hourly ? f.recommendedPercentPerDay / 24 : f.recommendedPercentPerDay).toFixed(1)}% /{" "}
            {hourly ? "hour" : "day"}
          </dd>
          <dd className="mt-1 text-xs text-muted-foreground">To leave {f.reserve}% unused</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Blended burn</dt>
          <dd className="mt-1 tabular-nums">{(f.expectedPercentPerDay / 24).toFixed(2)}% / hour</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Quota runs out</dt>
          <dd className="mt-1 text-sm">
            {f.exhaustionAt ? date(f.exhaustionAt) : "No burn recorded"}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        The monitor captured a {f.monitoredUsedPercent}-point drop since {date(f.first.observedAt)}.
        {f.usedBeforeMonitoring > 0
          ? ` You had already used ${f.usedBeforeMonitoring}% when it started.`
          : " It started at 100%."}
      </p>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Orange blends monitored usage with the weekly average. Blue spends the estimated remaining
        API value at the average dollar rate from the last six hours, or since monitoring began if
        newer. Its height uses the same remaining-percentage scale. It includes idle time and stops
        at zero. Model changes can affect Codex allowance differently, so this remains an estimate.
      </p>
      <div className="mt-6 border-y border-border py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-medium">
            {f.usesAnnouncement ? "Announced reset" : "Weekly reset"}
          </h2>
          <span className="text-lg font-medium tabular-nums">
            {quotaDuration(f.resetInMs)} left
          </span>
        </div>
        <p className="mt-1 text-sm">{date(f.planningResetAt)}</p>
        {announced ? (
          <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {f.usesAnnouncement
              ? "Planning uses the earlier announced time. "
              : "Announced time passed. Waiting for an account reading to confirm a reset. "}
            <a
              className="underline underline-offset-4"
              href={announced.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Tibo's post
            </a>
            {" via "}
            <a
              className="underline underline-offset-4"
              href="https://resetbeacon.com/"
              target="_blank"
              rel="noreferrer"
            >
              Reset Beacon
            </a>
            .
            <details className="mt-1">
              <summary className="min-h-11 cursor-pointer content-center">
                Source and weekly timer
              </summary>
              <p className="pb-2">
                {announced.quote} The feed interprets Pacific local time. Announcement timing is not
                account confirmation.
              </p>
              <p>Account weekly timer: {date(f.latest.resetsAt)}.</p>
            </details>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {news?.status === "loading"
              ? "Checking reset announcements…"
              : news?.status === "unavailable"
                ? "Reset news unavailable. Using your account's weekly timer."
                : "No earlier reset announcement available."}
          </p>
        )}
      </div>

      {resetCheck}
    </section>
  );
}
