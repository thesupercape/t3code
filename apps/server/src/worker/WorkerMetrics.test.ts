import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkerActivationId,
  WorkerId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type WorkerActivation,
  type WorkerSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildWorkerEfficiencyOverview } from "./WorkerMetrics.ts";

const now = "2026-08-22T20:00:10.000Z";
const providerInstanceId = ProviderInstanceId.make("codex");
const parentThreadId = ThreadId.make("parent");

function source(input: {
  id: string;
  status: WorkerSummary["status"];
  start: string;
  end?: string;
  events?: ReadonlyArray<ProviderRuntimeEvent>;
  usage?: Partial<WorkerSummary["usage"]>;
  parentTurnId?: TurnId;
}) {
  const workerId = WorkerId.make(input.id);
  const activationId = WorkerActivationId.make(`activation-${input.id}`);
  const providerTurnId = TurnId.make(`turn-${input.id}`);
  const active = ["starting", "running", "waitingApproval"].includes(input.status);
  const activation: WorkerActivation = {
    id: activationId,
    workerId,
    status: input.status === "closed" ? "completed" : input.status,
    providerInstanceId,
    providerThreadId: ThreadId.make(`t3-worker:${input.id}`),
    providerTurnId,
    ...(input.parentTurnId === undefined ? {} : { parentTurnId: input.parentTurnId }),
    startedAt: input.start,
    ...(input.end ? { finishedAt: input.end } : {}),
    lastActivityAt: input.end ?? now,
    usageBaseline: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    usageDelta: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    ...(!active
      ? {
          latestUsage: {
            inputTokens: input.usage?.inputTokens ?? 100,
            outputTokens: input.usage?.outputTokens ?? 20,
            reasoningTokens: 0,
            totalTokens: input.usage?.totalTokens ?? 120,
          },
        }
      : {}),
  };
  const summary: WorkerSummary = {
    id: workerId,
    title: `Worker ${input.id}`,
    status: input.status,
    backend: "codex",
    parentThreadId,
    providerInstanceId,
    model: "gpt-5.6-sol",
    runtimeMode: "full-access",
    createdAt: input.start,
    updatedAt: input.end ?? now,
    lastActivityAt: input.end ?? now,
    unreadMessageCount: 0,
    activationCount: 1,
    resumable: true,
    usage: {
      inputTokens: input.usage?.inputTokens ?? 100,
      cachedInputTokens: input.usage?.cachedInputTokens ?? 40,
      outputTokens: input.usage?.outputTokens ?? 20,
      reasoningTokens: 0,
      totalTokens: input.usage?.totalTokens ?? 120,
    },
  };
  return { summary, activations: [activation], providerEvents: input.events ?? [] };
}

function toolEvent(input: { turn: string; name: string; failed?: boolean }): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`event-${input.turn}-${input.name}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make(`t3-worker:${input.turn}`),
    turnId: TurnId.make(input.turn),
    createdAt: now,
    type: "item.completed",
    payload: {
      itemType: "mcp_tool_call",
      data: {
        item: {
          tool: input.name,
          status: input.failed ? "failed" : "completed",
          ...(input.failed ? { error: "failed" } : {}),
        },
      },
    },
  };
}

function tokenUsageEvent(input: { worker: string; turn: string }): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`usage-${input.worker}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make(`t3-worker:${input.worker}`),
    turnId: TurnId.make(input.turn),
    createdAt: now,
    type: "thread.token-usage.updated",
    payload: {
      usage: {
        usedTokens: 36134,
        totalProcessedTokens: 249949,
        inputTokens: 35882,
        cachedInputTokens: 34560,
        outputTokens: 252,
        reasoningOutputTokens: 0,
        lastUsedTokens: 36134,
        lastInputTokens: 35882,
        lastCachedInputTokens: 34560,
        lastOutputTokens: 252,
        lastReasoningOutputTokens: 0,
      },
    },
    raw: {
      source: "codex.app-server.notification",
      method: "thread/tokenUsage/updated",
      payload: {
        tokenUsage: {
          total: {
            inputTokens: 247750,
            cachedInputTokens: 217856,
            outputTokens: 2199,
            reasoningOutputTokens: 942,
            totalTokens: 249949,
          },
          last: {
            inputTokens: 35882,
            cachedInputTokens: 34560,
            outputTokens: 252,
            reasoningOutputTokens: 0,
            totalTokens: 36134,
          },
        },
      },
    },
  };
}

