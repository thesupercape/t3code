import {
  ApprovalRequestId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  WorkerActivationId,
  WorkerId,
  WorkerMessageId,
  WorkerObserverReportId,
  type WorkerDetail,
  type WorkerEfficiencyOverview,
  type WorkerMessage,
  type WorkerSummary,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkerElapsedClock,
  PARENT_INPUT_ATTRIBUTION_UNAVAILABLE_REASON,
  WorkerCompletionSummary,
  WorkerDetailView,
  WorkerEfficiencyOverviewView,
  WorkerRail,
  WorkerToolCallRow,
  WORKERS_ADVANCED_STORAGE_KEY,
  workerCardSummary,
  workerToolCallExpandedBody,
} from "./WorkersPanel";
import workersPanelSource from "./WorkersPanel.tsx?raw";
import {
  buildWorkerTimeline,
  isCanonicalWorkerAssignmentMessage,
  liveWorkerTiming,
  partitionWorkers,
  reconcileWorkerPanelSelection,
  resolveSelectedWorkerId,
  workerPanelLayout,
  workerToolCallCount,
} from "./workersPanel.logic";

const now = "2026-08-22T20:00:00.000Z";
const parentThreadId = ThreadId.make("parent-thread");
const providerInstanceId = ProviderInstanceId.make("codex");

afterEach(() => {
  vi.useRealTimers();
});

function worker(
  id: string,
  status: WorkerSummary["status"],
  updatedAt: string,
  overrides: Partial<WorkerSummary> = {},
): WorkerSummary {
  return {
    id: WorkerId.make(id),
    title: `Worker ${id}`,
    status,
    backend: "codex",
    parentThreadId,
    providerInstanceId,
    model: "gpt-5.6-sol",
    runtimeMode: "full-access",
    createdAt: now,
    updatedAt,
    lastActivityAt: updatedAt,
    unreadMessageCount: 0,
    activationCount: 1,
    resumable: true,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      totalTokens: 170,
      toolUses: 2,
    },
    ...overrides,
  };
}

const waiting = worker("waiting", "waitingApproval", "2026-08-22T20:04:00.000Z", {
  title: "Needs approval",
  hasPendingApproval: true,
  unreadMessageCount: 2,
});
const running = worker("running", "running", "2026-08-22T20:05:00.000Z", {
  latestObserverReport: {
    id: WorkerObserverReportId.make("report-progress"),
    workerId: WorkerId.make("running"),
    model: "gpt-5.6-sol",
    report: "Repository scan is underway.",
    progress: "Scanning provider boundaries",
    blockers: [],
    observedStatus: "running",
    readOnly: true,
    generatedAt: "2026-08-22T20:05:00.000Z",
  },
});
const completedOlder = worker("completed-old", "completed", "2026-08-22T19:00:00.000Z");
const completedNewer = worker("completed-new", "closed", "2026-08-22T19:30:00.000Z");

function detailFixture(): WorkerDetail {
  return {
    summary: running,
    assignment: "Inspect the provider boundary.",
    instructions: "Return a concise handoff.",
    context: {
      note: "Read-only inspection.",
      references: [{ path: "apps/server/src/provider" }],
      snippets: [],
    },
    messages: [
      {
        id: WorkerMessageId.make("message-parent"),
        workerId: running.id,
        author: "parent",
        kind: "assignment",
        body: "Check the runtime catalog.",
        createdAt: "2026-08-22T20:01:00.000Z",
      },
      {
        id: WorkerMessageId.make("message-worker"),
        workerId: running.id,
        author: "worker",
        kind: "handoff",
        body: "Catalog is isolated.",
        createdAt: "2026-08-22T20:04:00.000Z",
      },
    ],
    activities: [
      {
        id: EventId.make("activity-tool"),
        tone: "tool",
        kind: "tool.completed",
        title: "Read configuration",
        detail: "Inspected runtime flags.",
        result: "multi_agent=false",
        createdAt: "2026-08-22T20:02:00.000Z",
      },
      {
        id: EventId.make("activity-approval"),
        tone: "approval",
        kind: "approval.requested",
        title: "Approval requested",
        detail: "Run a command",
        createdAt: "2026-08-22T20:03:00.000Z",
      },
    ],
    activations: [],
    observerReports: [
      {
        id: WorkerObserverReportId.make("observer-1"),
        workerId: running.id,
        model: "gpt-5.6-sol",
        report: "No blocker found.",
        blockers: [],
        observedStatus: "running",
        readOnly: true,
        generatedAt: "2026-08-22T20:03:30.000Z",
      },
    ],
    pendingApproval: {
      requestId: ApprovalRequestId.make("approval-1"),
      workerId: running.id,
      activationId: WorkerActivationId.make("activation-1"),
      kind: "provider-request",
      summary: "Run a command",
      requestedAt: "2026-08-22T20:03:00.000Z",
      status: "pending",
    },
  };
}

