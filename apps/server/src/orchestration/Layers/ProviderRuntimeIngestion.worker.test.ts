import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  RuntimeTaskId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  runNormalProviderRuntimeEvent,
  runtimeEventToActivities,
} from "./ProviderRuntimeIngestion.ts";

const event = (threadId: ThreadId): ProviderRuntimeEvent => ({
  type: "runtime.warning",
  eventId: EventId.make(`event-${threadId}`),
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-22T00:00:00.000Z",
  threadId,
  payload: { message: "test event" },
});

it.effect("bypasses normal projection for an explicitly linked Worker thread", () =>
  Effect.gen(function* () {
    let projected = false;
    yield* runNormalProviderRuntimeEvent(
      () => Effect.succeed(true),
      event(ThreadId.make("provider-worker-thread")),
      () =>
        Effect.sync(() => {
          projected = true;
        }),
    );
    expect(projected).toBe(false);
  }),
);

it.effect("continues normal projection for an ordinary provider thread", () =>
  Effect.gen(function* () {
    let projected = false;
    yield* runNormalProviderRuntimeEvent(
      () => Effect.succeed(false),
      event(ThreadId.make("ordinary-parent-thread")),
      () =>
        Effect.sync(() => {
          projected = true;
        }),
    );
    expect(projected).toBe(true);
  }),
);

it("keeps native child identities in persisted task activity", () => {
  const providerRefs = { providerThreadId: "native-child", providerTurnId: "native-turn" };
  const activities = runtimeEventToActivities({
    ...event(ThreadId.make("parent")),
    type: "task.started",
    providerRefs,
    payload: {
      taskId: RuntimeTaskId.make("child"),
      description: "Inspect the build",
      taskType: "subagent",
    },
  });
  expect(activities[0]?.payload).toMatchObject({ providerRefs, taskId: "child" });
});

it("preserves tool and permission approvals alongside app access requests", () => {
  for (const [requestType, requestKind, summary] of [
    ["tool_approval", "tool", "Tool approval requested"],
    ["permissions_approval", "permissions", "Permission requested"],
    ["mcp_elicitation_approval", "mcp-elicitation", "App access approval requested"],
  ] as const) {
    const activities = runtimeEventToActivities({
      ...event(ThreadId.make("parent")),
      type: "request.opened",
      requestId: RuntimeRequestId.make("request"),
      payload: { requestType, appName: "Test app" },
    });
    expect(activities[0]?.summary).toBe(summary);
    expect(activities[0]?.payload).toMatchObject({ requestKind, appName: "Test app" });
  }
});
