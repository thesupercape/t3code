import type {
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
  WorkerActivation,
  WorkerMetricCoverage,
  WorkerSummary,
  WorkerTokenUsage,
} from "@t3tools/contracts";

export interface ProjectedWorkerUsage {
  readonly cumulative: WorkerTokenUsage;
  readonly lastModelCall?: WorkerTokenUsage | undefined;
  readonly coverage: WorkerMetricCoverage;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function numberAt(source: Record<string, unknown> | undefined, key: string): number | undefined {
  return nonNegativeInt(source?.[key]);
}

function usageFromRecord(
  source: Record<string, unknown> | undefined,
  fallbackTotal: number,
  options: { readonly cumulative: boolean },
): WorkerTokenUsage {
  const inputTokens =
    numberAt(source, options.cumulative ? "cumulativeInputTokens" : "lastInputTokens") ??
    numberAt(source, "inputTokens") ??
    0;
  const cachedInputTokens =
    numberAt(
      source,
      options.cumulative ? "cumulativeCachedInputTokens" : "lastCachedInputTokens",
    ) ?? numberAt(source, "cachedInputTokens");
  const outputTokens =
    numberAt(source, options.cumulative ? "cumulativeOutputTokens" : "lastOutputTokens") ??
    numberAt(source, "outputTokens") ??
    0;
  const reasoningTokens =
    numberAt(
      source,
      options.cumulative ? "cumulativeReasoningOutputTokens" : "lastReasoningOutputTokens",
    ) ??
    numberAt(source, "reasoningOutputTokens") ??
    0;
  const totalTokens =
    numberAt(source, options.cumulative ? "totalTokens" : "lastUsedTokens") ??
    (options.cumulative ? undefined : numberAt(source, "totalTokens")) ??
    numberAt(source, "totalProcessedTokens") ??
    numberAt(source, "usedTokens") ??
    fallbackTotal;
  const toolUses = numberAt(source, "toolUses");
  const durationMillis = numberAt(source, "durationMs");
  return {
    inputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    outputTokens,
    reasoningTokens,
    totalTokens,
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMillis === undefined ? {} : { durationMillis }),
  };
}

function rawTokenUsage(raw: unknown): {
  readonly total?: Record<string, unknown> | undefined;
  readonly last?: Record<string, unknown> | undefined;
} {
  const payload = record(record(raw)?.payload);
  const tokenUsage = record(payload?.tokenUsage);
  return {
    total: record(tokenUsage?.total),
    last: record(tokenUsage?.last),
  };
}

function hasCumulativeDimensions(usage: Record<string, unknown> | undefined): boolean {
  return (
    numberAt(usage, "cumulativeInputTokens") !== undefined ||
    numberAt(usage, "cumulativeCachedInputTokens") !== undefined ||
    numberAt(usage, "cumulativeOutputTokens") !== undefined ||
    numberAt(usage, "cumulativeReasoningOutputTokens") !== undefined
  );
}

/** Projects one provider snapshot without conflating its total and last-call fields. */
export function projectWorkerUsageSnapshot(
  usage: Record<string, unknown> | undefined,
  raw?: unknown,
): ProjectedWorkerUsage {
  const rawUsage = rawTokenUsage(raw);
  const total = rawUsage.total ?? (hasCumulativeDimensions(usage) ? usage : undefined);
  const last = rawUsage.last ?? usage;
  const fallbackTotal =
    numberAt(usage, "totalProcessedTokens") ?? numberAt(usage, "usedTokens") ?? 0;
  const cumulative = usageFromRecord(total ?? usage, fallbackTotal, { cumulative: true });
  const lastModelCall =
    last === undefined
      ? undefined
      : usageFromRecord(last, cumulative.totalTokens, { cumulative: false });
  return {
    cumulative,
    ...(lastModelCall === undefined ? {} : { lastModelCall }),
    coverage:
      total === undefined
        ? {
            status: "partial",
            reason:
              "The stored provider event has a total token count but no cumulative input/output breakdown.",
          }
        : { status: "complete" },
  };
}

export function projectWorkerProviderEventUsage(
  event: ProviderRuntimeEvent,
): ProjectedWorkerUsage | undefined {
  if (event.type !== "thread.token-usage.updated") return undefined;
  return projectWorkerUsageSnapshot(event.payload.usage, event.raw);
}

export function projectWorkerSummaryUsage(
  summary: WorkerSummary,
  providerEvents: ReadonlyArray<ProviderRuntimeEvent>,
): WorkerSummary {
  // Worker-linked Codex sessions report cumulative usage. Late events from an
  // earlier activation can arrive after a follow-up, so arrival order is not a
  // safe source of truth. Select the greatest cumulative snapshot instead.
  const projected = providerEvents.reduce<ProjectedWorkerUsage | undefined>((greatest, event) => {
    const candidate = projectWorkerProviderEventUsage(event);
    if (candidate === undefined) return greatest;
    return greatest === undefined ||
      candidate.cumulative.totalTokens >= greatest.cumulative.totalTokens
      ? candidate
      : greatest;
  }, undefined);
  if (projected === undefined) return summary;
  return {
    ...summary,
    usage: projected.cumulative,
    usageCoverage: projected.coverage,
    ...(projected.lastModelCall === undefined
      ? {}
      : { lastModelCallUsage: projected.lastModelCall }),
  };
}

export function projectParentTurnUsage(
  activations: ReadonlyArray<WorkerActivation>,
  parentActivities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): ProjectedWorkerUsage {
  const parentTurnId = activations.findLast(
    (activation) => activation.parentTurnId !== undefined,
  )?.parentTurnId;
  if (parentActivities === undefined) {
    return {
      cumulative: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      coverage: {
        status: "unavailable",
        reason: "The parent task activity projection was unavailable.",
      },
    };
  }
  if (parentTurnId === undefined) {
    return {
      cumulative: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      coverage: {
        status: "unavailable",
        reason: "This Worker has no durable parentTurnId to match against parent usage.",
      },
    };
  }
  const activity = parentActivities.findLast(
    (entry) => entry.kind === "context-window.updated" && entry.turnId === parentTurnId,
  );
  if (activity === undefined) {
    return {
      cumulative: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      coverage: {
        status: "unavailable",
        reason:
          "Matching parent context-window usage is not durable yet; existing records have no parent turn association.",
      },
    };
  }
  return projectWorkerUsageSnapshot(record(activity.payload));
}