function overviewFixture(): WorkerEfficiencyOverview {
  return {
    computedAt: "2026-08-22T20:00:03.000Z",
    workersCreated: 2,
    workersActive: 1,
    workersCompleted: 1,
    workersFailed: 0,
    workersInterrupted: 0,
    timing: {
      computedAt: "2026-08-22T20:00:03.000Z",
      totalWallTimeMs: 5_000,
      overallSpanMs: 3_000,
      busyTimeMs: 3_000,
      overlapTimeMs: 2_000,
      averageConcurrency: 5 / 3,
      peakConcurrency: 2,
      activeActivationCount: 1,
    },
    usage: {
      inputTokens: 1_200,
      cachedInputTokens: 700,
      outputTokens: 300,
      reasoningTokens: 0,
      totalTokens: 1_500,
    },
    usageCoverage: { status: "complete" },
    toolCalls: 3,
    completedToolCalls: 2,
    failedToolCalls: 1,
    unknownToolCalls: 0,
    tools: [
      { name: "exec_command", calls: 2, completed: 1, failed: 1, unknown: 0 },
      { name: "read_file", calls: 1, completed: 1, failed: 0, unknown: 0 },
    ],
    toolCoverage: { status: "partial", reason: "Older events are unavailable." },
    parentCoordinationCalls: 4,
    parentCoordinationCompleted: 3,
    parentCoordinationFailures: 0,
    parentCoordinationUnknown: 1,
    parentCoordinationTools: [
      { name: "worker_start", calls: 2, completed: 2, failed: 0, unknown: 0 },
      { name: "worker_wait", calls: 2, completed: 1, failed: 0, unknown: 1 },
    ],
    parentCoordinationCoverage: { status: "partial", reason: "One outcome is unavailable." },
    parentCoordinationTokenCoverage: {
      status: "unavailable",
      reason: "Usage is not attributed per tool call.",
    },
    workers: [
      {
        workerId: running.id,
        title: "Runtime audit",
        status: "running",
        model: "gpt-5.6-sol",
        backend: "codex",
        elapsedMs: 3_000,
        active: true,
        activations: 2,
        usage: running.usage,
        toolCalls: 2,
        completedToolCalls: 1,
        failedToolCalls: 1,
        unknownToolCalls: 0,
        tools: [{ name: "exec_command", calls: 2, completed: 1, failed: 1, unknown: 0 }],
        toolCoverage: { status: "complete" },
      },
    ],
  };
}

describe("WorkersPanel ordering and selection", () => {
  it("pins approval-needed and active Workers, then sorts recent Workers newest-first", () => {
    const sections = partitionWorkers([completedOlder, running, completedNewer, waiting]);
    expect(sections.active.map((entry) => entry.id)).toEqual([waiting.id, running.id]);
    expect(sections.recent.map((entry) => entry.id)).toEqual([
      completedNewer.id,
      completedOlder.id,
    ]);
    expect(resolveSelectedWorkerId(null, sections)).toBe(waiting.id);
    expect(resolveSelectedWorkerId(completedOlder.id, sections)).toBe(completedOlder.id);
    expect(resolveSelectedWorkerId(WorkerId.make("removed"), sections)).toBe(waiting.id);
    expect(
      reconcileWorkerPanelSelection(
        {
          selectedWorkerId: WorkerId.make("removed"),
          selectedSurface: "worker",
          narrowPage: "detail",
        },
        sections,
      ),
    ).toEqual({
      selectedWorkerId: null,
      selectedSurface: "overview",
      narrowPage: "overview",
    });
  });

  it("renders accessible Active and collapsible Recent rows with real indicators", () => {
    const markup = renderToStaticMarkup(
      <WorkerRail
        sections={partitionWorkers([completedNewer, running, waiting])}
        selectedWorkerId={running.id}
        recentOpen
        onRecentOpenChange={vi.fn()}
        onSelect={vi.fn()}
        nowMs={Date.parse("2026-08-22T20:05:03.000Z")}
      />,
    );
    expect(markup).toContain('aria-label="Workers in this task"');
    expect(markup).toContain("Active");
    expect(markup).toContain("Recent");
    expect(markup).toContain("Approval needed");
    expect(markup).toContain("2 unread Worker messages");
    expect(markup).toContain("Scanning provider boundaries");
    expect(markup).toContain("min-h-11");
  });
});

