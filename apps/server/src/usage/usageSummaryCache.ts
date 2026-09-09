import type { UsageSummary, UsageSummaryInput } from "@t3tools/contracts";

export function usageSummaryCacheKey(
  input: UsageSummaryInput,
  priceOverrides?: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify([
    input.timeZone,
    input.sinceDay,
    input.untilDay,
    input.resolution ?? "day",
    input.sinceTime ?? null,
    input.untilTime ?? null,
    input.clientContractVersion ?? null,
    input.includeQuotaHistory ?? false,
    input.quotaHistoryOnly ?? false,
    input.quotaIntervals ?? null,
    priceOverrides ?? null,
  ]);
}

interface CachedSummary {
  readonly cachedAtMs: number;
  readonly summary: UsageSummary;
}

/** Bounded process-local cache for complete usage summaries. */
export class UsageSummaryCache {
  readonly #entries = new Map<string, CachedSummary>();
  readonly ttlMs: number;
  readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string, nowMs: number): UsageSummary | undefined {
    const cached = this.#entries.get(key);
    if (cached === undefined) return undefined;
    if (nowMs - cached.cachedAtMs >= this.ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return { ...cached.summary, scanDurationMs: 0 };
  }

  set(key: string, nowMs: number, summary: UsageSummary): void {
    for (const [entryKey, cached] of this.#entries) {
      if (nowMs - cached.cachedAtMs >= this.ttlMs) this.#entries.delete(entryKey);
    }
    this.#entries.delete(key);
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { cachedAtMs: nowMs, summary });
  }
}
