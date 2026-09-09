import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkerWait,
  deriveWorkerToolCallPresentations,
  formatWorkerDuration,
  formatWorkerTimeout,
  parseWorkerToolActivity,
  workerWaitRowLabel,
  workerWaitWakeReasonLabel,
  workerToolDisplayName,
} from "./workerToolPresentation";

const startedAt = "2026-08-23T01:00:00.000Z";

function activity(
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`event-${Math.random()}`),
    tone: "tool",
    kind: "tool.updated",
    summary: "Worker tool",
    payload,
    turnId: null,
    createdAt: startedAt,
    ...overrides,
  };
}

describe("T3 Worker tool presentation", () => {
  it("summarizes a successful worker_start with its persisted name and assignment", () => {
    const call = parseWorkerToolActivity(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_start",
            status: "completed",
            result: {
              summary: {
                id: "worker-1",
                displayName: "Repository scout",
                title: "Inspect the provider boundary",
                status: "running",
              },
              assignment: "Inspect the provider boundary",
            },
          },
        },
      }),
    );

    expect(call).toMatchObject({
      action: "Started",
      state: "completed",
      assignment: "Inspect the provider boundary",
      workers: [{ id: "worker-1", name: "Repository scout", status: "running" }],
    });
    expect(workerToolDisplayName(call!)).toBe("Repository scout");
  });

  it("keeps failed and malformed calls honest without throwing", () => {
    const failed = parseWorkerToolActivity(
      activity(
        {
          itemType: "mcp_tool_call",
          status: "failed",
          title: "mcp__t3_code__worker_status",
          data: { toolName: "mcp__t3_code__worker_status", input: { workerId: "worker-2" } },
        },
        { kind: "tool.completed", tone: "error" },
      ),
    );
    expect(failed).toMatchObject({ action: "Checked status for", state: "failed" });
    expect(parseWorkerToolActivity(activity({ itemType: "mcp_tool_call", data: null }))).toBeNull();
    expect(
      parseWorkerToolActivity(activity({ itemType: "mcp_tool_call", data: { item: { tool: 3 } } })),
    ).toBeNull();
  });

  it("reads the legacy Claude-shaped toolName/input/result record", () => {
    const call = parseWorkerToolActivity(
      activity(
        {
          itemType: "mcp_tool_call",
          data: {
            toolName: "mcp__t3_code__worker_status",
            input: { workerId: "worker-legacy" },
            result: {
              status: "completed",
              summary: { id: "worker-legacy", title: "Legacy check" },
            },
          },
          title: "mcp__t3_code__worker_status",
        },
        { kind: "tool.completed" },
      ),
    );
    expect(call).toMatchObject({
      workerIds: ["worker-legacy"],
      workers: [{ id: "worker-legacy", name: "Legacy check" }],
      state: "completed",
    });
  });

  it("resolves singular worker_observe arguments through prior Worker identity", () => {
    const started = activity(
      {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_start",
            status: "completed",
            result: { summary: { id: "worker-1", displayName: "Scout", title: "Scan files" } },
          },
        },
      },
      { kind: "tool.completed", sequence: 1 },
    );
    const observed = activity(
      {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_observe",
            status: "completed",
            arguments: { workerId: "worker-1" },
            result: { workerId: "worker-1", summary: "Still working" },
          },
        },
      },
      { kind: "tool.completed", sequence: 2 },
    );

    const call = deriveWorkerToolCallPresentations([started, observed]).find(
      (candidate) => candidate.toolName === "worker_observe",
    );
    expect(call).toMatchObject({
      workerIds: ["worker-1"],
      workers: [{ id: "worker-1", name: "Scout" }],
    });
    expect(workerToolDisplayName(call!)).toBe("Scout");
  });

  it("shows an active wait only while the real tool lifecycle is in progress", () => {
    const waitStarted = activity(
      {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: {
          toolCallId: "wait-1",
          item: {
            tool: "worker_wait",
            status: "inProgress",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000, mode: "anyRelevantEvent" },
          },
        },
        title: "worker_wait",
      },
      { sequence: 2 },
    );
    const started = activity(
      {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_start",
            status: "completed",
            result: { summary: { id: "worker-1", displayName: "Scout", title: "Scan files" } },
          },
        },
        title: "worker_start",
      },
      { kind: "tool.completed", sequence: 1 },
    );
    const active = deriveActiveWorkerWait([waitStarted, started], Date.parse(startedAt) + 4_000);
    expect(active).toMatchObject({
      toolName: "worker_wait",
      workers: [{ name: "Scout" }],
      timeoutMillis: 60_000,
      latestEvent: "No wake event yet · 4s elapsed",
    });

    const finished = activity(
      {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          toolCallId: "wait-1",
          item: {
            tool: "worker_wait",
            status: "completed",
            result: { status: "woken", reason: "completed" },
          },
        },
        title: "worker_wait",
      },
      { kind: "tool.completed", sequence: 3, createdAt: "2026-08-23T01:00:05.000Z" },
    );
    expect(deriveActiveWorkerWait([started, waitStarted, finished])).toBeNull();
  });

  it("does not throw on a malformed wait timestamp", () => {
    const waitStarted = activity(
      {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: {
          toolCallId: "wait-malformed",
          item: {
            tool: "worker_wait",
            status: "inProgress",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000 },
          },
        },
      },
      { createdAt: "not-a-date" },
    );

    expect(() => deriveActiveWorkerWait([waitStarted])).not.toThrow();
    const activeWait = deriveActiveWorkerWait([waitStarted]);
    expect(activeWait).toMatchObject({ latestEvent: "No wake event yet" });
    expect(activeWait).not.toHaveProperty("deadlineAt");
  });

  it("expires an orphaned in-progress wait at its own deadline", () => {
    const waitStarted = activity({
      itemType: "mcp_tool_call",
      status: "inProgress",
      data: {
        toolCallId: "wait-orphaned",
        item: {
          tool: "worker_wait",
          status: "inProgress",
          arguments: { workerIds: ["worker-1"], timeoutMillis: 1_000 },
        },
      },
    });

    expect(deriveActiveWorkerWait([waitStarted], Date.parse(startedAt) + 999)).not.toBeNull();
    expect(deriveActiveWorkerWait([waitStarted], Date.parse(startedAt) + 1_000)).toBeNull();
  });

  it("clears the dormant state when the wait call fails", () => {
    const waitStarted = activity({
      itemType: "mcp_tool_call",
      status: "inProgress",
      data: {
        toolCallId: "wait-failed",
        item: {
          tool: "worker_wait",
          status: "inProgress",
          arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000 },
        },
      },
    });
    const failed = activity(
      {
        itemType: "mcp_tool_call",
        status: "failed",
        data: {
          toolCallId: "wait-failed",
          item: { tool: "worker_wait", status: "failed", error: "lease failed" },
        },
      },
      { kind: "tool.failed", tone: "error", createdAt: "2026-08-23T01:00:01.000Z" },
    );
    expect(deriveActiveWorkerWait([waitStarted, failed])).toBeNull();
  });

  it("formats bounded waits and wake reasons without exposing provider wording", () => {
    expect(formatWorkerTimeout(15 * 60_000)).toBe("15m");
    expect(formatWorkerDuration(91_000)).toBe("1m 31s");
    expect(workerWaitWakeReasonLabel("message")).toBe("progress event");
    expect(
      workerWaitRowLabel({
        toolName: "worker_wait",
        action: "Waiting on",
        state: "completed",
        workerIds: ["worker-1"],
        workers: [{ id: "worker-1", name: "Luna Pine", status: "running" }],
        startedAt,
        endedAt: "2026-08-23T01:00:35.000Z",
        timeoutMillis: 15 * 60_000,
        wakeReason: "message",
        resultingStatus: "running",
        wakeReasons: [],
        durationMs: 35_000,
      }),
    ).toBe("Woke after 35s, progress event");
  });

  it("reads actual wait completion fields and keeps malformed results safe", () => {
    const completed = parseWorkerToolActivity(
      activity(
        {
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              tool: "worker_wait",
              status: "completed",
              arguments: { workerIds: ["worker-1"], timeoutMillis: 900_000 },
              result: {
                status: "woken",
                reason: "completed",
                events: [{ workerId: "worker-1", reason: "completed", status: "completed" }],
                workers: [{ id: "worker-1", displayName: "Luna Pine", status: "completed" }],
              },
            },
            toolCallId: "wait-1",
          },
        },
        { kind: "tool.completed", createdAt: "2026-08-23T01:01:31.000Z" },
      ),
    );
    expect(completed).toMatchObject({
      wakeReason: "completed",
      resultingStatus: "completed",
      timeoutMillis: 900_000,
      workers: [{ name: "Luna Pine" }],
    });
    expect(workerWaitRowLabel(completed!)).toBe("Worker finished after —");
    expect(
      parseWorkerToolActivity(
        activity({
          itemType: "mcp_tool_call",
          data: { item: { tool: "worker_wait", result: [] } },
        }),
      ),
    ).toMatchObject({ toolName: "worker_wait", state: "inProgress" });
  });

  it("merges lifecycle receipts for one wait while retaining one Advanced attempt", () => {
    const started = activity(
      {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: {
          toolCallId: "wait-merge",
          item: {
            tool: "worker_wait",
            status: "inProgress",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000 },
          },
        },
      },
      { sequence: 1 },
    );
    const completed = activity(
      {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          toolCallId: "wait-merge",
          item: {
            tool: "worker_wait",
            status: "completed",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000 },
            result: { status: "woken", reason: "message" },
          },
        },
      },
      { kind: "tool.completed", sequence: 2, createdAt: "2026-08-23T01:00:35.000Z" },
    );
    const [call] = deriveWorkerToolCallPresentations([started, completed]);
    expect(call).toMatchObject({ durationMs: 35_000, wakeReason: "message" });
    expect(call?.waitAttempts).toHaveLength(1);
  });

  it("does not merge separated legacy waits into one session", () => {
    const first = activity(
      {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          item: {
            tool: "worker_wait",
            status: "completed",
            arguments: { workerIds: ["worker-1"] },
            result: { status: "woken", reason: "message" },
          },
        },
      },
      { sequence: 1 },
    );
    const unrelated = activity(
      {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          item: {
            tool: "worker_status",
            status: "completed",
            arguments: { workerId: "worker-1" },
          },
        },
      },
      { sequence: 2 },
    );
    const second = activity(
      {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: {
          item: {
            tool: "worker_wait",
            status: "inProgress",
            arguments: { workerIds: ["worker-1"] },
          },
        },
      },
      { sequence: 3 },
    );

    expect(
      deriveWorkerToolCallPresentations([first, unrelated, second]).filter(
        (call) => call.toolName === "worker_wait",
      ),
    ).toHaveLength(2);
  });
});