describe("WorkersPanel timeline", () => {
  it("merges persisted communication and sanitized activity in chronological order", () => {
    const timeline = buildWorkerTimeline(detailFixture());
    expect(timeline.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      "message:message-parent",
      "activity:activity-tool",
      "activity:activity-approval",
      "observer:observer-1",
      "message:message-worker",
    ]);
    expect(timeline.filter((entry) => entry.type === "approval")).toHaveLength(0);
  });

  it("suppresses only the canonical initial assignment payload", () => {
    const detail = detailFixture();
    const canonical: WorkerMessage = {
      id: WorkerMessageId.make("message-canonical-assignment"),
      workerId: running.id,
      author: "parent",
      kind: "assignment",
      body: detail.assignment,
      createdAt: "2026-08-22T20:00:01.000Z",
    };
    const firstResponse: WorkerMessage = {
      id: WorkerMessageId.make("message-first-response"),
      workerId: running.id,
      author: "worker",
      kind: "handoff",
      body: "First response remains visible.",
      createdAt: "2026-08-22T20:00:02.000Z",
    };
    const laterParent: WorkerMessage = {
      id: WorkerMessageId.make("message-later-parent"),
      workerId: running.id,
      author: "parent",
      kind: "followUp",
      body: "Keep the result focused.",
      createdAt: "2026-08-22T20:00:03.000Z",
    };
    const withCanonical = { ...detail, messages: [canonical, firstResponse, laterParent] };
    expect(isCanonicalWorkerAssignmentMessage(withCanonical, canonical)).toBe(true);
    expect(isCanonicalWorkerAssignmentMessage(withCanonical, firstResponse)).toBe(false);
    expect(
      buildWorkerTimeline(withCanonical)
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    ).toEqual([firstResponse.id, laterParent.id]);
    expect(buildWorkerTimeline(withCanonical).some((entry) => entry.id === canonical.id)).toBe(
      false,
    );
  });

  it("handles the legacy assignment-plus-context wrapper without hiding later parent text", () => {
    const detail = detailFixture();
    const canonical: WorkerMessage = {
      id: WorkerMessageId.make("message-legacy-assignment"),
      workerId: running.id,
      author: "parent",
      kind: "assignment",
      body: `Assignment:\n${detail.assignment}\nContext note:\n${detail.context.note}`,
      createdAt: "2026-08-22T20:00:01.000Z",
    };
    const laterParent: WorkerMessage = {
      id: WorkerMessageId.make("message-meaningful-parent"),
      workerId: running.id,
      author: "parent",
      kind: "assignment",
      body: "Same words, but a meaningful later parent message.",
      createdAt: "2026-08-22T20:00:02.000Z",
    };
    const withLegacy = { ...detail, messages: [canonical, laterParent] };
    expect(
      buildWorkerTimeline(withLegacy)
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    ).toEqual([laterParent.id]);
  });

  it("keeps a newer pending approval when only an older request activity exists", () => {
    const previous = detailFixture();
    const detail: WorkerDetail = {
      ...previous,
      pendingApproval: {
        ...previous.pendingApproval!,
        requestId: ApprovalRequestId.make("approval-new"),
        requestedAt: "2026-08-22T20:05:00.000Z",
        summary: "Approve the next command",
      },
    };
    const timeline = buildWorkerTimeline(detail);
    expect(timeline.at(-1)).toMatchObject({
      type: "approval",
      id: "approval-new",
      value: { summary: "Approve the next command" },
    });
  });

  it("renders assignment, messages, tool result, approval, observer report, and Back accessibly", () => {
    const markup = renderToStaticMarkup(
      <WorkerDetailView detail={detailFixture()} showBack onBack={vi.fn()} />,
    );
    expect(markup).toContain('aria-label="Back to Worker list"');
    expect(markup).toContain("Inspect the provider boundary.");
    expect(markup).toContain("Check the runtime catalog.");
    expect(markup).toContain("Read configuration");
    expect(markup).not.toContain("multi_agent=false");
    expect(markup).toContain("Approval requested");
    expect(markup).toContain("No blocker found.");
    expect(markup).toContain("Catalog is isolated.");
    expect(markup.indexOf("Check the runtime catalog.")).toBeLessThan(
      markup.indexOf("Read configuration"),
    );
    expect(markup.indexOf("Read configuration")).toBeLessThan(
      markup.indexOf("Catalog is isolated."),
    );
    expect(markup).toContain("bg-message");
    expect(markup).toContain("Conversation");
    expect(markup).toContain("1 tool");
    expect(markup).not.toContain("providerEvents");
    expect(markup).not.toContain("chain-of-thought");
  });

  it("counts logical lifecycle tool rows without counting progress notices", () => {
    const detail = detailFixture();
    expect(
      workerToolCallCount([
        { ...detail.activities[0]!, kind: "tool.started" },
        { ...detail.activities[0]!, id: EventId.make("tool-progress"), kind: "tool.progress" },
      ]),
    ).toBe(1);
  });

  it("uses one detail scroller and docks Conversation directly below the Worker header", () => {
    const markup = renderToStaticMarkup(
      <WorkerDetailView detail={detailFixture()} showBack onBack={vi.fn()} />,
    );

    expect(markup.match(/data-worker-detail-scroll-owner/g)).toHaveLength(1);
    expect(markup).toMatch(/data-worker-identity-header="true"[^>]*class="[^"]*shrink-0[^"]*"/);
    expect(markup).toMatch(
      /data-worker-conversation-heading="true"[^>]*class="[^"]*sticky top-0[^"]*"/,
    );
    expect(markup).not.toContain("top-[3.65rem]");
    expect(markup.indexOf("Assignment and context")).toBeLessThan(
      markup.indexOf("data-worker-conversation-heading"),
    );
  });

  it("renders a live elapsed and real provider usage summary at the true bottom", () => {
    const detail = detailFixture();
    const summary = {
      ...detail.summary,
      usage: {
        ...detail.summary.usage,
        inputTokens: 1_200,
        cachedInputTokens: 800,
        outputTokens: 345,
        totalTokens: 1_545,
      },
    };
    const markup = renderToStaticMarkup(
      <WorkerDetailView
        detail={{ ...detail, summary }}
        showBack
        onBack={vi.fn()}
        nowMs={Date.parse("2026-08-22T20:05:03.000Z")}
      />,
    );

    expect(markup).toContain("Total elapsed time");
    expect(markup).toContain("5m 03s");
    expect(markup).toContain("Reported total");
    expect(markup).toContain("1.5k");
    expect(markup).toContain("Reported input");
    expect(markup).toContain("1.2k");
    expect(markup).toContain("Reported output");
    expect(markup).toContain("345");
    expect(markup).toContain("Reported cached input");
    expect(markup).toContain("800");
    expect(markup.indexOf("Activation history")).toBeLessThan(
      markup.indexOf("data-worker-completion-summary"),
    );
  });

  it("keeps terminal duration stable and explains unavailable parent attribution", () => {
    const summary = worker("summary-closed", "closed", "2026-08-22T20:00:03.000Z", {
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 12,
      },
    });
    const renderSummary = (nowMs: number) =>
      renderToStaticMarkup(<WorkerCompletionSummary summary={summary} nowMs={nowMs} />);
    const first = renderSummary(Date.parse("2026-08-22T20:01:00.000Z"));
    const later = renderSummary(Date.parse("2026-08-22T21:00:00.000Z"));

    expect(first).toContain("3s");
    expect(later).toContain("3s");
    expect(first).not.toContain("Cached input");
    expect(first).toContain("Parent input attribution unavailable");
    expect(first).toContain('aria-label="Why parent input attribution is unavailable"');
    expect(PARENT_INPUT_ATTRIBUTION_UNAVAILABLE_REASON).toContain(
      "does not report a separate parent token count",
    );
    expect(first).toContain("size-11");
  });

  it("labels cumulative usage separately from the last model call", () => {
    const summary = worker("summary-complete", "completed", "2026-08-22T20:00:03.000Z", {
      usage: {
        inputTokens: 247_750,
        cachedInputTokens: 217_856,
        outputTokens: 2_199,
        reasoningTokens: 942,
        totalTokens: 249_949,
      },
      usageCoverage: { status: "complete" },
      lastModelCallUsage: {
        inputTokens: 35_882,
        cachedInputTokens: 34_560,
        outputTokens: 252,
        reasoningTokens: 0,
        totalTokens: 36_134,
      },
    });
    const markup = renderToStaticMarkup(
      <WorkerCompletionSummary summary={summary} nowMs={Date.parse(now)} />,
    );

    expect(markup).toContain("Cumulative Worker usage");
    expect(markup).toContain("Cumulative total");
    expect(markup).toContain("250k");
    expect(markup).toContain("Cumulative input");
    expect(markup).toContain("Last model call");
    expect(markup).toContain("36k");
    expect(markup).not.toContain("Last model call cumulative");
  });

  it("keeps sanitized tool details collapsed until the accessible row is expanded", () => {
    const activity = detailFixture().activities[0]!;
    const collapsed = renderToStaticMarkup(<WorkerToolCallRow activity={activity} />);
    const expanded = renderToStaticMarkup(
      <WorkerToolCallRow activity={activity} defaultExpanded />,
    );

    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-label="Expand tool call Read configuration"');
    expect(collapsed).not.toContain('title="Expand tool call Read configuration"');
    expect(collapsed).toContain("min-h-11");
    expect(collapsed).not.toContain("Inspected runtime flags.");
    expect(collapsed).not.toContain("multi_agent=false");

    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('aria-label="Collapse tool call Read configuration"');
    expect(expanded).toContain("Command or input");
    expect(expanded).toContain("Inspected runtime flags.");
    expect(expanded).toContain("Result");
    expect(expanded).toContain("multi_agent=false");
    expect(expanded).not.toContain("providerEvents");
    expect(expanded).not.toContain("chain-of-thought");
    expect(workerToolCallExpandedBody(activity)).toBe(
      "Command or input\nInspected runtime flags.\n\nResult\nmulti_agent=false",
    );
  });
});

