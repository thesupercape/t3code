import type { HourlyModelTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import { formatHourShort, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";

const WIDTH = 960;
const HEIGHT = 190;
const COLORS = { astra: "#f59e0b", sol: "#06b6d4", luna: "#8b5cf6", terra: "#10b981" } as const;
const FALLBACK = ["#f43f5e", "#64748b", "#ec4899", "#84cc16"];

export function modelDisplayName(key: string, value: HourlyModelTotals | undefined): string {
  const model = value?.model ?? (key.includes(":") ? key.slice(key.indexOf(":") + 1) : key);
  const provider =
    value?.provider ?? (key.includes(":") ? key.slice(0, key.indexOf(":")) : undefined);
  const lower = model.toLowerCase();
  const friendly = /(?:^|[-_.])astra(?:$|[-_.])/i.test(lower)
    ? "Astra"
    : /(?:^|[-_.])sol(?:$|[-_.])/i.test(lower)
      ? "Sol"
      : /(?:^|[-_.])luna(?:$|[-_.])/i.test(lower)
        ? "Luna"
        : /(?:^|[-_.])terra(?:$|[-_.])/i.test(lower)
          ? "Terra"
          : model;
  return provider === undefined ? friendly : `${provider} · ${friendly}`;
}

function colorFor(key: string, value: HourlyModelTotals | undefined): string {
  const lower = (value?.model ?? key).toLowerCase();
  for (const name of Object.keys(COLORS) as (keyof typeof COLORS)[])
    if (lower.includes(name)) return COLORS[name];
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.codePointAt(0)!) | 0;
  return FALLBACK[Math.abs(hash) % FALLBACK.length] ?? FALLBACK[0]!;
}

export function collectHourlyModelKeys(hours: readonly HourlyTotals[]): readonly string[] {
  return [...new Set(hours.flatMap((hour) => [...hour.byModel.keys()]))].sort();
}

export function UsageModelHourlyChart({
  hours,
  hourly,
  timeZone,
}: {
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly timeZone: string;
}) {
  const byHour = useMemo(() => new Map(hourly.map((entry) => [entry.hourStart, entry])), [hourly]);
  const modelKeys = useMemo(() => collectHourlyModelKeys(hourly), [hourly]);
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, hours.length - 1));
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const modelMetadata = useMemo(
    () => new Map(hourly.flatMap((entry) => [...entry.byModel.entries()])),
    [hourly],
  );
  const max = Math.max(
    0,
    ...hours.map((start) =>
      [...(byHour.get(start)?.byModel.values() ?? [])].reduce(
        (sum, value) => sum + value.totalTokens,
        0,
      ),
    ),
  );
  const selectedHour = hours[selectedIndex];
  const selectedModels = selectedHour === undefined ? undefined : byHour.get(selectedHour)?.byModel;
  const selectPoint = (index: number, key: string) => {
    setSelectedIndex((current) => (current === index ? current : index));
    setSelectedModelKey((current) => (current === key ? current : key));
  };
  if (hours.length === 0 || modelKeys.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No model token records in this 24 hour window.
      </p>
    );
  const barWidth = Math.max(8, Math.min(30, WIDTH / Math.max(hours.length, 1) - 2));
  const chartPadding = barWidth / 2 + 1;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Processed tokens by model. Totals include cached input; dollar values are estimated where
        pricing is available.
      </p>
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
        aria-label="Model legend"
      >
        {modelKeys.map((key) => {
          const value = modelMetadata.get(key);
          return (
            <span key={key} className="inline-flex max-w-full items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: colorFor(key, value) }}
              />
              <span className="truncate" title={key}>
                {modelDisplayName(key, value)}
              </span>
            </span>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 gap-2">
          <span className="w-12 shrink-0 self-start pt-1 text-right text-[10px] text-muted-foreground tabular-nums">
            {formatTokens(max)}
          </span>
          <svg
            className="h-44 min-w-0 flex-1"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Hourly processed tokens by model"
          >
            <line x1="0" x2={WIDTH} y1="0" y2="0" stroke="currentColor" className="text-border" />
            <line
              x1="0"
              x2={WIDTH}
              y1={HEIGHT}
              y2={HEIGHT}
              stroke="currentColor"
              className="text-border"
            />
            {hours.map((start, index) => {
              const entry = byHour.get(start);
              const x =
                hours.length === 1
                  ? WIDTH / 2
                  : chartPadding + (index / (hours.length - 1)) * (WIDTH - chartPadding * 2);
              let y = HEIGHT;
              return (
                <g key={start}>
                  {modelKeys.map((key) => {
                    const value = entry?.byModel.get(key);
                    const height = max === 0 ? 0 : ((value?.totalTokens ?? 0) / max) * (HEIGHT - 8);
                    y -= height;
                    return (
                      <rect
                        key={key}
                        x={x - barWidth / 2}
                        y={y}
                        width={barWidth}
                        height={height}
                        rx={2}
                        fill={colorFor(key, value)}
                        opacity={
                          index === selectedIndex &&
                          (selectedModelKey === null || selectedModelKey === key)
                            ? 1
                            : 0.72
                        }
                        stroke={
                          index === selectedIndex && selectedModelKey === key
                            ? "currentColor"
                            : undefined
                        }
                        strokeWidth={
                          index === selectedIndex && selectedModelKey === key ? 2 : undefined
                        }
                        tabIndex={height > 0 ? 0 : -1}
                        role="button"
                        aria-label={`${formatHourShort(start, timeZone)} ${modelDisplayName(key, value)}`}
                        onMouseEnter={() => selectPoint(index, key)}
                        onFocus={() => selectPoint(index, key)}
                        onClick={() => selectPoint(index, key)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectPoint(index, key);
                          }
                        }}
                      >
                        <title>
                          {formatHourShort(start, timeZone)} · {modelDisplayName(key, value)}:{" "}
                          {formatTokens(value?.totalTokens ?? 0)} tokens ·{" "}
                          {formatUsd(value?.costUsd ?? 0)}
                        </title>
                      </rect>
                    );
                  })}
                  <line
                    x1={x}
                    x2={x}
                    y1="0"
                    y2={HEIGHT}
                    stroke="currentColor"
                    strokeOpacity={index === selectedIndex ? 0.35 : 0}
                  />
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex justify-between pl-14 text-[10px] text-muted-foreground">
          <span>{formatHourShort(hours[0]!, timeZone)}</span>
          <span>{formatHourShort(hours[Math.floor(hours.length / 2)]!, timeZone)}</span>
          <span>{formatHourShort(hours.at(-1)!, timeZone)}</span>
        </div>
      </div>
      <div className="min-h-12">
        {selectedModelKey !== null &&
        selectedHour !== undefined &&
        selectedModels?.get(selectedModelKey) ? (
          <div role="tooltip" className="rounded-lg border border-border/70 px-3 py-2 text-xs">
            <div className="text-muted-foreground">
              {formatHourShort(selectedHour, timeZone)} ·{" "}
              {modelDisplayName(selectedModelKey, selectedModels.get(selectedModelKey))}
            </div>
            <div className="mt-1 tabular-nums">
              {formatTokens(selectedModels.get(selectedModelKey)!.totalTokens)} tokens ·{" "}
              {formatUsd(selectedModels.get(selectedModelKey)!.costUsd)}
            </div>
          </div>
        ) : null}
      </div>
      <label className="flex w-full flex-col gap-1 text-[11px] text-muted-foreground">
        Inspect hour
        <select
          aria-label="Inspect hourly model usage"
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
          value={selectedIndex}
          onChange={(event) => {
            setSelectedIndex(Number(event.target.value));
            setSelectedModelKey(null);
          }}
        >
          {hours.map((start, index) => (
            <option key={start} value={index}>
              {formatHourShort(start, timeZone)}
            </option>
          ))}
        </select>
      </label>
      <div
        className="rounded-lg border border-border/70 px-3 py-2 text-xs"
        aria-label="Usage for selected hour"
      >
        <div className="mb-1 text-muted-foreground">
          {selectedHour === undefined ? "Select an hour" : formatHourShort(selectedHour, timeZone)}
        </div>
        {modelKeys.every((key) => {
          const value = selectedModels?.get(key);
          return value === undefined || (value.totalTokens === 0 && value.costUsd === 0);
        }) ? (
          <p className="text-muted-foreground">No model usage recorded for this hour.</p>
        ) : (
          modelKeys.map((key) => {
            const value = selectedModels?.get(key);
            if (value === undefined || (value.totalTokens === 0 && value.costUsd === 0))
              return null;
            return (
              <div
                key={key}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
              >
                <span className="truncate" title={key}>
                  {modelDisplayName(key, value)}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatTokens(value.totalTokens)} tokens · {formatUsd(value.costUsd)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
