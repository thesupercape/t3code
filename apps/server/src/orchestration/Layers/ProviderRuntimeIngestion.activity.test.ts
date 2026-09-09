import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it.each(["item.started", "item.updated", "item.completed"] as const)(
    "persists compact screenshot metadata for %s",
    (type) => {
      const screenshot = {
        threadId: base.threadId,
        attachmentId: "thread-1-12345678-1234-1234-1234-123456789abc",
        mimeType: "image/png",
        width: 1280,
        height: 720,
      };
      const activities = runtimeEventToActivities({
        ...base,
        eventId: EventId.make("screenshot"),
        type,
        payload: {
          itemType: "mcp_tool_call",
          data: {
            item: {
              tool: "computer_screenshot",
              result: {
                structuredContent: { screenshot },
                content: [{ type: "image", data: "large-image-bytes".repeat(100_000) }],
              },
            },
          },
        },
      });
      expect(activities[0]?.payload).toMatchObject({ data: { item: { result: { screenshot } } } });
      expect(JSON.stringify(activities).length).toBeLessThan(1024);
    },
  );

  it("drops screenshot pointers belonging to a different thread before persistence", () => {
    const activities = runtimeEventToActivities({
      ...base,
      eventId: EventId.make("screenshot"),
      type: "item.completed",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "computer_screenshot",
            result: {
              screenshot: {
                threadId: "thread-2",
                attachmentId: "thread-2-12345678-1234-1234-1234-123456789abc",
                mimeType: "image/png",
                width: 1,
                height: 1,
              },
            },
          },
        },
      },
    });
    expect(activities[0]?.payload).not.toHaveProperty("data.item.result.screenshot");
  });
  it("retains Codex child identity on every persisted lifecycle snapshot", () => {
    const taskId = RuntimeTaskId.make("codex-child");
    const providerRefs = {
      providerThreadId: "codex-child",
      providerTurnId: "codex-child-turn",
    };
    const linkage = { taskId, parentAgentId: "codex-parent", timelineBypass: true };
    const events: ReadonlyArray<ProviderRuntimeEvent> = [
      {
        ...base,
        providerRefs,
        eventId: EventId.make("start"),
        type: "task.started",
        payload: { ...linkage, description: "Inspect browser", taskType: "agent" },
      },
      {
        ...base,
        providerRefs,
        eventId: EventId.make("progress"),
        type: "task.progress",
        payload: {
          ...linkage,
          description: "Inspect browser",
          summary: "Running a check",
          typedUsage: { totalTokens: 12 },
        },
      },
      {
        ...base,
        providerRefs,
        eventId: EventId.make("update"),
        type: "task.updated",
        payload: { ...linkage, status: "waiting" },
      },
      {
        ...base,
        providerRefs,
        eventId: EventId.make("complete"),
        type: "task.completed",
        payload: { ...linkage, status: "completed", summary: "Check passed" },
      },
    ];

    for (const event of events) {
      const activities = runtimeEventToActivities(event);
      expect(activities.length).toBeGreaterThan(0);
      for (const activity of activities) {
        expect(activity.payload).toMatchObject({
          taskId: "codex-child",
          parentAgentId: "codex-parent",
          providerRefs,
        });
      }
    }
  });

  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});