describe("WorkersPanel elapsed time", () => {
  it("advances a running Worker from one shared local ticker", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-22T20:00:03.000Z");
    const clock = createWorkerElapsedClock();
    let ticks = 0;
    const unsubscribeFirst = clock.subscribe(() => ticks++);
    const unsubscribeSecond = clock.subscribe(vi.fn());

    const renderRunning = () =>
      renderToStaticMarkup(
        <WorkerRail
          sections={partitionWorkers([running])}
          selectedWorkerId={running.id}
          recentOpen
          onRecentOpenChange={vi.fn()}
          onSelect={vi.fn()}
          nowMs={clock.getSnapshot()}
        />,
      );

    expect(vi.getTimerCount()).toBe(1);
    expect(renderRunning()).toContain("3s");
    vi.advanceTimersByTime(2_000);
    expect(ticks).toBe(2);
    expect(renderRunning()).toContain("5s");

    unsubscribeFirst();
    expect(vi.getTimerCount()).toBe(1);
    unsubscribeSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a closed Worker's persisted duration fixed", () => {
    const closed = worker("closed-fixed", "closed", "2026-08-22T20:00:03.000Z");
    const renderClosed = (nowMs: number) =>
      renderToStaticMarkup(
        <WorkerRail
          sections={partitionWorkers([closed])}
          selectedWorkerId={closed.id}
          recentOpen
          onRecentOpenChange={vi.fn()}
          onSelect={vi.fn()}
          nowMs={nowMs}
        />,
      );

    expect(renderClosed(Date.parse("2026-08-22T20:01:00.000Z"))).toContain("3s");
    expect(renderClosed(Date.parse("2026-08-22T21:00:00.000Z"))).toContain("3s");
  });
});

