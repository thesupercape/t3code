/** @vitest-environment happy-dom */

import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

Object.defineProperty(HTMLElement.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("AgentsPanel child details", () => {
  it("shows the native parent name and completed last turn while the thread remains resumable", async () => {
    const activities: OrchestrationThreadActivity[] = [
      { taskId: "child", title: "Child", parentAgentId: "root", status: "idle" },
      {
        taskId: "grandchild",
        title: "Grandchild",
        parentAgentId: "child",
        status: "idle",
        lastTurn: {
          turnId: "grandchild-turn",
          outcome: "completed",
          completedAt: "2026-08-31T00:50:10.000Z",
          durationMs: 7283,
          result: "GRANDCHILD_COMPLETE",
        },
      },
    ].map((payload, index) => ({
      id: EventId.make(`activity-${index}`),
      kind: "task.updated",
      tone: "info",
      summary: "Task idle",
      payload: { ...payload, agentKind: "agent" },
      turnId: null,
      createdAt: "2026-08-31T00:50:10.783Z",
    }));
    const model = deriveAgentPanelModel({ agents: foldSubagentActivities(activities) });
    container = document.createElement("div");
    container.style.width = "390px";
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AgentsPanel model={model} />));

    expect(container.textContent).toContain("via Child");
    expect(container.textContent).toContain("last turn completed");
    expect(container.textContent).toContain("7s");
    expect(container.textContent).not.toContain("Direct spawns");
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="View details for Grandchild"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Idle · resumable");
    expect(dialog?.textContent).toContain("Last turn outcomecompleted");
    expect(dialog?.textContent).toContain("2026-08-31T00:50:10.000Z");
    expect(dialog?.textContent).toContain("7283 ms");
    expect(dialog?.textContent).toContain("Last turn resultGRANDCHILD_COMPLETE");
    expect(dialog?.textContent).toContain("Parent nameChild");
    expect(dialog?.textContent).toContain("Parent agentchild");
    expect(dialog?.textContent).not.toContain("gpt-");
  });
});
