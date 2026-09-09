import type { UsageSummary, UsageSummaryInput } from "@t3tools/contracts";
import {
  quotaCostWindow,
  quotaIntervals,
  quotaMonitoringSamples,
  quotaPeriods,
} from "@t3tools/shared/usageQuota";

interface UsageReply {
  readonly environmentId: string;
  readonly summary: UsageSummary | null;
  readonly error: string | null;
}

type UsageRefreshResult = readonly UsageReply[] | void | Promise<readonly UsageReply[]>;

/** Refresh costs for the newly read interval, not the interval on the old screen. */
export async function refreshCodexMonitor(options: {
  readonly trackerId: string | undefined;
  readonly refreshHistory: () => UsageRefreshResult;
  readonly refreshCosts: (input: UsageSummaryInput) => UsageRefreshResult;
  readonly refreshNews: () => Promise<boolean>;
  readonly onProgress?: (message: string) => void;
}): Promise<string> {
  // The news watcher owns its status; public news must not hold usage refresh open.
  void options.refreshNews().catch(() => false);
  const historyResult = await options.refreshHistory();
  // The web query hook may expose an imperative refresh that only schedules a
  // re-read. Keep that upstream API compatible while retaining richer reply
  // handling for clients that return the refreshed summaries directly.
  if (!Array.isArray(historyResult)) {
    return "Refresh requested. Saved quota readings update about every five minutes.";
  }
  const history = historyResult;
  const trackers = history.filter((entry) => entry.summary?.quotaHistory?.status === "ready");
  const tracker =
    trackers.find((entry) => entry.environmentId === options.trackerId) ?? trackers[0];
  const samples = quotaMonitoringSamples(tracker?.summary?.quotaHistory?.samples ?? []);
  const input = quotaCostWindow(quotaIntervals(quotaPeriods(samples)));
  if (input) options.onProgress?.("Saved readings refreshed. Updating API costs…");
  const costsResult = input ? await options.refreshCosts(input) : [];
  const costs = Array.isArray(costsResult) ? costsResult : [];
  if (history.length === 0 || [...history, ...costs].some((entry) => entry.error)) {
    return "Some computers could not be refreshed. Check their connection below.";
  }
  if (
    costs.some((entry) =>
      entry.summary?.sources.some(
        (source: { readonly status: string }) => source.status === "partial",
      ),
    )
  ) {
    return "Readings refreshed. See API-cost details below for scan progress.";
  }
  return "Refreshed. Saved quota readings update about every five minutes.";
}

/** Stable property order lets imperative refreshes share the rendered query. */
export function usageQueryInput(
  input: UsageSummaryInput,
  clientContractVersion: number,
): UsageSummaryInput {
  return {
    clientContractVersion,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
    includeQuotaHistory: input.includeQuotaHistory,
    quotaHistoryOnly: input.quotaHistoryOnly,
    quotaIntervals: input.quotaIntervals,
  };
}