describe("WorkersPanel delegation overview", () => {
  it("renders exact totals, formulas, coordination counts, and neutral per-Worker comparison", () => {
    const markup = renderToStaticMarkup(
      <WorkerEfficiencyOverviewView
        overview={overviewFixture()}
        nowMs={Date.parse("2026-08-22T20:00:05.000Z")}
        onSelectWorker={vi.fn()}
        showWorkerList={vi.fn()}
      />,
    );
    expect(markup).toContain("Delegation overview");
    expect(markup).toContain("What this task’s parent delegated");
    expect(markup).toContain("Worker wall time");
    expect(markup).toContain("Parallel overlap");
    expect(markup).toContain("Peak concurrency");
    expect(markup).toContain("Parent coordination");
    expect(markup).toContain("3 completed");
    expect(markup).toContain("0 failed");
    expect(markup).toContain("1 unknown");
    expect(markup).toContain("Parent turn usage unavailable");
    expect(markup).toContain("Runtime audit");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain('aria-label="Open Worker Runtime audit detail"');
    expect(markup).not.toMatch(/winner|score|recommend|rank/i);
    expect(markup).toContain("exec_command");
    expect(markup).toContain("<details");
  });

  it("advances canonical active timing while preserving overlap math", () => {
    const initial = overviewFixture().timing;
    const advanced = liveWorkerTiming(initial, Date.parse("2026-08-22T20:00:05.000Z"));
    expect(advanced).toMatchObject({
      totalWallTimeMs: 7_000,
      overallSpanMs: 5_000,
      busyTimeMs: 5_000,
      overlapTimeMs: 2_000,
      peakConcurrency: 2,
      activeActivationCount: 1,
    });
    expect(
      liveWorkerTiming(
        { ...initial, activeActivationCount: 0 },
        Date.parse("2026-08-22T21:00:00.000Z"),
      ),
    ).toEqual({
      ...initial,
      activeActivationCount: 0,
    });
  });
});

