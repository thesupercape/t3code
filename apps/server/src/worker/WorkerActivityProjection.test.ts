import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { projectWorkerActivities, projectWorkerActivity } from "./WorkerActivityProjection.ts";

const base = {
  eventId: EventId.make("worker-event-1"),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("t3-worker:worker-1"),
  createdAt: "2026-08-22T20:00:00.000Z",
};

const asEvent = (value: unknown) => value as ProviderRuntimeEvent;

describe("projectWorkerActivity", () => {
  it("projects a completed tool and a compact result without raw provider metadata", () => {
    const activity = projectWorkerActivity(
      asEvent({
        ...base,
        type: "item.completed",
        payload: {
          itemType: "mcp_tool_call",
          title: "Read repository status",
          detail: "Checked the current worktree.",
          data: {
            item: {
              tool: "exec_command",
              result: { content: [{ type: "text", text: "clean\nsecret second line" }] },
            },
            hidden: "must not cross the Worker API",
          },
        },
        raw: { providerEvent: { hiddenReasoning: "never expose" } },
      }),
    );

    expect(activity).toEqual({
      id: base.eventId,
      tone: "tool",
      kind: "tool.completed",
      title: "Read repository status",
      detail: "Checked the current worktree.",
      result: "clean",
      createdAt: base.createdAt,
    });
    expect(JSON.stringify(activity)).not.toContain("hiddenReasoning");
    expect(JSON.stringify(activity)).not.toContain("must not cross");
  });

  it("drops model content and reasoning events entirely", () => {
    expect(
      projectWorkerActivity(
        asEvent({
          ...base,
          type: "content.delta",
          payload: { streamKind: "reasoning_text", delta: "private reasoning" },
        }),
      ),
    ).toBeUndefined();
    expect(
      projectWorkerActivity(
        asEvent({
          ...base,
          type: "item.completed",
          payload: { itemType: "reasoning", title: "Reasoning" },
        }),
      ),
    ).toBeUndefined();
  });

  it("projects approval and runtime failures as read-only timeline events", () => {
    expect(
      projectWorkerActivity(
        asEvent({
          ...base,
          type: "request.opened",
          requestId: "approval-1",
          payload: { requestType: "command_execution_approval", detail: "Run tests" },
        }),
      ),
    ).toMatchObject({ tone: "approval", kind: "approval.requested", detail: "Run tests" });
    expect(
      projectWorkerActivity(
        asEvent({
          ...base,
          eventId: EventId.make("worker-event-2"),
          type: "runtime.error",
          payload: { message: "Provider exited" },
        }),
      ),
    ).toMatchObject({ tone: "error", kind: "runtime.error", detail: "Provider exited" });
  });

  it("folds a started and completed item into one completed tool row", () => {
    const activities = projectWorkerActivities([
      asEvent({
        ...base,
        itemId: "exec-one",
        type: "item.started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          detail: "Get-Content AGENTS.md",
        },
      }),
      asEvent({
        ...base,
        eventId: EventId.make("worker-event-2"),
        itemId: "exec-one",
        createdAt: "2026-08-22T20:00:01.000Z",
        type: "item.completed",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "Get-Content AGENTS.md",
          data: { item: { status: "completed", aggregatedOutput: "# Workspace" } },
        },
      }),
    ]);

    expect(activities).toEqual([
      {
        id: base.eventId,
        tone: "tool",
        kind: "tool.completed",
        title: "Ran command",
        detail: "Get-Content AGENTS.md",
        result: "# Workspace",
        createdAt: base.createdAt,
      },
    ]);
  });

  it("folds a started and failed item into one expandable failed tool row", () => {
    const activities = projectWorkerActivities([
      asEvent({
        ...base,
        itemId: "exec-failed",
        type: "item.started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          detail: "git status",
        },
      }),
      asEvent({
        ...base,
        eventId: EventId.make("worker-event-failed"),
        itemId: "exec-failed",
        createdAt: "2026-08-22T20:00:02.000Z",
        type: "item.completed",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "git status",
          data: {
            item: { status: "failed", aggregatedOutput: "fatal: not a repository" },
          },
        },
      }),
    ]);

    expect(activities).toEqual([
      expect.objectContaining({
        id: base.eventId,
        kind: "tool.failed",
        title: "Ran command",
        detail: "git status",
        result: "fatal: not a repository",
        createdAt: base.createdAt,
      }),
    ]);
  });

  it("keeps an in-progress-only item visible and does not merge unidentified calls", () => {
    const activities = projectWorkerActivities([
      asEvent({
        ...base,
        itemId: "exec-running",
        type: "item.started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          detail: "vp test",
        },
      }),
      asEvent({
        ...base,
        eventId: EventId.make("worker-event-unidentified"),
        createdAt: "2026-08-22T20:00:01.000Z",
        type: "item.started",
        payload: { itemType: "command_execution", title: "Ran command" },
      }),
    ]);

    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      id: base.eventId,
      kind: "tool.started",
      title: "Ran command",
      detail: "vp test",
    });
  });
});
