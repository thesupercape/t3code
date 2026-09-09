import type { UsageQuotaInterval, UsageTokenTotals } from "@t3tools/contracts";
import type { QuotaEnvironment } from "@t3tools/shared/usageQuota";

// USD per million tokens, standard processing. Verified against OpenAI on 2026-09-05.
export const TOKEN_PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const TOKEN_PRICES = [
  { model: "gpt-6-astra", label: "Astra", input: 10, cached: 1, output: 50 },
  { model: "gpt-5.6-sol", label: "Sol", input: 4, cached: 0.4, output: 20 },
  { model: "gpt-5.6-terra", label: "Terra", input: 2, cached: 0.2, output: 12 },
  { model: "gpt-5.6-luna", label: "Luna", input: 0.2, cached: 0.02, output: 1.2 },
] as const;

export const tokenCount = (totals: UsageTokenTotals) =>
  totals.uncachedInputTokens +
  totals.cachedInputTokens +
  totals.cacheCreationTokens +
  totals.outputTokens;

export function formatTokens(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

/** Same physical-source deduplication and exact interval as the dollar calibration. */
export function monitoredModels(
  interval: string | UsageQuotaInterval,
  environments: readonly QuotaEnvironment[],
) {
  const intervalId = typeof interval === "string" ? interval : interval.id;
  const sinceTime = typeof interval === "string" ? undefined : interval.sinceTime;
  const untilTime = typeof interval === "string" ? undefined : interval.untilTime;
  const seen = new Set<string>();
  const models = new Map<
    string,
    { model: string; totals: UsageTokenTotals; costUsd: number; unpricedRecords: number }
  >();
  for (const environment of [...environments].sort((a, b) =>
    a.environmentId.localeCompare(b.environmentId),
  )) {
    if (!environment.summary) return null;
    const summary = environment.summary;
    const savedSources = (summary.quotaCostSnapshots ?? [])
      .filter(
        (entry) =>
          entry.intervalId === intervalId &&
          (sinceTime === undefined || entry.sinceTime === sinceTime) &&
          (untilTime === undefined || entry.untilTime === untilTime) &&
          entry.fingerprint.provider === "codex",
      )
      .map((entry) => ({ fingerprint: entry.fingerprint, status: "ok" as const }));
    // A failed current scan may still carry an exact saved rollup from the
    // completed source interval. Use that rollup for the provisional planner;
    // current measured rows remain unavailable until the scan succeeds.
    if (environment.error && savedSources.length === 0) return null;
    const sources = summary.sources.filter(
      (entry) => entry.fingerprint.provider === "codex" && entry.status !== "missing",
    );
    const sourceEntries = [...sources, ...savedSources].filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) =>
            JSON.stringify(candidate.fingerprint) === JSON.stringify(entry.fingerprint),
        ) === index,
    );
    if (sourceEntries.length === 0) return null;
    for (const source of sourceEntries) {
      const key = JSON.stringify([
        source.fingerprint.hostId,
        source.fingerprint.provider,
        source.fingerprint.resolvedHomePath,
        source.fingerprint.volumeId,
      ]);
      if (seen.has(key)) continue;
      const row = summary.quotaCosts?.find(
        (entry) =>
          entry.intervalId === intervalId &&
          entry.fingerprint.hostId === source.fingerprint.hostId &&
          entry.fingerprint.resolvedHomePath === source.fingerprint.resolvedHomePath &&
          entry.fingerprint.volumeId === source.fingerprint.volumeId &&
          entry.fingerprint.provider === "codex",
      );
      const saved = summary.quotaCostSnapshots?.find(
        (entry) =>
          entry.intervalId === intervalId &&
          (sinceTime === undefined || entry.sinceTime === sinceTime) &&
          (untilTime === undefined || entry.untilTime === untilTime) &&
          entry.fingerprint.hostId === source.fingerprint.hostId &&
          entry.fingerprint.resolvedHomePath === source.fingerprint.resolvedHomePath &&
          entry.fingerprint.volumeId === source.fingerprint.volumeId &&
          entry.fingerprint.provider === "codex",
      );
      if (source.status !== "ok" && saved === undefined) return null;
      const costRow =
        !environment.error && source.status === "ok" && row?.complete && row.unpricedRecords === 0
          ? row
          : saved;
      if (!costRow?.models) return null;
      seen.add(key);
      for (const item of costRow.models) {
        const previous = models.get(item.model);
        models.set(
          item.model,
          previous
            ? {
                model: item.model,
                costUsd: previous.costUsd + item.costUsd,
                unpricedRecords: previous.unpricedRecords + item.unpricedRecords,
                totals: {
                  uncachedInputTokens:
                    previous.totals.uncachedInputTokens + item.totals.uncachedInputTokens,
                  cachedInputTokens:
                    previous.totals.cachedInputTokens + item.totals.cachedInputTokens,
                  cacheCreationTokens:
                    previous.totals.cacheCreationTokens + item.totals.cacheCreationTokens,
                  outputTokens: previous.totals.outputTokens + item.totals.outputTokens,
                  reasoningTokens: previous.totals.reasoningTokens + item.totals.reasoningTokens,
                },
              }
            : { ...item },
        );
      }
    }
  }
  return seen.size ? [...models.values()].sort((a, b) => b.costUsd - a.costUsd) : null;
}

/** Fractions describe all tokens; cache reads/writes are disjoint from uncached input. */
export function tokenBudget(
  budgetUsd: number | null,
  price: (typeof TOKEN_PRICES)[number],
  mix: { input: number; cached: number; writes: number; output: number },
  longContext = false,
  fast = false,
) {
  if (budgetUsd === null || !Number.isFinite(budgetUsd) || budgetUsd < 0) return null;
  const parts = Object.values(mix);
  if (
    parts.some((part) => !Number.isFinite(part) || part < 0) ||
    Math.abs(parts.reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    return null;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const perMillion =
    (mix.input * price.input * inputMultiplier +
      mix.cached * price.cached * inputMultiplier +
      mix.writes * price.input * 1.25 * inputMultiplier +
      mix.output * price.output * outputMultiplier) *
    (fast ? 2 : 1);
  if (perMillion <= 0) return null;
  const total = (budgetUsd / perMillion) * 1e6;
  return { total, input: total * (1 - mix.output), output: total * mix.output, perMillion };
}
