import type { UsageQuotaSample } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { quotaHistoryPoints, type QuotaPeriod, type QuotaValue } from "@t3tools/shared/usageQuota";
import { useId, useMemo, useState } from "react";

export function UsageQuotaCharts({
  samples,
  values,
}: {
  readonly samples: readonly UsageQuotaSample[];
  readonly values: readonly { period: QuotaPeriod; value: QuotaValue }[];
}) {
  const points = useMemo(() => quotaHistoryPoints(samples), [samples]);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const id = useId();
  const selectedIndex = Math.max(
    0,
    selectedTime === null
      ? points.length - 1
      : points.findIndex((p) => p.observedAt === selectedTime),
  );
  const selected = points[selectedIndex];
  const path = points
    .map(
      (p) =>
        `${p.breakBefore ? "M" : "L"}${p.x * 960},${4 + (100 - p.remainingPercent) * 1.92}${p.breakBefore ? "l0,0" : ""}`,
    )
    .join(" ");
  const peak = Math.max(
    1,
    ...values.flatMap(({ value }) => [value.costUsd ?? 0, value.remainingValueUsd ?? 0]),
  );
  const day = (at: string) =>
    new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (!selected) return null;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <section aria-labelledby={`${id}-percentage`}>
        <h3 id={`${id}-percentage`} className="text-sm font-medium">
          Codex usage remaining over time
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Saved weekly quota, 0–100%. Gaps over an hour and reset changes are not joined.
        </p>
        <div className="mt-5 flex gap-2">
          <div
            className="relative h-52 w-10 shrink-0 text-xs text-muted-foreground tabular-nums"
            aria-hidden="true"
          >
            {[100, 50, 0].map((tick) => (
              <span
                key={tick}
                className="absolute right-0 -translate-y-1/2"
                style={{ top: `${2 + (100 - tick) * 0.96}%` }}
              >
                {tick}%
              </span>
            ))}
          </div>
          <div
            className="relative h-52 min-w-0 flex-1"
            onPointerDown={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - bounds.left) / bounds.width;
              const nearest = points.reduce(
                (best, p) => (Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best),
                selected,
              );
              setSelectedTime(nearest.observedAt);
            }}
          >
            <svg
              viewBox="0 0 960 200"
              preserveAspectRatio="none"
              className="h-full w-full overflow-visible"
              role="img"
              aria-label="Recorded Codex quota remaining over time"
            >
              <desc>
                Time increases from left to right. The vertical axis is remaining percentage, from
                zero to one hundred. Dashed vertical lines mark observed reset changes. Use the
                observation slider for exact readings.
              </desc>
              {[4, 100, 196].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="960"
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {points
                .filter((p) => p.resetChange)
                .map((p) => (
                  <line
                    key={p.observedAt}
                    x1={p.x * 960}
                    x2={p.x * 960}
                    y1="4"
                    y2="196"
                    stroke="currentColor"
                    strokeDasharray="3 4"
                    className="text-muted-foreground"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={selected.x * 960}
                x2={selected.x * 960}
                y1="4"
                y2="196"
                stroke="currentColor"
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
              style={{
                left: `${selected.x * 100}%`,
                top: `${2 + (100 - selected.remainingPercent) * 0.96}%`,
              }}
            />
          </div>
        </div>
        <div className="mt-2 flex justify-between gap-3 pl-12 text-xs text-muted-foreground">
          <span>{day(points[0]!.observedAt)}</span>
          <span>{day(points.at(-1)!.observedAt)}</span>
        </div>
        <label className="mt-4 block text-sm">
          Observation
          <input
            className="block min-h-11 w-full accent-foreground"
            type="range"
            min="0"
            max={points.length - 1}
            value={selectedIndex}
            disabled={points.length === 1}
            aria-valuetext={`${new Date(selected.observedAt).toLocaleString()}, ${selected.remainingPercent}% remaining`}
            onInput={(event) =>
              setSelectedTime(points[Number(event.currentTarget.value)]!.observedAt)
            }
          />
        </label>
        <div className="flex flex-wrap justify-between gap-2">
          <button
            type="button"
            className="min-h-11 rounded-md px-2 text-sm hover:bg-accent disabled:opacity-40"
            disabled={selectedIndex === 0}
            onClick={() => setSelectedTime(points[selectedIndex - 1]!.observedAt)}
          >
            Previous reading
          </button>
          <button
            type="button"
            className="min-h-11 rounded-md px-2 text-sm hover:bg-accent disabled:opacity-40"
            disabled={selectedIndex === points.length - 1}
            onClick={() => setSelectedTime(points[selectedIndex + 1]!.observedAt)}
          >
            Next reading
          </button>
        </div>
        <p className="min-h-10 text-sm tabular-nums" aria-live="polite">
          {new Date(selected.observedAt).toLocaleString()} ·{" "}
          <strong className="font-medium">{selected.remainingPercent}% remaining</strong>
          {selected.resetChange ? " · Reset change observed" : ""}
        </p>
      </section>
      <section aria-labelledby={`${id}-value`}>
        <h3 id={`${id}-value`} className="text-sm font-medium">
          API-equivalent value by period
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Matched usage and estimated value left at each period's last reading. Bars share one
          dollar scale.
        </p>
        <div className="mt-4 flex flex-col gap-5">
          {values.toReversed().map(({ period, value }) => (
            <div key={period.id} className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {day(period.first.observedAt)} to {day(period.last.observedAt)}
              </p>
              {value.cachedAt ? (
                <p className="text-xs text-muted-foreground">
                  Last complete calculation: {new Date(value.cachedAt).toLocaleString()}. Updates
                  pending.
                </p>
              ) : null}
              {[
                { label: "Matched usage", amount: value.costUsd, muted: false },
                { label: "Estimated left", amount: value.remainingValueUsd, muted: true },
              ].map((row) => (
                <div key={row.label}>
                  <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-sm">
                    <span>{row.label}</span>
                    <span className="tabular-nums">
                      {row.amount === null
                        ? "Unavailable"
                        : `${row.muted ? "≈ " : ""}${formatUsd(row.amount)}`}
                    </span>
                  </div>
                  {row.amount !== null ? (
                    <div className="h-2 bg-muted" aria-hidden="true">
                      <div
                        className={`h-full bg-foreground ${row.muted ? "opacity-40" : ""}`}
                        style={{ width: `${(row.amount / peak) * 100}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
              {value.remainingValueUsd === null && value.reason ? (
                <p className="text-xs text-muted-foreground">{value.reason}</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
