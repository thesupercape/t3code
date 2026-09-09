import { useState } from "react";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  formatTokens,
  monitoredModels,
  TOKEN_PRICES,
  TOKEN_PRICE_SOURCE,
  tokenBudget,
  tokenCount,
} from "./usageTokenBudget";

export function TokenBudgetPanel({
  budgetUsd,
  models,
  observedAt,
  provisional = false,
  calibration,
  priorModelMix = false,
  currentPrefixThrough,
}: {
  readonly budgetUsd: number | null;
  readonly models: ReturnType<typeof monitoredModels>;
  readonly observedAt: string;
  readonly provisional?: boolean;
  readonly calibration?: { readonly since: string; readonly until: string };
  readonly priorModelMix?: boolean;
  readonly currentPrefixThrough?: string;
}) {
  const [scenario, setScenario] = useState("observed");
  const [longContext, setLongContext] = useState(false);
  const [fast, setFast] = useState(false);
  const [outputShare, setOutputShare] = useState(10);
  const [cacheShare, setCacheShare] = useState(75);
  const totals = models?.reduce(
    (sum, row) => ({
      input: sum.input + row.totals.uncachedInputTokens,
      cached: sum.cached + row.totals.cachedInputTokens,
      writes: sum.writes + row.totals.cacheCreationTokens,
      output: sum.output + row.totals.outputTokens,
    }),
    { input: 0, cached: 0, writes: 0, output: 0 },
  );
  const total = totals ? Object.values(totals).reduce((a, b) => a + b, 0) : 0;
  const observedMix =
    totals && total > 0
      ? {
          input: totals.input / total,
          cached: totals.cached / total,
          writes: totals.writes / total,
          output: totals.output / total,
        }
      : null;
  const mix =
    scenario === "custom"
      ? {
          input: (1 - outputShare / 100) * (1 - cacheShare / 100),
          cached: ((1 - outputShare / 100) * cacheShare) / 100,
          writes: 0,
          output: outputShare / 100,
        }
      : scenario === "observed"
        ? observedMix
        : scenario === "output"
          ? { input: 0, cached: 0, writes: 0, output: 1 }
          : scenario === "input"
            ? { input: 1, cached: 0, writes: 0, output: 0 }
            : { input: 0.2, cached: 0.7, writes: 0, output: 0.1 };
  return (
    <section
      aria-label="Remaining token estimates"
      className="min-w-0 rounded-xl border border-border bg-card/30"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-medium">How far could the rest go?</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {currentPrefixThrough
              ? `Provisional current-cycle value through ${new Date(currentPrefixThrough).toLocaleString()}.`
              : provisional
                ? "Provisional value from the previous completed cycle."
                : "Spend the same estimated API value on a different model."}
          </p>
          {provisional && calibration ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Calibration: {new Date(calibration.since).toLocaleString()} to{" "}
              {new Date(calibration.until).toLocaleString()}.
            </p>
          ) : null}
        </div>
        <span className="font-mono text-lg tabular-nums">
          {budgetUsd === null ? "Learning" : `≈ ${formatUsd(budgetUsd)}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 text-xs">
        <label className="flex items-center gap-2">
          Token mix
          <select
            aria-label="Token mix"
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="observed">
              {priorModelMix ? "Previous cycle mix" : "This cycle's mix"}
            </option>
            <option value="coding">Example: cached coding</option>
            <option value="custom">Custom mix</option>
            <option value="output">Output only</option>
            <option value="input">Uncached input only</option>
          </select>
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input
            type="checkbox"
            checked={longContext}
            onChange={(event) => setLongContext(event.target.checked)}
          />
          Over 272K input / request
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input
            type="checkbox"
            checked={fast}
            onChange={(event) => setFast(event.target.checked)}
          />
          Fast mode
        </label>
      </div>
      {scenario === "custom" ? (
        <div className="grid gap-4 border-t border-border px-5 py-4 sm:grid-cols-2">
          <label className="text-xs text-muted-foreground">
            Output share · {outputShare}% of all tokens
            <input
              aria-label="Output share"
              type="range"
              min={0}
              max={100}
              value={outputShare}
              onChange={(event) => setOutputShare(Number(event.target.value))}
              className="mt-3 block w-full accent-current"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Cache hit rate · {cacheShare}% of input
            <input
              aria-label="Cache hit rate"
              type="range"
              min={0}
              max={100}
              value={cacheShare}
              onChange={(event) => setCacheShare(Number(event.target.value))}
              className="mt-3 block w-full accent-current"
            />
          </label>
        </div>
      ) : null}
      <div className="overflow-x-auto px-5">
        <table className="w-full min-w-[480px] text-left text-sm">
          <caption className="sr-only">Alternative token budgets at verified model prices</caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="pb-3 font-normal">Model</th>
              <th className="pb-3 text-right font-normal">Total tokens</th>
              <th className="pb-3 text-right font-normal">Input</th>
              <th className="pb-3 text-right font-normal">Output</th>
              <th className="pb-3 text-right font-normal">$/M blended</th>
            </tr>
          </thead>
          <tbody>
            {TOKEN_PRICES.map((price) => {
              const result = mix ? tokenBudget(budgetUsd, price, mix, longContext, fast) : null;
              return (
                <tr
                  key={price.model}
                  className="border-b border-border/60 last:border-0 hover:bg-muted/30"
                >
                  <th className="py-3 font-medium">
                    <span>{price.label}</span>
                    <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                      {price.model}
                    </span>
                  </th>
                  <td className="text-right font-mono text-base tabular-nums text-foreground">
                    {result ? `≈ ${formatTokens(result.total)}` : "Pending"}
                  </td>
                  <td className="text-right font-mono text-xs tabular-nums">
                    {result ? formatTokens(result.input) : "—"}
                  </td>
                  <td className="text-right font-mono text-xs tabular-nums">
                    {result ? formatTokens(result.output) : "—"}
                  </td>
                  <td className="text-right font-mono text-xs tabular-nums">
                    {result ? `$${result.perMillion.toFixed(4)}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        className="space-y-2 border-t border-border px-5 py-4 text-xs leading-relaxed text-muted-foreground"
        role="status"
      >
        <p>
          Based on the account reading at{" "}
          {new Date(observedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          . {fast ? "Fast" : "Standard"} processing, {longContext ? "over 272K" : "up to 272K"}{" "}
          input tokens per request.
        </p>
        {mix ? (
          <p>
            {(mix.input * 100).toFixed(1)}% uncached input · {(mix.cached * 100).toFixed(1)}% cached
            input · {(mix.writes * 100).toFixed(1)}% cache writes · {(mix.output * 100).toFixed(1)}%
            output, including reasoning.
          </p>
        ) : (
          <p>
            Exact model totals are not available yet. Refresh after the server finishes reading this
            cycle, or choose an example mix.
          </p>
        )}
        {budgetUsd === null ? (
          <p>
            Token estimates need a complete cost scan and at least five observed percentage points.
          </p>
        ) : null}
        <p>
          Each row is an alternative use of the whole estimate. Changing models can change Codex
          usage consumption, so these are API-price comparisons, not guaranteed Codex tokens. Tool
          fees and regional surcharges are excluded.
        </p>
        <a
          href={TOKEN_PRICE_SOURCE}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-8 items-center underline underline-offset-4"
        >
          OpenAI rates · verified Sep 5, 2026
        </a>
      </div>
      {models && models.length > 0 ? (
        <details className="border-t border-border px-5 py-2">
          <summary className="min-h-11 cursor-pointer content-center text-sm">
            Models used in this monitored cycle · {formatTokens(total)} tokens
          </summary>
          <div className="divide-y divide-border">
            {models.map((row) => (
              <div
                key={row.model}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs"
              >
                <span className="font-mono">{row.model}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatTokens(tokenCount(row.totals))} tokens ·{" "}
                  {row.unpricedRecords ? "Price incomplete" : formatUsd(row.costUsd)}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
