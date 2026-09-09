/** @vitest-environment happy-dom */

import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  WorkerId,
  WorkerMessageId,
  type WorkerDetail,
  type WorkerEfficiencyOverview,
} from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WorkerDetailView, WorkerEfficiencyOverviewView } from "./WorkersPanel";

Object.defineProperty(HTMLElement.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

const workerId = WorkerId.make("overview-worker");
const now = "2026-08-23T00:00:00.000Z";

const usage = {
  inputTokens: 120,
  cachedInputTokens: 40,
  outputTokens: 30,
  reasoningTokens: 10,
  totalTokens: 160,
  toolUses: 1,
} as const;

const overview: WorkerEfficiencyOverview = {
  computedAt: now,
  workersCreated: 1,
  workersActive: 0,
  workersCompleted: 1,
  workersFailed: 0,
  workersInterrupted: 0,
  timing: {
    computedAt: now,
    totalWallTimeMs: 5_000,
    overallSpanMs: 5_000,
    busyTimeMs: 5_000,
    overlapTimeMs: 0,
    averageConcurrency: 1,
    peakConcurrency: 1,
    activeActivationCount: 0,
  },
  usage,
  usageCoverage: { status: "complete" },
  toolCalls: 1,
  completedToolCalls: 1,
  failedToolCalls: 0,
  unknownToolCalls: 0,
  tools: [{ name: "read_file", calls: 1, completed: 1, failed: 0, unknown: 0 }],
  toolCoverage: { status: "complete" },
  parentCoordinationCalls: 1,
  parentCoordinationCompleted: 1,
  parentCoordinationFailures: 0,
  parentCoordinationUnknown: 0,
  parentCoordinationTools: [
    { name: "worker_start", calls: 1, completed: 1, failed: 0, unknown: 0 },
  ],
  parentCoordinationCoverage: { status: "complete" },
  parentCoordinationTokenCoverage: {
    status: "unavailable",
    reason: "Provider usage is not linked per coordination call.",
  },
  workers: [
    {
      workerId,
      title: "Runtime audit",
      status: "completed",
      model: "gpt-5.6-luna",
      backend: "codex",
      elapsedMs: 5_000,
      active: false,
      activations: 1,
      usage,
      toolCalls: 1,
      completedToolCalls: 1,
      failedToolCalls: 0,
      unknownToolCalls: 0,
      tools: [{ name: "read_file", calls: 1, completed: 1, failed: 0, unknown: 0 }],
      toolCoverage: { status: "complete" },
    },
  ],
};

const detail: WorkerDetail = {
  summary: {
    id: workerId,
    title: "Runtime audit",
    status: "completed",
    backend: "codex",
    parentThreadId: ThreadId.make("parent-thread"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-luna",
    runtimeMode: "full-access",
    createdAt: "2026-08-22T23:59:55.000Z",
    updatedAt: now,
    lastActivityAt: now,
    unreadMessageCount: 0,
    activationCount: 1,
    resumable: true,
    usage,
  },
  assignment: "Inspect the provider boundary.",
  context: { references: [], snippets: [] },
  messages: [
    {
      id: WorkerMessageId.make("worker-handoff"),
      workerId,
      author: "worker",
      kind: "handoff",
      body: "The catalog is isolated.",
      createdAt: "2026-08-22T23:59:59.000Z",
    },
  ],
  activities: [
    {
      id: EventId.make("tool-activity"),
      tone: "tool",
      kind: "tool.completed",
      title: "Inspect configuration",
      detail: "read_file apps/server/src/provider/config.ts",
      result: "sanitized output",
      createdAt: "2026-08-22T23:59:58.000Z",
    },
  ],
  activations: [],
  observerReports: [],
};

function DrilldownHarness() {
  const [selected, setSelected] = useState<WorkerId | null>(null);
  return selected === workerId ? (
    <WorkerDetailView detail={detail} showBack={false} onBack={() => setSelected(null)} />
  ) : (
    <WorkerEfficiencyOverviewView
      overview={overview}
      nowMs={Date.parse(now)}
      onSelectWorker={setSelected}
    />
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("Workers Overview drill-down", () => {
  it("opens the read-only Worker conversation and expands sanitized tool output at mobile width", async () => {
    container = document.createElement("div");
    container.style.width = "390px";
    container.style.height = "844px";
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<DrilldownHarness />));

    expect(document.body.textContent).toContain("Delegation overview");
    const openWorker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Worker Runtime audit detail"]',
    );
    expect(openWorker?.tagName).toBe("BUTTON");
    expect(openWorker?.tabIndex).toBe(0);
    openWorker?.focus();
    expect(document.activeElement).toBe(openWorker);

    await act(async () => openWorker?.click());

    expect(document.body.textContent).toContain("Inspect the provider boundary.");
    expect(document.body.textContent).toContain("The catalog is isolated.");
    const toolCall = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand tool call Inspect configuration"]',
    );
    expect(toolCall?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("sanitized output");

    await act(async () => toolCall?.click());
    expect(
      document.querySelector('button[aria-label="Collapse tool call Inspect configuration"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("read_file apps/server/src/provider/config.ts");
    expect(document.body.textContent).toContain("sanitized output");
    expect(document.body.textContent).toContain(
      "Read-only view. The parent agent owns Worker creation and control.",
    );
  });
});
