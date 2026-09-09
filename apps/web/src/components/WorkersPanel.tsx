import type {
  EnvironmentId,
  ThreadId,
  WorkerActivity,
  WorkerComparisonMetrics,
  WorkerDetail,
  WorkerEfficiencyOverview,
  WorkerId,
  WorkerMessage,
  WorkerStatus,
  WorkerSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Eye,
  Info,
  ListTree,
  MessageSquare,
  Wrench,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { workerListInput } from "@t3tools/client-runtime/state/workers";
import { useEnvironmentQuery } from "../state/query";
import { workerEnvironment } from "../state/workers";
import { cn } from "../lib/utils";
import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  ACTIVE_WORKER_STATUSES,
  buildWorkerTimeline,
  liveWorkerTiming,
  partitionWorkers,
  reconcileWorkerPanelSelection,
  workerPanelLayout,
  workerToolCallCount,
  type WorkerSections,
  type WorkerTimelineEntry,
} from "./workersPanel.logic";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import ChatMarkdown from "./ChatMarkdown";

const EMPTY_WORKERS: ReadonlyArray<WorkerSummary> = [];
const WORKER_ELAPSED_TICK_MS = 1_000;
export const WORKERS_ADVANCED_STORAGE_KEY = "t3code:workers:advanced";
export const PARENT_INPUT_ATTRIBUTION_UNAVAILABLE_REASON =
  "Provider usage combines parent-supplied content with system instructions, tool output, and later Worker input; it does not report a separate parent token count.";

export function createWorkerElapsedClock(readNow: () => number = Date.now) {
  let current = readNow();
  let interval: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  const tick = () => {
    current = readNow();
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        current = readNow();
        interval = setInterval(tick, WORKER_ELAPSED_TICK_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && interval !== undefined) {
          clearInterval(interval);
          interval = undefined;
        }
      };
    },
  };
}

const workerElapsedClock = createWorkerElapsedClock();
const noopClockSubscribe = () => () => {};
const inactiveClockSnapshot = () => 0;

function useWorkerElapsedNow(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? workerElapsedClock.subscribe : noopClockSubscribe,
    enabled ? workerElapsedClock.getSnapshot : inactiveClockSnapshot,
    enabled ? workerElapsedClock.getSnapshot : inactiveClockSnapshot,
  );
}

const STATUS_LABELS: Record<WorkerStatus, string> = {
  starting: "Starting",
  running: "Working",
  waitingApproval: "Approval needed",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  lost: "Lost",
  closed: "Closed",
};

const STATUS_DOTS: Record<WorkerStatus, string> = {
  starting: "bg-info",
  running: "bg-info",
  waitingApproval: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-muted-foreground",
  lost: "bg-destructive",
  closed: "bg-muted-foreground/50",
};

export function workerStatusLabel(status: WorkerStatus): string {
  return STATUS_LABELS[status];
}

export function workerCardSummary(
  worker: Pick<WorkerSummary, "latestDirectMessage" | "latestObserverReport">,
): string {
  const directMessage = worker.latestDirectMessage?.body.trim();
  const observerReport =
    worker.latestObserverReport?.progress?.trim() || worker.latestObserverReport?.report.trim();

  if (directMessage && observerReport) {
    return Date.parse(worker.latestDirectMessage!.createdAt) >=
      Date.parse(worker.latestObserverReport!.generatedAt)
      ? directMessage
      : observerReport;
  }
  return directMessage || observerReport || "Awaiting worker report";
}

export function workerPrimaryName(worker: Pick<WorkerSummary, "displayName" | "title">): string {
  return worker.displayName ?? worker.title;
}

function formatTokens(total: number): string {
  if (total < 1_000) return `${total}`;
  if (total < 1_000_000) return `${(total / 1_000).toFixed(total < 10_000 ? 1 : 0)}k`;
  return `${(total / 1_000_000).toFixed(1)}m`;
}

function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedLabel(startedAt: string, endedAt: string | undefined, nowMs: number): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function dateTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function StatusPill({ status }: { status: WorkerStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[.7rem] text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOTS[status])} />
      {workerStatusLabel(status)}
    </span>
  );
}