describe("WorkersPanel responsive read-only boundary", () => {
  it("uses master-detail only when the measured panel is at least 620px", () => {
    expect(workerPanelLayout(390)).toBe("drill-in");
    expect(workerPanelLayout(619)).toBe("drill-in");
    expect(workerPanelLayout(620)).toBe("master-detail");
    expect(workerPanelLayout(900)).toBe("master-detail");
    expect(workersPanelSource).toContain('useState<"overview" | "list" | "detail">("overview")');
    expect(workersPanelSource).toContain('useState<"overview" | "worker">("overview")');
    expect(workersPanelSource).toContain("onSelectWorker={selectWorker}");
    expect(workersPanelSource).toContain("showWorkerList");
    expect(workersPanelSource).toContain("Back to Worker list");
    expect(workersPanelSource).toContain("size-11");
    expect(workersPanelSource).toContain("overflow-x-hidden");
    expect(workersPanelSource).toContain("data-worker-detail-surface");
    expect(workersPanelSource).toContain("safe-area-inset-top");
    expect(workersPanelSource).toContain('narrowPage !== "detail"');
    expect(workersPanelSource).toContain("data-worker-compact-scroll-owner");
    expect(workersPanelSource).toContain("showAdvanced");
    expect(workersPanelSource).toContain("aria-pressed={showAdvanced}");
    expect(workersPanelSource).toContain("useLocalStorage");
    expect(WORKERS_ADVANCED_STORAGE_KEY).toBe("t3code:workers:advanced");
  });

  it("shows the persisted Worker handoff when no observer report exists", () => {
    expect(
      workerCardSummary({
        latestDirectMessage: {
          body: "WORKER READY",
          createdAt: "2026-08-22T16:00:00.000Z",
        } as WorkerMessage,
      }),
    ).toBe("WORKER READY");
  });

  it("has no human lifecycle or approval-response controls", () => {
    for (const forbidden of [
      "workerEnvironment.start",
      "workerEnvironment.send",
      "workerEnvironment.wait",
      "workerEnvironment.interrupt",
      "workerEnvironment.close",
      "workerEnvironment.respondToApproval",
      "Follow-up assignment",
      "submitStart",
    ]) {
      expect(workersPanelSource).not.toContain(forbidden);
    }
    expect(workersPanelSource).toContain("Read-only view");
  });
});
