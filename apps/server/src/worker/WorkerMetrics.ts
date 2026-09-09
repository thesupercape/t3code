import {
  T3_WORKER_TOOL_NAMES,
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type WorkerActivation,
  type WorkerEfficiencyOverview,
  type WorkerMetricCoverage,
  type WorkerSummary,
  type WorkerTokenUsage,
  type WorkerToolMetric,
} from "@t3tools/contracts";

import {
  projectParentTurnUsage,
  projectWorkerProviderEventUsage,
  projectWorkerSummaryUsage,
} from "./WorkerUsage.ts";

const ACTIVE_STATUSES = new Set(["starting", "running", "waitingApproval"]);
const COORDINATION_TOOLS = new Set<string>(T3_WORKER_TOOL_NAMES);

type WorkerMetricSource = {
  readonly summary: WorkerSummary;
  readonly activations: ReadonlyArray<WorkerActivation>;
  readonly providerEvents: ReadonlyArray<ProviderRuntimeEvent>;
};

type Interval = { readonly start: number; readonly end: number; readonly active: boolean };
type ToolOutcome = "completed" | "failed" | "unknown";
type ToolEntry = { readonly name: string; readonly outcome: ToolOutcome };

const COMPLETED_TOOL_STATUSES = new Set(["completed", "succeeded", "success"]);
const FAILED_TOOL_STATUSES = new Set([
  "failed",
  "declined",
  "error",
  "cancelled",
  "interrupted",
  "stopped",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function metricName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : undefined;
}

function normalizedCoordinationTool(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tail = value.split("__").at(-1) ?? value;
  return COORDINATION_TOOLS.has(tail) ? tail : undefined;
}

function explicitError(...values: ReadonlyArray<unknown>): boolean {
  return values.some((value) => value !== undefined && value !== null && value !== false);
}

function toolOutcome(status: string | undefined, hasError: boolean): ToolOutcome {
  if (hasError) return "failed";
  const normalized = status?.toLowerCase();
  if (normalized && COMPLETED_TOOL_STATUSES.has(normalized)) return "completed";
  if (normalized && FAILED_TOOL_STATUSES.has(normalized)) return "failed";
  return "unknown";
}

function eventTool(event: ProviderRuntimeEvent): ToolEntry | undefined {
  if (event.type !== "item.completed" || !isToolLifecycleItemType(event.payload.itemType)) {
    return undefined;
  }
  const data = record(event.payload.data);
  const item = record(data?.item);
  const name =
    metricName(data?.toolName) ??
    metricName(item?.tool) ??
    metricName(data?.tool) ??
    event.payload.itemType;
  const status = metricName(item?.status) ?? metricName(data?.status) ?? event.payload.status;
  return {
    name,
    outcome: toolOutcome(
      status,
      explicitError(item?.error, data?.error, data?.isError === true ? true : undefined),
    ),
  };
}

function activityCoordinationTool(activity: OrchestrationThreadActivity): ToolEntry | undefined {
  if (activity.kind !== "tool.completed") return undefined;
  const payload = record(activity.payload);
  if (payload?.itemType !== "mcp_tool_call") return undefined;
  const data = record(payload.data);
  const item = record(data?.item);
  const name = normalizedCoordinationTool(
    metricName(data?.toolName) ?? metricName(item?.tool) ?? metricName(data?.tool),
  );
  if (!name) return undefined;
  const status = metricName(item?.status) ?? metricName(data?.status) ?? metricName(payload.status);
  return {
    name,
    outcome: toolOutcome(
      status,
      explicitError(
        item?.error,
        data?.error,
        payload.error,
        item?.isError === true ? true : undefined,
        data?.isError === true ? true : undefined,
        payload.isError === true ? true : undefined,
        activity.tone === "error" ? true : undefined,
      ),
    ),
  };
}

function toolBreakdown(entries: ReadonlyArray<ToolEntry>): ReadonlyArray<WorkerToolMetric> {
  const counts = new Map<
    string,
    { calls: number; completed: number; failed: number; unknown: number }
  >();
  for (const entry of entries) {
    const current = counts.get(entry.name) ?? {
      calls: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
    };
    counts.set(entry.name, {
      calls: current.calls + 1,
      completed: current.completed + (entry.outcome === "completed" ? 1 : 0),
      failed: current.failed + (entry.outcome === "failed" ? 1 : 0),
      unknown: current.unknown + (entry.outcome === "unknown" ? 1 : 0),
    });
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, ...count }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

function intervalFor(activation: WorkerActivation, nowMs: number): Interval | undefined {
  const start = Date.parse(activation.startedAt);
  const active = ACTIVE_STATUSES.has(activation.status);
  const end = active ? nowMs : Date.parse(activation.finishedAt ?? activation.lastActivityAt);
  return Number.isFinite(start) && Number.isFinite(end)
    ? { start, end: Math.max(start, end), active }
    : undefined;
}

function timing(intervals: ReadonlyArray<Interval>, computedAt: string) {
  if (intervals.length === 0) {
    return {
      computedAt,
      totalWallTimeMs: 0,
      overallSpanMs: 0,
      busyTimeMs: 0,
      overlapTimeMs: 0,
      averageConcurrency: 0,
      peakConcurrency: 0,
      activeActivationCount: 0,
    };
  }
  const points = intervals.flatMap((interval) => [
    { at: interval.start, delta: 1 },
    { at: interval.end, delta: -1 },
  ]);
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let concurrency = 0;
  let peakConcurrency = 0;
  let busyTimeMs = 0;
  let previous = points[0]!.at;
  for (const point of points) {
    if (concurrency > 0) busyTimeMs += point.at - previous;
    concurrency += point.delta;
    peakConcurrency = Math.max(peakConcurrency, concurrency);
    previous = point.at;
  }
  const totalWallTimeMs = intervals.reduce(
    (total, interval) => total + interval.end - interval.start,
    0,
  );
  const overallSpanMs =
    Math.max(...intervals.map((entry) => entry.end)) -
    Math.min(...intervals.map((entry) => entry.start));
  return {
    computedAt,
    totalWallTimeMs,
    overallSpanMs,
    busyTimeMs,
    overlapTimeMs: Math.max(0, totalWallTimeMs - busyTimeMs),
    averageConcurrency: busyTimeMs === 0 ? 0 : totalWallTimeMs / busyTimeMs,
    peakConcurrency,
    activeActivationCount: intervals.filter((entry) => entry.active).length,
  };
}

function sumUsage(workers: ReadonlyArray<WorkerMetricSource>): WorkerTokenUsage {
  const usages = workers.map((worker) => projectedUsage(worker).cumulative);
  const cachedValues = usages.map((usage) => usage.cachedInputTokens);
  return {
    inputTokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
    ...(cachedValues.some((value) => value !== undefined)
      ? {
          cachedInputTokens: cachedValues.reduce<number>((total, value) => total + (value ?? 0), 0),
        }
      : {}),
    outputTokens: usages.reduce((total, usage) => total + usage.outputTokens, 0),
    reasoningTokens: usages.reduce((total, usage) => total + usage.reasoningTokens, 0),
    totalTokens: usages.reduce((total, usage) => total + usage.totalTokens, 0),
  };
}

function projectedUsage(source: WorkerMetricSource) {
  const summary = projectWorkerSummaryUsage(source.summary, source.providerEvents);
  const latestEvent = source.providerEvents.findLast(
    (event) => event.type === "thread.token-usage.updated",
  );
  const projection = latestEvent ? projectWorkerProviderEventUsage(latestEvent) : undefined;
  return {
    summary,
    cumulative: projection?.cumulative ?? summary.usage,
    ...(projection?.lastModelCall === undefined && summary.lastModelCallUsage === undefined
      ? {}
      : { lastModelCall: projection?.lastModelCall ?? summary.lastModelCallUsage }),
    coverage:
      projection?.coverage ??
      summary.usageCoverage ??
      coverage(
        "partial",
        "This stored Worker predates cumulative usage projection; only legacy reported dimensions are available.",
      ),
  };
}

function coverage(status: WorkerMetricCoverage["status"], reason?: string): WorkerMetricCoverage {
  return { status, ...(reason ? { reason } : {}) };
}

export function buildWorkerEfficiencyOverview(input: {
  readonly workers: ReadonlyArray<WorkerMetricSource>;
  readonly parentActivities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly now: string;
}): WorkerEfficiencyOverview {
  const nowMs = Date.parse(input.now);
  const intervals = input.workers.flatMap((worker) =>
    worker.activations.flatMap((activation) => {
      const value = intervalFor(activation, nowMs);
      return value ? [value] : [];
    }),
  );
  const workerRows = input.workers.map((worker) => {
    const usage = projectedUsage(worker);
    const parentTurnUsage = projectParentTurnUsage(worker.activations, input.parentActivities);
    const tools = worker.providerEvents.flatMap((event) => {
      const value = eventTool(event);
      return value ? [value] : [];
    });
    const missingEventHistory = worker.activations.some(
      (activation) =>
        activation.providerTurnId !== undefined &&
        !worker.providerEvents.some(
          (event) =>
            event.turnId === activation.providerTurnId ||
            event.providerRefs?.providerTurnId === activation.providerTurnId,
        ),
    );
    const workerIntervals = worker.activations.flatMap((activation) => {
      const value = intervalFor(activation, nowMs);
      return value ? [value] : [];
    });
    return {
      workerId: worker.summary.id,
      ...(worker.summary.displayName === undefined
        ? {}
        : { displayName: worker.summary.displayName }),
      title: worker.summary.title,
      status: worker.summary.status,
      model: worker.summary.model,
      backend: worker.summary.backend,
      elapsedMs: workerIntervals.reduce((total, entry) => total + entry.end - entry.start, 0),
      active: ACTIVE_STATUSES.has(worker.summary.status),
      activations: worker.activations.length,
      usage: usage.cumulative,
      ...(usage.lastModelCall === undefined ? {} : { lastModelCallUsage: usage.lastModelCall }),
      usageCoverage: usage.coverage,
      ...(parentTurnUsage.coverage.status === "complete"
        ? {
            parentTurnUsage: parentTurnUsage.cumulative,
            parentTurnUsageCoverage: parentTurnUsage.coverage,
          }
        : { parentTurnUsageCoverage: parentTurnUsage.coverage }),
      toolCalls: tools.length,
      completedToolCalls: tools.filter((entry) => entry.outcome === "completed").length,
      failedToolCalls: tools.filter((entry) => entry.outcome === "failed").length,
      unknownToolCalls: tools.filter((entry) => entry.outcome === "unknown").length,
      tools: toolBreakdown(tools),
      toolCoverage:
        missingEventHistory || tools.some((entry) => entry.outcome === "unknown")
          ? coverage(
              "partial",
              missingEventHistory
                ? "Some historical activation events are unavailable."
                : "Some tool outcomes have no explicit success or failure status.",
            )
          : coverage("complete"),
    };
  });
  const allTools = input.workers.flatMap((worker) =>
    worker.providerEvents.flatMap((event) => {
      const value = eventTool(event);
      return value ? [value] : [];
    }),
  );
  const coordination = input.parentActivities?.flatMap((activity) => {
    const value = activityCoordinationTool(activity);
    return value ? [value] : [];
  });
  const latestStatuses = input.workers.map((worker) => worker.activations.at(-1)?.status);
  const usagePartial = input.workers.some(
    (worker) => projectedUsage(worker).coverage.status !== "complete",
  );
  const toolsPartial = workerRows.some((worker) => worker.toolCoverage.status !== "complete");
  const coordinationUnknown = coordination?.filter((entry) => entry.outcome === "unknown").length;
  const parentTurnCoverage =
    input.parentActivities === undefined
      ? coverage("unavailable", "The parent task activity projection was unavailable.")
      : workerRows.length === 0
        ? coverage("complete")
        : workerRows.every((worker) => worker.parentTurnUsageCoverage?.status === "complete")
          ? coverage("complete")
          : workerRows.some((worker) => worker.parentTurnUsageCoverage?.status === "complete")
            ? coverage(
                "partial",
                "Parent-turn usage is available only for Workers whose durable parent activity carries the matching turn ID.",
              )
            : coverage(
                "unavailable",
                "Matching parent context-window usage is not durable yet; existing records have no parent turn association.",
              );
  return {
    computedAt: input.now,
    workersCreated: input.workers.length,
    workersActive: input.workers.filter((worker) => ACTIVE_STATUSES.has(worker.summary.status))
      .length,
    workersCompleted: latestStatuses.filter((status) => status === "completed").length,
    workersFailed: latestStatuses.filter((status) => status === "failed").length,
    workersInterrupted: latestStatuses.filter((status) => status === "interrupted").length,
    timing: timing(intervals, input.now),
    usage: sumUsage(input.workers),
    usageCoverage: usagePartial
      ? coverage("partial", "Some completed activations have no persisted final usage snapshot.")
      : coverage("complete"),
    toolCalls: allTools.length,
    completedToolCalls: allTools.filter((entry) => entry.outcome === "completed").length,
    failedToolCalls: allTools.filter((entry) => entry.outcome === "failed").length,
    unknownToolCalls: allTools.filter((entry) => entry.outcome === "unknown").length,
    tools: toolBreakdown(allTools),
    toolCoverage: toolsPartial
      ? coverage("partial", "Some historical activation events are unavailable.")
      : coverage("complete"),
    parentCoordinationCalls: coordination?.length ?? 0,
    parentCoordinationCompleted:
      coordination?.filter((entry) => entry.outcome === "completed").length ?? 0,
    parentCoordinationFailures:
      coordination?.filter((entry) => entry.outcome === "failed").length ?? 0,
    parentCoordinationUnknown: coordinationUnknown ?? 0,
    parentCoordinationTools: toolBreakdown(coordination ?? []),
    parentCoordinationCoverage:
      coordination === undefined
        ? coverage("unavailable", "The parent task activity projection was unavailable.")
        : coordinationUnknown && coordinationUnknown > 0
          ? coverage(
              "partial",
              `${coordinationUnknown} historical coordination ${coordinationUnknown === 1 ? "call has" : "calls have"} no explicit success or failure status.`,
            )
          : coverage("complete"),
    parentCoordinationTokenCoverage: coverage(
      "unavailable",
      "Provider usage is recorded per turn, not per Worker coordination call.",
    ),
    parentTurnUsageCoverage: parentTurnCoverage,
    workers: workerRows,
  };
}

export const __testing = { activityCoordinationTool, eventTool, timing };