function WorkerAvatar({ worker }: { worker: Pick<WorkerSummary, "id" | "displayName" | "title"> }) {
  const label = workerPrimaryName(worker);
  let hash = 0;
  for (const character of `${worker.id}:${label}`) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 text-[.65rem] font-semibold text-white shadow-inner"
      style={{
        background: `linear-gradient(145deg, hsl(${hue} 55% 52%), hsl(${(hue + 42) % 360} 48% 32%))`,
      }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WorkerCompletionSummary({
  summary,
  nowMs,
}: {
  summary: WorkerSummary;
  nowMs: number;
}) {
  const active = ACTIVE_WORKER_STATUSES.has(summary.status);
  const elapsed = elapsedLabel(summary.createdAt, active ? undefined : summary.updatedAt, nowMs);
  const usage = summary.usage;
  const cumulativeUsage = summary.usageCoverage?.status === "complete";
  const lastModelCall = summary.lastModelCallUsage;

  return (
    <section
      data-worker-completion-summary
      aria-labelledby="worker-completion-summary-heading"
      className="rounded-md border border-border/50 bg-card/20 px-3 py-2.5"
    >
      <h4
        id="worker-completion-summary-heading"
        className="text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        Worker summary
      </h4>
      <h5 className="mt-2 text-[.65rem] font-medium text-muted-foreground">
        {cumulativeUsage ? "Cumulative Worker usage" : "Reported Worker usage (partial)"}
      </h5>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <div className="min-w-24">
          <dt className="text-[.65rem] text-muted-foreground">Total elapsed time</dt>
          <dd className="mt-0.5 font-mono tabular-nums">{elapsed}</dd>
        </div>
        <div className="min-w-24">
          <dt className="text-[.65rem] text-muted-foreground">
            {cumulativeUsage ? "Cumulative total" : "Reported total"}
          </dt>
          <dd className="mt-0.5 font-mono tabular-nums">{formatTokens(usage.totalTokens)}</dd>
        </div>
        <div className="min-w-20">
          <dt className="text-[.65rem] text-muted-foreground">
            {cumulativeUsage ? "Cumulative input" : "Reported input"}
          </dt>
          <dd className="mt-0.5 font-mono tabular-nums">{formatTokens(usage.inputTokens)}</dd>
        </div>
        <div className="min-w-20">
          <dt className="text-[.65rem] text-muted-foreground">
            {cumulativeUsage ? "Cumulative output" : "Reported output"}
          </dt>
          <dd className="mt-0.5 font-mono tabular-nums">{formatTokens(usage.outputTokens)}</dd>
        </div>
        {usage.cachedInputTokens !== undefined ? (
          <div className="min-w-24">
            <dt className="text-[.65rem] text-muted-foreground">
              {cumulativeUsage ? "Cumulative cached input" : "Reported cached input"}
            </dt>
            <dd className="mt-0.5 font-mono tabular-nums">
              {formatTokens(usage.cachedInputTokens)}
            </dd>
          </div>
        ) : null}
      </dl>
      {cumulativeUsage ? (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/40 pt-2 text-xs">
          <div className="min-w-24">
            <dt className="text-[.65rem] text-muted-foreground">Cumulative reasoning</dt>
            <dd className="mt-0.5 font-mono tabular-nums">{formatTokens(usage.reasoningTokens)}</dd>
          </div>
        </dl>
      ) : null}
      {lastModelCall ? (
        <div className="mt-2 border-t border-border/40 pt-2">
          <h5 className="text-[.65rem] font-medium text-muted-foreground">Last model call</h5>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-2 text-xs">
            <div className="min-w-20">
              <dt className="text-[.65rem] text-muted-foreground">Total</dt>
              <dd className="mt-0.5 font-mono tabular-nums">
                {formatTokens(lastModelCall.totalTokens)}
              </dd>
            </div>
            <div className="min-w-20">
              <dt className="text-[.65rem] text-muted-foreground">Input</dt>
              <dd className="mt-0.5 font-mono tabular-nums">
                {formatTokens(lastModelCall.inputTokens)}
              </dd>
            </div>
            {lastModelCall.cachedInputTokens !== undefined ? (
              <div className="min-w-24">
                <dt className="text-[.65rem] text-muted-foreground">Cached input</dt>
                <dd className="mt-0.5 font-mono tabular-nums">
                  {formatTokens(lastModelCall.cachedInputTokens)}
                </dd>
              </div>
            ) : null}
            <div className="min-w-20">
              <dt className="text-[.65rem] text-muted-foreground">Output</dt>
              <dd className="mt-0.5 font-mono tabular-nums">
                {formatTokens(lastModelCall.outputTokens)}
              </dd>
            </div>
            <div className="min-w-20">
              <dt className="text-[.65rem] text-muted-foreground">Reasoning</dt>
              <dd className="mt-0.5 font-mono tabular-nums">
                {formatTokens(lastModelCall.reasoningTokens)}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-center border-t border-border/40 pt-1.5 text-[.7rem] text-muted-foreground">
        <span className="min-w-0">Parent input attribution unavailable</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Why parent input attribution is unavailable"
                className="-my-2 ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <Info aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{PARENT_INPUT_ATTRIBUTION_UNAVAILABLE_REASON}</TooltipPopup>
        </Tooltip>
      </div>
    </section>
  );
}

function CoverageNote({
  label,
  coverage,
}: {
  label: string;
  coverage: WorkerEfficiencyOverview["toolCoverage"];
}) {
  if (coverage.status === "complete") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${coverage.status}`}
            className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <Info aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>{coverage.reason ?? `${label} is ${coverage.status}.`}</TooltipPopup>
    </Tooltip>
  );
}

function ToolBreakdown({
  tools,
  label,
}: {
  tools: WorkerEfficiencyOverview["tools"];
  label: string;
}) {
  return (
    <details className="group min-w-0">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 -rotate-90 transition-transform group-open:rotate-0"
        />
        <span>{label}</span>
        <span className="ml-auto font-mono text-[.65rem]">{tools.length}</span>
      </summary>
      <div className="space-y-1 border-s border-border/50 py-1 ps-3 text-[.7rem]">
        {tools.length === 0 ? (
          <p className="text-muted-foreground">No calls recorded.</p>
        ) : (
          tools.map((tool) => (
            <div key={tool.name} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono">{tool.name}</span>
              <span className="shrink-0 text-muted-foreground">{tool.calls} calls</span>
              {tool.completed > 0 ? (
                <span className="shrink-0 text-muted-foreground">{tool.completed} completed</span>
              ) : null}
              {tool.failed > 0 ? (
                <span className="shrink-0 text-destructive-foreground">{tool.failed} failed</span>
              ) : null}
              {tool.unknown > 0 ? (
                <span className="shrink-0 text-warning-foreground">{tool.unknown} unknown</span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

export function WorkerComparisonRow({
  worker,
  nowMs,
  computedAt,
  onOpen,
}: {
  worker: WorkerComparisonMetrics;
  nowMs: number;
  computedAt: string;
  onOpen: (workerId: WorkerId) => void;
}) {
  const computedAtMs = Date.parse(computedAt);
  const liveElapsed =
    worker.elapsedMs +
    (worker.active && Number.isFinite(computedAtMs) ? Math.max(0, nowMs - computedAtMs) : 0);
  return (
    <article data-worker-comparison-card className="rounded-md border border-border/50 bg-card/15">
      <button
        type="button"
        onClick={() => onOpen(worker.workerId)}
        aria-label={`Open Worker ${worker.displayName ?? worker.title} detail`}
        className="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-t-md px-2.5 text-left text-xs hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          {worker.displayName ?? worker.title}
        </span>
        <StatusPill status={worker.status} />
        <span className="shrink-0 font-mono text-[.65rem] text-muted-foreground">
          {formatTokens(worker.usage.totalTokens)} cumulative tok
        </span>
        <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <div className="space-y-2 border-t border-border/45 px-3 py-2 text-[.7rem]">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {worker.displayName && worker.displayName !== worker.title ? (
            <span className="text-foreground/80">Assignment: {worker.title}</span>
          ) : null}
          <span>{worker.model}</span>
          <span>{worker.backend}</span>
          <span>{formatDurationMs(liveElapsed)}</span>
          <span>{worker.activations} activations</span>
          <span>{worker.toolCalls} tool calls</span>
          {worker.failedToolCalls > 0 ? <span>{worker.failedToolCalls} failed</span> : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[.65rem] text-muted-foreground">
          <span>cumulative in {formatTokens(worker.usage.inputTokens)}</span>
          <span>cumulative out {formatTokens(worker.usage.outputTokens)}</span>
          {worker.usage.cachedInputTokens !== undefined ? (
            <span>cumulative cached {formatTokens(worker.usage.cachedInputTokens)}</span>
          ) : null}
          <span>cumulative reasoning {formatTokens(worker.usage.reasoningTokens)}</span>
        </div>
        {worker.lastModelCallUsage ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[.65rem] text-muted-foreground">
            <span className="font-sans font-medium">last model call</span>
            <span>in {formatTokens(worker.lastModelCallUsage.inputTokens)}</span>
            {worker.lastModelCallUsage.cachedInputTokens !== undefined ? (
              <span>cached {formatTokens(worker.lastModelCallUsage.cachedInputTokens)}</span>
            ) : null}
            <span>out {formatTokens(worker.lastModelCallUsage.outputTokens)}</span>
            <span>reasoning {formatTokens(worker.lastModelCallUsage.reasoningTokens)}</span>
          </div>
        ) : null}
        {worker.parentTurnUsage ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[.65rem] text-muted-foreground">
            <span className="font-sans font-medium">Parent turn usage</span>
            <span>total {formatTokens(worker.parentTurnUsage.totalTokens)}</span>
            <span>in {formatTokens(worker.parentTurnUsage.inputTokens)}</span>
            {worker.parentTurnUsage.cachedInputTokens !== undefined ? (
              <span>cached {formatTokens(worker.parentTurnUsage.cachedInputTokens)}</span>
            ) : null}
            <span>out {formatTokens(worker.parentTurnUsage.outputTokens)}</span>
            <span>reasoning {formatTokens(worker.parentTurnUsage.reasoningTokens)}</span>
          </div>
        ) : null}
        <ToolBreakdown tools={worker.tools} label="Tool breakdown" />
      </div>
    </article>
  );
}

export function WorkerEfficiencyOverviewView({
  overview,
  nowMs,
  onSelectWorker,
  showWorkerList,
}: {
  overview: WorkerEfficiencyOverview;
  nowMs: number;
  onSelectWorker: (workerId: WorkerId) => void;
  showWorkerList?: () => void;
}) {
  const timing = liveWorkerTiming(overview.timing, nowMs);
  return (
    <ScrollArea data-worker-overview-scroll-owner className="min-h-0 min-w-0 flex-1">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-3 py-4 pb-8 sm:px-5">
        <header className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Delegation overview</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              What this task’s parent delegated to Workers, how long it ran, and what it cost.
            </p>
          </div>
          {showWorkerList ? (
            <button
              type="button"
              onClick={showWorkerList}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ListTree aria-hidden className="size-3.5" /> Workers
            </button>
          ) : null}
        </header>

        <section aria-labelledby="worker-task-totals-heading">
          <h4 id="worker-task-totals-heading" className="sr-only">
            Task totals
          </h4>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["Created", overview.workersCreated],
              ["Active", overview.workersActive],
              ["Completed", overview.workersCompleted],
              ["Failed", overview.workersFailed],
              ["Interrupted", overview.workersInterrupted],
              ["Tool calls", overview.toolCalls],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-border/50 bg-card/20 px-2.5 py-2"
              >
                <dt className="text-[.65rem] text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          className="rounded-md border border-border/50 bg-card/15 p-3"
          aria-labelledby="worker-time-heading"
        >
          <div className="flex items-center gap-1">
            <h4 id="worker-time-heading" className="text-xs font-medium">
              Time and concurrency
            </h4>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="How Worker overlap and concurrency are calculated"
                    className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <Info aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>
                Wall time sums every activation interval. Busy time is the union of those intervals.
                Overlap is wall time minus busy time. Average concurrency is wall time divided by
                busy time.
              </TooltipPopup>
            </Tooltip>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-[.65rem] text-muted-foreground">Worker wall time</dt>
              <dd className="font-mono tabular-nums">{formatDurationMs(timing.totalWallTimeMs)}</dd>
            </div>
            <div>
              <dt className="text-[.65rem] text-muted-foreground">Overall span</dt>
              <dd className="font-mono tabular-nums">{formatDurationMs(timing.overallSpanMs)}</dd>
            </div>
            <div>
              <dt className="text-[.65rem] text-muted-foreground">Parallel overlap</dt>
              <dd className="font-mono tabular-nums">{formatDurationMs(timing.overlapTimeMs)}</dd>
            </div>
            <div>
              <dt className="text-[.65rem] text-muted-foreground">Peak concurrency</dt>
              <dd className="font-mono tabular-nums">{timing.peakConcurrency}</dd>
            </div>
            <div>
              <dt className="text-[.65rem] text-muted-foreground">Average concurrency</dt>
              <dd className="font-mono tabular-nums">{timing.averageConcurrency.toFixed(2)}×</dd>
            </div>
          </dl>
        </section>

        <section className="grid gap-2 sm:grid-cols-2" aria-label="Worker cost and coordination">
          <div className="rounded-md border border-border/50 bg-card/15 p-3">
            <div className="flex items-center gap-1">
              <h4 className="text-xs font-medium">
                {overview.usageCoverage.status === "complete"
                  ? "Cumulative Worker tokens"
                  : "Reported Worker tokens (partial)"}
              </h4>
              <CoverageNote label="Worker token coverage" coverage={overview.usageCoverage} />
            </div>
            <p className="mt-1 font-mono text-lg tabular-nums">
              {formatTokens(overview.usage.totalTokens)}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[.65rem] text-muted-foreground">
              <span>
                {overview.usageCoverage.status === "complete" ? "cumulative in" : "reported in"}{" "}
                {formatTokens(overview.usage.inputTokens)}
              </span>
              <span>
                {overview.usageCoverage.status === "complete" ? "cumulative out" : "reported out"}{" "}
                {formatTokens(overview.usage.outputTokens)}
              </span>
              {overview.usage.cachedInputTokens !== undefined ? (
                <span>
                  {overview.usageCoverage.status === "complete"
                    ? "cumulative cached"
                    : "reported cached"}{" "}
                  {formatTokens(overview.usage.cachedInputTokens)}
                </span>
              ) : null}
              <span>
                {overview.usageCoverage.status === "complete"
                  ? "cumulative reasoning"
                  : "reported reasoning"}{" "}
                {formatTokens(overview.usage.reasoningTokens)}
              </span>
            </div>
          </div>
          <div className="rounded-md border border-border/50 bg-card/15 p-3">
            <div className="flex items-center gap-1">
              <h4 className="text-xs font-medium">Parent coordination</h4>
              <CoverageNote
                label="Parent coordination coverage"
                coverage={overview.parentCoordinationCoverage}
              />
            </div>
            <p className="mt-1 font-mono text-lg tabular-nums">
              {overview.parentCoordinationCalls}
            </p>
            <p className="text-[.65rem] text-muted-foreground">
              {overview.parentCoordinationCompleted} completed ·{" "}
              {overview.parentCoordinationFailures} failed
              {overview.parentCoordinationUnknown > 0
                ? ` · ${overview.parentCoordinationUnknown} unknown`
                : ""}
            </p>
            <div className="mt-1 flex items-center text-[.65rem] text-muted-foreground">
              {overview.parentTurnUsageCoverage?.status === "complete"
                ? "Parent turn usage is shown per Worker"
                : "Parent turn usage unavailable"}
              <CoverageNote
                label="Parent turn usage"
                coverage={
                  overview.parentTurnUsageCoverage ?? overview.parentCoordinationTokenCoverage
                }
              />
            </div>
          </div>
        </section>

        <section
          aria-labelledby="worker-tool-totals-heading"
          className="rounded-md border border-border/50 bg-card/15 p-2"
        >
          <div className="flex items-center px-1">
            <h4 id="worker-tool-totals-heading" className="text-xs font-medium">
              Tool calls
            </h4>
            <span className="ml-auto text-[.65rem] text-muted-foreground">
              {overview.completedToolCalls} completed · {overview.failedToolCalls} failed
              {overview.unknownToolCalls > 0 ? ` · ${overview.unknownToolCalls} unknown` : ""}
            </span>
            <CoverageNote label="Worker tool coverage" coverage={overview.toolCoverage} />
          </div>
          <ToolBreakdown tools={overview.tools} label="Worker tool breakdown" />
          <ToolBreakdown
            tools={overview.parentCoordinationTools}
            label="Parent coordination breakdown"
          />
        </section>

        <section aria-labelledby="worker-comparison-heading" className="space-y-2">
          <h4 id="worker-comparison-heading" className="text-xs font-medium">
            Workers
          </h4>
          {overview.workers.length === 0 ? (
            <p className="rounded-md border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
              No Workers have been created for this task.
            </p>
          ) : (
            overview.workers.map((worker) => (
              <WorkerComparisonRow
                key={worker.workerId}
                worker={worker}
                nowMs={nowMs}
                computedAt={overview.computedAt}
                onOpen={onSelectWorker}
              />
            ))
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function WorkerRow({
  worker,
  selected,
  onSelect,
  nowMs,
}: {
  worker: WorkerSummary;
  selected: boolean;
  onSelect: () => void;
  nowMs: number;
}) {
  const approvalNeeded = worker.status === "waitingApproval" || worker.hasPendingApproval === true;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      aria-label={`Inspect Worker ${worker.displayName ?? worker.title}`}
      className={cn(
        "group flex min-h-14 w-full items-center gap-2.5 border-b border-border/45 px-3 py-2 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-accent/70",
      )}
    >
      <WorkerAvatar worker={worker} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {workerPrimaryName(worker)}
          </span>
          <span className="shrink-0 font-mono text-[.68rem] text-muted-foreground tabular-nums">
            {elapsedLabel(
              worker.createdAt,
              ACTIVE_WORKER_STATUSES.has(worker.status) ? undefined : worker.updatedAt,
              nowMs,
            )}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[.68rem] text-muted-foreground">
          <StatusPill status={worker.status} />
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">
            {worker.latestObserverReport?.progress?.trim() ||
              worker.title ||
              workerCardSummary(worker)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {approvalNeeded ? (
          <AlertTriangle
            aria-label="Approval needed"
            className="size-3.5 shrink-0 text-warning-foreground"
          />
        ) : null}
        {worker.unreadMessageCount > 0 ? (
          <span
            aria-label={`${worker.unreadMessageCount} unread Worker messages`}
            className="min-w-4 rounded-full bg-info px-1 text-center text-[.65rem] font-semibold text-white"
          >
            {worker.unreadMessageCount}
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function WorkerRail({
  sections,
  selectedWorkerId,
  recentOpen,
  onRecentOpenChange,
  onSelect,
  nowMs,
}: {
  sections: WorkerSections;
  selectedWorkerId: WorkerId | null;
  recentOpen: boolean;
  onRecentOpenChange: (open: boolean) => void;
  onSelect: (workerId: WorkerId) => void;
  nowMs: number;
}) {
  return (
    <nav aria-label="Workers in this task" className="min-w-0">
      <section aria-labelledby="active-workers-heading">
        <div
          id="active-workers-heading"
          className="sticky top-0 z-10 border-b border-border/50 bg-background/95 px-3 py-2 text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur"
        >
          Active <span className="ml-1 font-mono">{sections.active.length}</span>
        </div>
        {sections.active.length > 0 ? (
          sections.active.map((worker) => (
            <WorkerRow
              key={worker.id}
              worker={worker}
              selected={worker.id === selectedWorkerId}
              onSelect={() => onSelect(worker.id)}
              nowMs={nowMs}
            />
          ))
        ) : (
          <p className="px-3 py-3 text-xs text-muted-foreground">No active Workers.</p>
        )}
      </section>

      {sections.recent.length > 0 ? (
        <Collapsible open={recentOpen} onOpenChange={onRecentOpenChange}>
          <section aria-labelledby="recent-workers-heading">
            <CollapsibleTrigger
              id="recent-workers-heading"
              className="sticky top-0 z-10 flex min-h-11 w-full items-center border-y border-border/50 bg-background/95 px-3 text-left text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={`${recentOpen ? "Collapse" : "Expand"} recent Workers`}
            >
              Recent <span className="ml-1 font-mono">{sections.recent.length}</span>
              <ChevronDown
                aria-hidden
                className={cn("ml-auto size-3.5 transition-transform", recentOpen && "rotate-180")}
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              {sections.recent.map((worker) => (
                <WorkerRow
                  key={worker.id}
                  worker={worker}
                  selected={worker.id === selectedWorkerId}
                  onSelect={() => onSelect(worker.id)}
                  nowMs={nowMs}
                />
              ))}
            </CollapsibleContent>
          </section>
        </Collapsible>
      ) : null}
    </nav>
  );
}

function WorkerMessageFlow({ message, cwd }: { message: WorkerMessage; cwd?: string }) {
  const isParent = message.author === "parent";
  if (message.author === "observer" || message.author === "system") {
    return (
      <article className="mx-1 border-s border-info/40 ps-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider">
          <Eye aria-hidden className="size-3" />
          {message.author === "observer" ? "Observer" : "System"}
          <time className="ml-auto shrink-0 font-normal normal-case" dateTime={message.createdAt}>
            {dateTimeLabel(message.createdAt)}
          </time>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{message.body}</p>
      </article>
    );
  }

  return (
    <article className={cn("group min-w-0", isParent && "flex flex-col items-end gap-1")}>
      <div
        className={cn(
          "min-w-0",
          isParent
            ? "max-w-[85%] rounded-2xl bg-message p-3 text-message-foreground"
            : "w-full px-1 py-0.5",
        )}
      >
        <ChatMarkdown text={message.body} cwd={cwd} />
      </div>
      <div
        className={cn(
          "flex items-center gap-1.5 px-1 text-[.65rem] text-muted-foreground tabular-nums",
          isParent ? "justify-end" : "justify-start",
        )}
      >
        {isParent ? <span>Parent</span> : <Bot aria-hidden className="size-3" />}
        {!isParent ? <span>Worker</span> : null}
        <span aria-hidden>·</span>
        <Tooltip>
          <TooltipTrigger render={<time dateTime={message.createdAt} tabIndex={0} />}>
            {dateTimeLabel(message.createdAt)}
          </TooltipTrigger>
          <TooltipPopup>Message timestamp</TooltipPopup>
        </Tooltip>
      </div>
    </article>
  );
}

export function workerToolCallExpandedBody(activity: WorkerActivity): string | null {
  const blocks: string[] = [];
  if (activity.detail?.trim()) blocks.push(`Command or input\n${activity.detail.trim()}`);
  if (activity.result?.trim()) blocks.push(`Result\n${activity.result.trim()}`);
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function WorkerToolCallRow({
  activity,
  defaultExpanded = false,
}: {
  activity: WorkerActivity;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const detailsId = useId();
  const body = workerToolCallExpandedBody(activity);
  const canExpand = body !== null;
  const failed = activity.tone === "error" || activity.kind.includes("failed");
  const completed = activity.kind === "tool.completed" || activity.kind === "tool.summary";
  const controlLabel = `${expanded ? "Collapse" : "Expand"} tool call ${activity.title}`;

  return (
    <div className="min-w-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={!canExpand}
              aria-expanded={canExpand ? expanded : undefined}
              aria-controls={canExpand ? detailsId : undefined}
              aria-label={canExpand ? controlLabel : activity.title}
              onClick={() => setExpanded((current) => !current)}
              className={cn(
                "flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs transition-colors",
                canExpand &&
                  "hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              )}
            />
          }
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-icon-muted">
            <Wrench aria-hidden className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{activity.title}</span>
          <time
            className="shrink-0 text-[.65rem] text-muted-foreground tabular-nums"
            dateTime={activity.createdAt}
          >
            {dateTimeLabel(activity.createdAt)}
          </time>
          <span className="flex size-4 shrink-0 items-center justify-center text-icon-muted">
            {failed ? (
              <X aria-label="Tool call failed" className="size-3 text-destructive" />
            ) : completed ? (
              <Check aria-label="Tool call completed" className="size-3" />
            ) : (
              <Clock3 aria-label="Tool call in progress" className="size-3" />
            )}
          </span>
          {canExpand ? (
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-icon-muted transition-transform",
                expanded && "rotate-180",
              )}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup>{canExpand ? controlLabel : "No additional tool details"}</TooltipPopup>
      </Tooltip>
      {expanded && body ? (
        <div id={detailsId} className="ms-7 border-s border-border/45 ps-3 pt-1">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text">
            {body}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ActivityNotice({ activity }: { activity: WorkerActivity }) {
  return (
    <article
      className={cn(
        "mx-1 border-s ps-3 text-xs",
        activity.tone === "error"
          ? "border-destructive/60 text-destructive-foreground"
          : activity.tone === "approval"
            ? "border-warning/60 text-warning-foreground"
            : "border-info/40 text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Activity aria-hidden className="size-3" />
        <span className="min-w-0 flex-1 truncate font-medium">{activity.title}</span>
        <time className="shrink-0 text-[.65rem] tabular-nums" dateTime={activity.createdAt}>
          {dateTimeLabel(activity.createdAt)}
        </time>
      </div>
      {activity.detail ? (
        <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{activity.detail}</p>
      ) : null}
    </article>
  );
}

function TimelineEntry({ entry, cwd }: { entry: WorkerTimelineEntry; cwd?: string }) {
  if (entry.type === "message") {
    return <WorkerMessageFlow message={entry.value} {...(cwd ? { cwd } : {})} />;
  }
  if (entry.type === "activity") {
    return entry.value.tone === "tool" ? (
      <WorkerToolCallRow activity={entry.value} />
    ) : (
      <ActivityNotice activity={entry.value} />
    );
  }
  if (entry.type === "observer") {
    return (
      <article className="mx-1 border-s border-info/45 ps-3 text-xs">
        <div className="flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-info-foreground">
          <Eye aria-hidden className="size-3" /> Observer report
          <time className="ml-auto font-normal normal-case" dateTime={entry.value.generatedAt}>
            {dateTimeLabel(entry.value.generatedAt)}
          </time>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">
          {entry.value.report}
        </p>
        {entry.value.blockers.length > 0 ? (
          <p className="mt-1 text-[.7rem] text-warning-foreground">
            Blockers: {entry.value.blockers.join(" · ")}
          </p>
        ) : null}
      </article>
    );
  }
  return (
    <article className="mx-1 border-s border-warning/60 ps-3 text-xs">
      <div className="flex items-center gap-1.5 text-[.7rem] font-medium">
        <AlertTriangle aria-hidden className="size-3.5" /> Approval requested
      </div>
      <p className="mt-1 text-xs">{entry.value.summary}</p>
      <p className="mt-1 text-[.7rem] text-muted-foreground">
        The parent agent must resolve this request.
      </p>
    </article>
  );
}

export function WorkerDetailView({
  detail,
  showBack,
  onBack,
  nowMs = Date.now(),
}: {
  detail: WorkerDetail;
  showBack: boolean;
  onBack: () => void;
  nowMs?: number;
}) {
  const summary = detail.summary;
  const active = ACTIVE_WORKER_STATUSES.has(summary.status);
  const timeline = buildWorkerTimeline(detail);
  const toolCalls = workerToolCallCount(detail.activities);

  return (
    <div
      data-worker-detail-surface
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overscroll-contain"
    >
      <div
        data-worker-identity-header
        className="z-20 shrink-0 border-b border-border/60 bg-background/95 px-3 pb-2.5 pt-[max(env(safe-area-inset-top),0.625rem)] backdrop-blur"
      >
        <div className="flex min-w-0 items-start gap-2">
          {showBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to Worker list"
              className="-ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft aria-hidden className="size-4" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold">{workerPrimaryName(summary)}</h3>
            <p className="mt-0.5 truncate text-[.7rem] text-muted-foreground">
              Assignment: {summary.title}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusPill status={summary.status} />
              <span className="font-mono text-[.65rem] text-muted-foreground">{summary.model}</span>
              <span className="font-mono text-[.65rem] text-muted-foreground">
                {summary.runtimeMode}
              </span>
              {summary.workingDirectory ? (
                <span className="min-w-0 truncate font-mono text-[.65rem] text-muted-foreground">
                  {summary.workingDirectory}
                </span>
              ) : summary.environmentId ? (
                <span className="font-mono text-[.65rem] text-muted-foreground">
                  {summary.environmentId}
                </span>
              ) : null}
            </div>
          </div>
          <span className="shrink-0 font-mono text-[.65rem] text-muted-foreground">
            {formatTokens(summary.usage.totalTokens)} tok
          </span>
        </div>
      </div>

      <ScrollArea data-worker-detail-scroll-owner className="min-h-0 min-w-0 flex-1 touch-pan-y">
        <div className="mx-auto min-w-0 w-full max-w-3xl space-y-5 px-3 py-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] sm:px-5">
          <details open className="group rounded-md border border-border/50 bg-card/20">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <ChevronDown
                aria-hidden
                className="size-3.5 transition-transform group-open:rotate-180"
              />
              Assignment and context
            </summary>
            <section
              aria-labelledby="worker-overview-heading"
              className="border-t border-border/45 p-3"
            >
              <h4 id="worker-overview-heading" className="sr-only">
                Assignment and context
              </h4>
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                {detail.assignment}
              </p>
              {detail.instructions?.trim() ? (
                <p className="mt-2 whitespace-pre-wrap border-t border-border/50 pt-2 text-xs leading-relaxed">
                  {detail.instructions}
                </p>
              ) : null}
              {detail.context.note?.trim() ? (
                <p className="mt-2 text-xs text-muted-foreground">{detail.context.note}</p>
              ) : null}
              {detail.context.references.length > 0 ? (
                <ul className="mt-2 space-y-1 font-mono text-[.65rem] text-muted-foreground">
                  {detail.context.references.map((reference) => (
                    <li
                      key={`${reference.path}:${reference.lineStart ?? ""}:${reference.lineEnd ?? ""}:${reference.symbol ?? ""}:${reference.excerpt ?? ""}`}
                      className="break-all"
                    >
                      {reference.path}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </details>

          <section aria-labelledby="worker-metrics-heading">
            <h4 id="worker-metrics-heading" className="sr-only">
              Worker status and usage
            </h4>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-border/45 py-2 text-[.7rem] text-muted-foreground">
              <span>
                Elapsed{" "}
                {elapsedLabel(summary.createdAt, active ? undefined : summary.updatedAt, nowMs)}
              </span>
              <span>{summary.activationCount} activations</span>
              <span>
                {toolCalls} {toolCalls === 1 ? "tool" : "tools"}
              </span>
              <span>{summary.backend}</span>
            </div>
          </section>

          <section aria-labelledby="worker-timeline-heading" className="space-y-3">
            <div
              data-worker-conversation-heading
              className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/45 bg-background/95 py-2 text-[.65rem] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur"
            >
              <MessageSquare aria-hidden className="size-3" />
              <h4 id="worker-timeline-heading">Conversation</h4>
            </div>
            {timeline.length > 0 ? (
              timeline.map((entry) => (
                <TimelineEntry
                  key={`${entry.type}:${entry.id}`}
                  entry={entry}
                  {...(summary.workingDirectory ? { cwd: summary.workingDirectory } : {})}
                />
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                No Worker activity yet.
              </p>
            )}
          </section>

          <details className="group rounded-md border border-border/50">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <CircleDot aria-hidden className="size-3" />
              Activation history
              <span className="font-mono text-[.65rem]">{detail.activations.length}</span>
              <ChevronDown
                aria-hidden
                className="ml-auto size-3.5 transition-transform group-open:rotate-180"
              />
            </summary>
            <section
              aria-labelledby="worker-activations-heading"
              className="space-y-2 border-t border-border/45 p-3"
            >
              <h4 id="worker-activations-heading" className="sr-only">
                Activation history
              </h4>
              {detail.activations.map((activation) => (
                <article
                  key={activation.id}
                  className="rounded-md border border-border/50 p-2 text-[.7rem]"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusPill status={activation.status} />
                    <span className="text-muted-foreground">
                      {dateTimeLabel(activation.startedAt)} ·{" "}
                      {elapsedLabel(
                        activation.startedAt,
                        activation.finishedAt ?? (active ? undefined : summary.updatedAt),
                        nowMs,
                      )}
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-[.65rem] text-muted-foreground">
                    Parent turn {activation.parentTurnId ?? "—"} · Worker thread{" "}
                    {activation.providerThreadId}
                  </p>
                  {activation.handoff?.trim() ? (
                    <p className="mt-1 whitespace-pre-wrap break-words">{activation.handoff}</p>
                  ) : null}
                  {activation.error?.trim() ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-destructive-foreground">
                      {activation.error}
                    </p>
                  ) : null}
                </article>
              ))}
            </section>
          </details>

          <p className="text-center text-[.7rem] text-muted-foreground">
            Read-only view. The parent agent owns Worker creation and control.
          </p>
          <WorkerCompletionSummary summary={summary} nowMs={nowMs} />
        </div>
      </ScrollArea>
    </div>
  );
}

function useWorkerPanelLayout() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<"master-detail" | "drill-in">("drill-in");
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setLayout(workerPanelLayout(root.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return { rootRef, layout };
}

export function WorkersPanel({
  environmentId,
  parentThreadId,
  enabled = true,
}: {
  environmentId: EnvironmentId;
  parentThreadId: ThreadId;
  enabled?: boolean;
}) {
  const [selectedWorkerId, setSelectedWorkerId] = useState<WorkerId | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<"overview" | "worker">("overview");
  const [recentOpen, setRecentOpen] = useState(true);
  const [narrowPage, setNarrowPage] = useState<"overview" | "list" | "detail">("overview");
  const [showAdvanced, setShowAdvanced] = useLocalStorage(
    WORKERS_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const { rootRef, layout } = useWorkerPanelLayout();
  const listQuery = useEnvironmentQuery(
    enabled
      ? workerEnvironment.list({ environmentId, input: workerListInput(parentThreadId) })
      : null,
  );
  const detailQuery = useEnvironmentQuery(
    enabled && selectedWorkerId
      ? workerEnvironment.detail({ environmentId, input: { workerId: selectedWorkerId } })
      : null,
  );
  const liveEvents = useAtomValue(
    workerEnvironment.events({ environmentId, input: { parentThreadId, includeClosed: true } }),
  );
  const workers = listQuery.data?.workers ?? EMPTY_WORKERS;
  const sections = useMemo(() => partitionWorkers(workers), [workers]);
  const elapsedNow = useWorkerElapsedNow(sections.active.length > 0);
  const orderedWorkers = useMemo(() => [...sections.active, ...sections.recent], [sections]);
  const eventConnected = liveEvents._tag === "Success" || liveEvents.waiting;
  const selected = orderedWorkers.find((worker) => worker.id === selectedWorkerId) ?? null;
  const isMasterDetail = layout === "master-detail";
  const overview = listQuery.data?.overview;
  const displayNow =
    elapsedNow ||
    (overview && Number.isFinite(Date.parse(overview.computedAt))
      ? Date.parse(overview.computedAt)
      : Date.now());

  useEffect(() => {
    if (selectedWorkerId === null) return;
    const reconciled = reconcileWorkerPanelSelection(
      { selectedWorkerId, selectedSurface, narrowPage },
      sections,
    );
    if (reconciled.selectedWorkerId === selectedWorkerId) return;
    setSelectedWorkerId(reconciled.selectedWorkerId);
    setSelectedSurface(reconciled.selectedSurface);
    setNarrowPage(reconciled.narrowPage);
  }, [narrowPage, sections, selectedSurface, selectedWorkerId]);

  useEffect(() => {
    if (liveEvents._tag !== "Success") return;
    listQuery.refresh();
    if (selectedWorkerId !== null) detailQuery.refresh();
  }, [detailQuery.refresh, listQuery.refresh, liveEvents, selectedWorkerId]);

  const aggregate = useMemo(
    () => ({
      active: sections.active.length,
    }),
    [sections.active.length],
  );

  if (!enabled) return null;

  const selectWorker = (workerId: WorkerId) => {
    setSelectedWorkerId(workerId);
    setSelectedSurface("worker");
    setNarrowPage("detail");
  };

  const selectOverview = () => {
    setSelectedSurface("overview");
    setNarrowPage("overview");
  };

  const detailContent =
    detailQuery.data && detailQuery.data.summary.id === selected?.id ? (
      <WorkerDetailView
        detail={detailQuery.data}
        showBack={!isMasterDetail}
        onBack={() => setNarrowPage("list")}
        nowMs={displayNow}
      />
    ) : (
      <div className="flex h-full min-h-52 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {selected
          ? detailQuery.isPending
            ? "Loading Worker detail…"
            : (detailQuery.error ?? "Select a Worker to inspect its timeline.")
          : "Select a Worker to inspect its assignment, messages, activity, status, and results."}
      </div>
    );

  const compactContent = (
    <ScrollArea data-worker-compact-scroll-owner className="min-h-0 min-w-0 flex-1">
      <div className="mx-auto w-full max-w-2xl py-1">
        <WorkerRail
          sections={sections}
          selectedWorkerId={selectedSurface === "worker" ? selectedWorkerId : null}
          recentOpen={recentOpen}
          onRecentOpenChange={setRecentOpen}
          onSelect={selectWorker}
          nowMs={displayNow}
        />
      </div>
    </ScrollArea>
  );

  const overviewContent =
    showAdvanced && overview ? (
      <WorkerEfficiencyOverviewView
        overview={overview}
        nowMs={displayNow}
        onSelectWorker={selectWorker}
        {...(!isMasterDetail ? { showWorkerList: () => setNarrowPage("list") } : {})}
      />
    ) : showAdvanced ? (
      <div className="flex h-full min-h-52 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {listQuery.isPending
          ? "Loading Worker overview…"
          : (listQuery.error ?? "Worker metrics are unavailable for this task.")}
      </div>
    ) : (
      compactContent
    );

  const listContent = (
    <ScrollArea
      className={cn(
        "h-full min-h-0 min-w-0 overflow-x-hidden",
        isMasterDetail ? "w-60 shrink-0 border-r border-border/60" : "w-full",
      )}
    >
      {!isMasterDetail ? (
        <button
          type="button"
          onClick={selectOverview}
          className="sticky top-0 z-10 flex min-h-11 w-full items-center gap-2 border-b border-border/60 bg-background/95 px-3 text-xs text-muted-foreground backdrop-blur hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden className="size-4" /> Overview
        </button>
      ) : (
        <button
          type="button"
          aria-current={selectedSurface === "overview" ? "page" : undefined}
          onClick={selectOverview}
          className={cn(
            "flex min-h-11 w-full items-center gap-2 border-b border-border/45 px-3 text-left text-xs hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            selectedSurface === "overview" && "bg-accent/45 text-foreground",
          )}
        >
          <BarChart3 aria-hidden className="size-3.5" />
          <span className="font-medium">Overview</span>
        </button>
      )}
      {listQuery.isPending && workers.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">Loading Workers…</p>
      ) : null}
      {listQuery.error ? (
        <p className="p-3 text-xs text-destructive-foreground">{listQuery.error}</p>
      ) : null}
      {!listQuery.isPending && !listQuery.error && workers.length === 0 ? (
        <p className="p-5 text-center text-xs text-muted-foreground">
          No Workers for this task yet.
        </p>
      ) : null}
      <WorkerRail
        sections={sections}
        selectedWorkerId={selectedSurface === "worker" ? selectedWorkerId : null}
        recentOpen={recentOpen}
        onRecentOpenChange={setRecentOpen}
        onSelect={selectWorker}
        nowMs={displayNow}
      />
    </ScrollArea>
  );

  return (
    <div
      ref={rootRef}
      data-layout={layout}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden"
    >
      {isMasterDetail || narrowPage !== "detail" ? (
        <header data-worker-panel-header className="shrink-0 border-b border-border/60 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Activity aria-hidden className="size-3.5 text-info-foreground" />
            <span className="text-sm font-semibold">Workers</span>
            <span className="shrink-0 text-[.68rem] text-muted-foreground">
              {aggregate.active} active
            </span>
            <button
              type="button"
              aria-pressed={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
              className="ml-auto inline-flex min-h-11 items-center rounded-md border border-border/60 px-2.5 text-[.7rem] font-medium text-muted-foreground hover:bg-accent/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
            >
              {showAdvanced ? "Compact" : "Advanced"}
            </button>
            <span
              aria-label={eventConnected ? "Live Worker updates" : "Waiting for Worker updates"}
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                eventConnected ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
          </div>
          <p className="mt-1.5 text-[.7rem] text-muted-foreground">
            {showAdvanced
              ? "Usage, tools, models, lifecycle events, and parent coordination."
              : "Read-only activity from Workers created by this task’s parent agent."}
          </p>
        </header>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {isMasterDetail && selectedSurface === "worker" ? listContent : null}
        <div className="h-full min-h-0 min-w-0 flex-1">
          {isMasterDetail
            ? selectedSurface === "overview"
              ? overviewContent
              : detailContent
            : narrowPage === "overview"
              ? overviewContent
              : narrowPage === "list"
                ? listContent
                : detailContent}
        </div>
      </div>
    </div>
  );
}