describe("buildWorkerEfficiencyOverview", () => {
  it("computes exact wall, span, overlap, concurrency, status, and token totals", () => {
    const first = source({
      id: "one",
      status: "completed",
      start: "2026-08-22T20:00:00.000Z",
      end: "2026-08-22T20:00:06.000Z",
      events: [toolEvent({ turn: "turn-one", name: "exec_command" })],
    });
    const second = source({
      id: "two",
      status: "running",
      start: "2026-08-22T20:00:04.000Z",
      events: [toolEvent({ turn: "turn-two", name: "read_file", failed: true })],
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 0 },
    });
    const result = buildWorkerEfficiencyOverview({ workers: [first, second], now });

    expect(result.timing).toMatchObject({
      totalWallTimeMs: 12_000,
      overallSpanMs: 10_000,
      busyTimeMs: 10_000,
      overlapTimeMs: 2_000,
      averageConcurrency: 1.2,
      peakConcurrency: 2,
      activeActivationCount: 1,
    });
    expect(result).toMatchObject({
      workersCreated: 2,
      workersActive: 1,
      workersCompleted: 1,
      toolCalls: 2,
      completedToolCalls: 1,
      failedToolCalls: 1,
      usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 },
    });
    expect(result.tools).toEqual([
      { name: "exec_command", calls: 1, completed: 1, failed: 0, unknown: 0 },
      { name: "read_file", calls: 1, completed: 0, failed: 1, unknown: 0 },
    ]);
  });

  it("keeps cumulative dimensions separate from the last model call", () => {
    const parentTurnId = TurnId.make("parent-turn");
    const worker = source({
      id: "accounting",
      status: "completed",
      start: "2026-08-22T19:59:00.000Z",
      end: now,
      parentTurnId,
      events: [tokenUsageEvent({ worker: "accounting", turn: "turn-accounting" })],
    });
    const result = buildWorkerEfficiencyOverview({
      workers: [worker],
      parentActivities: [
        {
          id: EventId.make("parent-usage"),
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: {
            usedTokens: 100,
            totalProcessedTokens: 2_000,
            cumulativeInputTokens: 1_800,
            cumulativeCachedInputTokens: 1_200,
            cumulativeOutputTokens: 200,
            cumulativeReasoningOutputTokens: 50,
          },
          turnId: parentTurnId,
          createdAt: now,
        },
      ],
      now,
    });

    expect(result.usage).toMatchObject({
      inputTokens: 247750,
      cachedInputTokens: 217856,
      outputTokens: 2199,
      reasoningTokens: 942,
      totalTokens: 249949,
    });
    expect(result.workers[0]).toMatchObject({
      usage: {
        inputTokens: 247750,
        cachedInputTokens: 217856,
        outputTokens: 2199,
        reasoningTokens: 942,
        totalTokens: 249949,
      },
      lastModelCallUsage: {
        inputTokens: 35882,
        cachedInputTokens: 34560,
        outputTokens: 252,
        reasoningTokens: 0,
        totalTokens: 36134,
      },
      parentTurnUsage: {
        inputTokens: 1800,
        cachedInputTokens: 1200,
        outputTokens: 200,
        reasoningTokens: 50,
        totalTokens: 2000,
      },
      parentTurnUsageCoverage: { status: "complete" },
    });
    expect(result.parentTurnUsageCoverage).toMatchObject({ status: "complete" });
  });

  it("classifies explicit success, explicit failure, and missing parent outcomes truthfully", () => {
    const parentActivities: ReadonlyArray<OrchestrationThreadActivity> = [
      {
        id: EventId.make("parent-worker-start"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Start Worker",
        payload: {
          itemType: "mcp_tool_call",
          data: { item: { server: "t3_code", tool: "worker_start", status: "completed" } },
        },
        turnId: TurnId.make("parent-turn"),
        createdAt: now,
      },
      {
        id: EventId.make("parent-worker-wait-failed"),
        tone: "error",
        kind: "tool.completed",
        summary: "Wait for Worker",
        payload: {
          itemType: "mcp_tool_call",
          data: { item: { server: "t3_code", tool: "worker_wait", status: "failed" } },
        },
        turnId: TurnId.make("parent-turn"),
        createdAt: now,
      },
      {
        id: EventId.make("parent-worker-close-unknown"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Close Worker",
        payload: {
          itemType: "mcp_tool_call",
          data: { item: { server: "t3_code", tool: "worker_close" } },
        },
        turnId: TurnId.make("parent-turn"),
        createdAt: now,
      },
      {
        id: EventId.make("parent-shell"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Run shell",
        payload: {
          itemType: "mcp_tool_call",
          data: { item: { server: "other", tool: "exec_command", status: "completed" } },
        },
        turnId: TurnId.make("parent-turn"),
        createdAt: now,
      },
    ];
    const result = buildWorkerEfficiencyOverview({ workers: [], parentActivities, now });
    expect(result).toMatchObject({
      parentCoordinationCalls: 3,
      parentCoordinationCompleted: 1,
      parentCoordinationFailures: 1,
      parentCoordinationUnknown: 1,
    });
    expect(result.parentCoordinationTools).toEqual([
      { name: "worker_close", calls: 1, completed: 0, failed: 0, unknown: 1 },
      { name: "worker_start", calls: 1, completed: 1, failed: 0, unknown: 0 },
      { name: "worker_wait", calls: 1, completed: 0, failed: 1, unknown: 0 },
    ]);
    expect(result.parentCoordinationCoverage).toMatchObject({ status: "partial" });
    expect(result.parentCoordinationTokenCoverage).toMatchObject({ status: "unavailable" });
  });

  it("does not treat a null error field as failure", () => {
    const parentActivities: ReadonlyArray<OrchestrationThreadActivity> = [
      {
        id: EventId.make("parent-worker-start-null-error"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Start Worker",
        payload: {
          itemType: "mcp_tool_call",
          data: {
            item: {
              server: "t3_code",
              tool: "worker_start",
              status: "completed",
              error: null,
            },
          },
        },
        turnId: TurnId.make("parent-turn"),
        createdAt: now,
      },
    ];
    const result = buildWorkerEfficiencyOverview({ workers: [], parentActivities, now });
    expect(result).toMatchObject({
      parentCoordinationCompleted: 1,
      parentCoordinationFailures: 0,
      parentCoordinationUnknown: 0,
      parentCoordinationCoverage: { status: "complete" },
    });
  });

  it("marks missing activation event and final usage history partial", () => {
    const worker = source({
      id: "legacy",
      status: "failed",
      start: "2026-08-22T19:59:00.000Z",
      end: "2026-08-22T19:59:05.000Z",
    });
    const { latestUsage: _latestUsage, ...withoutLatestUsage } = worker.activations[0]!;
    const result = buildWorkerEfficiencyOverview({
      workers: [{ ...worker, activations: [withoutLatestUsage] }],
      now,
    });
    expect(result.toolCoverage.status).toBe("partial");
    expect(result.usageCoverage.status).toBe("partial");
    expect(result.parentCoordinationCoverage.status).toBe("unavailable");
  });
});
