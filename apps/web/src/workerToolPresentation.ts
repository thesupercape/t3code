import {
  T3_WORKER_TOOL_NAMES,
  type OrchestrationThreadActivity,
  type T3WorkerToolName,
  type WorkerStatus,
} from "@t3tools/contracts";

export { T3_WORKER_TOOL_NAMES, type T3WorkerToolName } from "@t3tools/contracts";
export type WorkerToolCallState = "inProgress" | "completed" | "failed" | "unknown";

export interface WorkerToolIdentity {
  readonly id: string;
  readonly name: string;
  readonly assignment?: string;
  readonly status?: WorkerStatus;
  readonly model?: string;
}

export interface WorkerToolCallPresentation {
  readonly toolName: T3WorkerToolName;
  readonly action: string;
  readonly state: WorkerToolCallState;
  readonly workerIds: ReadonlyArray<string>;
  readonly workers: ReadonlyArray<WorkerToolIdentity>;
  readonly assignment?: string;
  readonly resultSummary?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly callId?: string;
  readonly timeoutMillis?: number;
  readonly mode?: string;
  readonly wakeReasons?: ReadonlyArray<string>;
  readonly wakeReason?: string;
  readonly resultingStatus?: WorkerStatus;
  readonly waitAttempts?: ReadonlyArray<WorkerWaitAttemptPresentation>;
  /** Complete projected MCP data, shown only in Advanced/details UI. */
  readonly rawData?: unknown;
}

export interface WorkerWaitAttemptPresentation {
  readonly callId?: string;
  readonly workerIds: ReadonlyArray<string>;
  readonly state: WorkerToolCallState;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly timeoutMillis?: number;
  readonly mode?: string;
  readonly wakeReasons: ReadonlyArray<string>;
  readonly wakeReason?: string;
  readonly resultingStatus?: WorkerStatus;
  readonly rawData?: unknown;
}

export interface ActiveWorkerWait extends WorkerToolCallPresentation {
  readonly toolName: "worker_wait";
  readonly timeoutMillis?: number;
  readonly mode?: string;
  readonly wakeReasons: ReadonlyArray<string>;
  readonly untilStatuses?: ReadonlyArray<WorkerStatus>;
  readonly deadlineAt?: string;
  readonly latestEvent?: string;
}

const ACTIONS: Record<T3WorkerToolName, string> = {
  worker_start: "Started",
  worker_list: "Listed",
  worker_status: "Checked status for",
  worker_observe: "Observed",
  worker_send: "Sent follow-up to",
  worker_wait: "Waiting on",
  worker_interrupt: "Interrupted",
  worker_close: "Closed",
  worker_approval_respond: "Responded to approval for",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectOrJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return record(value);
}

function workerName(worker: Record<string, unknown>): string | undefined {
  return text(worker.displayName) ?? text(worker.title) ?? text(worker.name);
}

function workerStatus(value: unknown): WorkerStatus | undefined {
  return value === "starting" ||
    value === "running" ||
    value === "waitingApproval" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "lost" ||
    value === "closed"
    ? value
    : undefined;
}

function workerFromValue(value: unknown): WorkerToolIdentity | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const id = text(entry.id) ?? text(entry.workerId);
  const name = workerName(entry);
  if (!id || !name) return undefined;
  // WorkerSummary records use `title` for the bounded assignment, while
  // worker_start records may carry the full assignment field. Keep either
  // shape available to the active-wait disclosure without guessing at prose.
  const assignment = text(entry.assignment) ?? text(entry.title);
  const status = workerStatus(entry.status);
  const model = text(entry.model);
  return {
    id,
    name,
    ...(assignment ? { assignment } : {}),
    ...(status ? { status } : {}),
    ...(model ? { model } : {}),
  };
}

function toolData(activity: OrchestrationThreadActivity):
  | {
      readonly payload: Record<string, unknown>;
      readonly data: Record<string, unknown>;
      readonly item?: Record<string, unknown>;
      readonly args?: Record<string, unknown>;
      readonly result?: Record<string, unknown>;
      readonly toolName?: T3WorkerToolName;
      readonly callId?: string;
    }
  | undefined {
  const payload = record(activity.payload);
  const data = record(payload?.data);
  if (!payload || !data) return undefined;
  const item = record(data.item);
  const rawToolName = text(item?.tool) ?? text(data.toolName) ?? text(payload.title);
  const toolName = T3_WORKER_TOOL_NAMES.find(
    (name) => rawToolName === name || rawToolName?.endsWith(`_${name}`),
  );
  if (!toolName || payload.itemType !== "mcp_tool_call") return undefined;
  const args = objectOrJson(item?.arguments ?? data.input ?? item?.input);
  const result = objectOrJson(item?.result ?? data.result);
  const callId = text(data.toolCallId);
  return {
    payload,
    data,
    ...(item ? { item } : {}),
    ...(args ? { args } : {}),
    ...(result ? { result } : {}),
    toolName,
    ...(callId ? { callId } : {}),
  };
}

function lifecycleState(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
  item?: Record<string, unknown>,
): WorkerToolCallState {
  const rawStatus = text(payload.status) ?? text(item?.status);
  if (rawStatus === "failed" || rawStatus === "declined" || activity.tone === "error") {
    return "failed";
  }
  if (rawStatus === "completed" || activity.kind === "tool.completed") return "completed";
  if (
    rawStatus === "inProgress" ||
    rawStatus === "in_progress" ||
    activity.kind === "tool.updated"
  ) {
    return "inProgress";
  }
  return "unknown";
}

function resultWorkers(result: Record<string, unknown> | undefined): WorkerToolIdentity[] {
  if (!result) return [];
  const summary = workerFromValue(result.summary);
  const workers = Array.isArray(result.workers)
    ? result.workers
        .map(workerFromValue)
        .filter((item): item is WorkerToolIdentity => item !== undefined)
    : [];
  return summary ? [summary, ...workers] : workers;
}

function idsFromArgs(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const ids = Array.isArray(args.workerIds)
    ? args.workerIds.map((id) => text(id)).filter((id): id is string => id !== undefined)
    : [];
  const workerId = text(args.workerId);
  if (workerId) ids.push(workerId);
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

function resultSummary(
  toolName: T3WorkerToolName,
  result: Record<string, unknown> | undefined,
  workers: ReadonlyArray<WorkerToolIdentity>,
): string | undefined {
  if (toolName === "worker_list" && workers.length > 0) return `${workers.length} Workers returned`;
  const status = text(result?.status) ?? text(result?.summary && record(result.summary)?.status);
  const reason = text(result?.reason) ?? text(result?.wakeReason);
  if (reason && status) return `${status}, ${reason}`;
  if (reason) return reason;
  if (status) return status;
  return text(result?.message) ?? text(result?.summary);
}

const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "lost",
  "closed",
]);

export function formatWorkerDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return undefined;
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 === 0
      ? `${minutes}m`
      : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatWorkerTimeout(timeoutMillis: number | undefined): string | undefined {
  return formatWorkerDuration(timeoutMillis);
}

export function workerWaitWakeReasonLabel(reason: string | undefined): string | undefined {
  switch (reason) {
    case "message":
      return "progress event";
    case "statusChanged":
      return "status change";
    case "approvalRequested":
      return "approval request";
    case "completed":
      return "completion";
    case "failed":
      return "failure";
    case "interrupted":
      return "interruption";
    case "closed":
      return "closed";
    case "lost":
      return "lost";
    case "expired":
      return "timeout";
    case "userInput":
      return "user input";
    default:
      return text(reason);
  }
}

function isoElapsedMs(startedAt: string, endedAt: string | undefined): number | undefined {
  if (!endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function waitAttemptFromCall(
  call: WorkerToolCallPresentation,
): WorkerWaitAttemptPresentation | undefined {
  if (call.toolName !== "worker_wait") return undefined;
  return {
    ...(call.callId ? { callId: call.callId } : {}),
    workerIds: call.workerIds,
    state: call.state,
    startedAt: call.startedAt,
    ...(call.endedAt ? { endedAt: call.endedAt } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.timeoutMillis !== undefined ? { timeoutMillis: call.timeoutMillis } : {}),
    ...(call.mode ? { mode: call.mode } : {}),
    wakeReasons: call.wakeReasons ?? [],
    ...(call.wakeReason ? { wakeReason: call.wakeReason } : {}),
    ...(call.resultingStatus ? { resultingStatus: call.resultingStatus } : {}),
    ...(call.rawData !== undefined ? { rawData: call.rawData } : {}),
  };
}

function mergeWaitAttempt(
  previous: WorkerWaitAttemptPresentation,
  next: WorkerWaitAttemptPresentation,
): WorkerWaitAttemptPresentation {
  const endedAt = next.endedAt ?? previous.endedAt;
  const durationMs =
    next.durationMs ?? previous.durationMs ?? isoElapsedMs(previous.startedAt, endedAt);
  return {
    ...previous,
    ...next,
    startedAt:
      Date.parse(previous.startedAt) <= Date.parse(next.startedAt)
        ? previous.startedAt
        : next.startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    workerIds: next.workerIds.length > 0 ? next.workerIds : previous.workerIds,
    wakeReasons: next.wakeReasons.length > 0 ? next.wakeReasons : previous.wakeReasons,
  };
}

export function mergeWorkerToolCallPresentations(
  previous: WorkerToolCallPresentation,
  next: WorkerToolCallPresentation,
): WorkerToolCallPresentation {
  if (previous.toolName !== next.toolName) return next;
  const startedAt =
    Date.parse(previous.startedAt) <= Date.parse(next.startedAt)
      ? previous.startedAt
      : next.startedAt;
  const endedAt = next.endedAt ?? previous.endedAt;
  const durationMs = next.durationMs ?? previous.durationMs ?? isoElapsedMs(startedAt, endedAt);
  const previousAttempts = previous.waitAttempts ?? [];
  const nextAttempts = next.waitAttempts ?? [];
  let waitAttempts: ReadonlyArray<WorkerWaitAttemptPresentation> | undefined;
  if (next.toolName === "worker_wait") {
    const incoming = nextAttempts.at(0) ?? waitAttemptFromCall(next);
    const existing = previousAttempts.at(-1) ?? waitAttemptFromCall(previous);
    if (existing && incoming) {
      const sameAttempt =
        (existing.callId !== undefined && existing.callId === incoming.callId) ||
        (existing.callId === undefined &&
          incoming.callId === undefined &&
          existing.state === "inProgress" &&
          incoming.endedAt !== undefined);
      waitAttempts = sameAttempt
        ? [...previousAttempts.slice(0, -1), mergeWaitAttempt(existing, incoming)]
        : [...previousAttempts, incoming];
    } else {
      waitAttempts = [...previousAttempts, ...nextAttempts];
    }
  }
  const previousWhileActive =
    next.state === "inProgress"
      ? (({
          endedAt: _endedAt,
          durationMs: _durationMs,
          wakeReason: _wakeReason,
          resultingStatus: _resultingStatus,
          resultSummary: _resultSummary,
          ...activePrevious
        }) => activePrevious)(previous)
      : previous;
  return {
    ...previousWhileActive,
    ...next,
    startedAt,
    ...(next.state === "inProgress" ? {} : endedAt ? { endedAt } : {}),
    ...(next.state === "inProgress" ? {} : durationMs !== undefined ? { durationMs } : {}),
    workerIds: next.workerIds.length > 0 ? next.workerIds : previous.workerIds,
    workers: next.workers.length > 0 ? next.workers : previous.workers,
    ...(next.assignment
      ? { assignment: next.assignment }
      : previous.assignment
        ? { assignment: previous.assignment }
        : {}),
    ...(next.rawData !== undefined
      ? { rawData: next.rawData }
      : previous.rawData !== undefined
        ? { rawData: previous.rawData }
        : {}),
    ...(waitAttempts ? { waitAttempts } : {}),
  };
}

export function workerWaitRowLabel(call: WorkerToolCallPresentation): string {
  const name = workerToolDisplayName(call);
  const elapsed = formatWorkerDuration(call.durationMs) ?? "—";
  if (call.state === "inProgress") {
    const timeout = formatWorkerTimeout(call.timeoutMillis);
    return `Waiting on ${name}${timeout ? `, up to ${timeout}` : ""}`;
  }
  if (call.wakeReason === "expired" || call.resultSummary === "expired") {
    return `Timed out after ${elapsed}`;
  }
  if (call.resultingStatus === "completed" || call.wakeReason === "completed") {
    return `Worker finished after ${elapsed}`;
  }
  const reason = workerWaitWakeReasonLabel(call.wakeReason) ?? "an event";
  return `Woke after ${elapsed}, ${reason}`;
}

export function parseWorkerToolActivity(
  activity: OrchestrationThreadActivity,
  knownWorkers: ReadonlyMap<string, WorkerToolIdentity> = new Map(),
): WorkerToolCallPresentation | null {
  const parsed = toolData(activity);
  if (!parsed || !parsed.toolName) return null;
  const resultWorkersFound = resultWorkers(parsed.result);
  const ids = idsFromArgs(parsed.args);
  const workers = [
    ...resultWorkersFound,
    ...ids
      .map((id) => knownWorkers.get(id))
      .filter((item): item is WorkerToolIdentity => item !== undefined),
  ].filter((worker, index, all) => all.findIndex((item) => item.id === worker.id) === index);
  const assignment =
    text(parsed.result?.assignment) ??
    text(record(parsed.result?.summary)?.title) ??
    text(parsed.args?.assignment) ??
    text(parsed.args?.title);
  const ended =
    lifecycleState(activity, parsed.payload, parsed.item) === "inProgress"
      ? undefined
      : activity.createdAt;
  const durationMs = number(parsed.item?.durationMs) ?? number(parsed.data.durationMs);
  const summary = resultSummary(parsed.toolName, parsed.result, workers);
  const state = lifecycleState(activity, parsed.payload, parsed.item);
  const timeoutMillis =
    parsed.toolName === "worker_wait" ? number(parsed.args?.timeoutMillis) : undefined;
  const mode = parsed.toolName === "worker_wait" ? text(parsed.args?.mode) : undefined;
  const wakeReason =
    parsed.toolName === "worker_wait"
      ? (text(parsed.result?.reason) ??
        text(record(parsed.result?.lease)?.wakeReason) ??
        (Array.isArray(parsed.result?.events)
          ? text(record(parsed.result.events[0])?.reason)
          : undefined))
      : undefined;
  const resultingStatus =
    parsed.toolName === "worker_wait"
      ? (workerStatus(
          Array.isArray(parsed.result?.events)
            ? record(parsed.result.events[0])?.status
            : undefined,
        ) ?? workers.find((worker) => worker.status !== undefined)?.status)
      : undefined;
  const wakeReasons =
    parsed.toolName === "worker_wait" && Array.isArray(parsed.args?.wakeReasons)
      ? parsed.args.wakeReasons.filter((reason): reason is string => typeof reason === "string")
      : [];
  const waitAttempt =
    parsed.toolName === "worker_wait"
      ? {
          ...(parsed.callId ? { callId: parsed.callId } : {}),
          workerIds: ids,
          state,
          startedAt: activity.createdAt,
          ...(ended ? { endedAt: ended } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(timeoutMillis !== undefined ? { timeoutMillis } : {}),
          ...(mode ? { mode } : {}),
          wakeReasons,
          ...(wakeReason ? { wakeReason } : {}),
          ...(resultingStatus ? { resultingStatus } : {}),
          rawData: parsed.item ?? parsed.data,
        }
      : undefined;
  return {
    toolName: parsed.toolName,
    action: ACTIONS[parsed.toolName],
    state,
    workerIds: ids.length > 0 ? ids : workers.map((worker) => worker.id),
    workers,
    ...(assignment ? { assignment } : {}),
    ...(summary ? { resultSummary: summary } : {}),
    startedAt: activity.createdAt,
    ...(ended ? { endedAt: ended } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(parsed.callId ? { callId: parsed.callId } : {}),
    ...(timeoutMillis !== undefined ? { timeoutMillis } : {}),
    ...(mode ? { mode } : {}),
    ...(parsed.toolName === "worker_wait" ? { wakeReasons } : {}),
    ...(wakeReason ? { wakeReason } : {}),
    ...(resultingStatus ? { resultingStatus } : {}),
    ...(waitAttempt ? { waitAttempts: [waitAttempt] } : {}),
    rawData: parsed.item ?? parsed.data,
  };
}

function callKey(call: WorkerToolCallPresentation): string {
  // MCP adapters normally provide toolCallId. The fallback deliberately
  // omits the timestamp so a legacy completion can close its in-progress
  // wait even when one side of the record lost the id.
  return call.callId ?? `${call.toolName}:${call.workerIds.join(",")}`;
}

export function deriveWorkerToolCallPresentations(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<WorkerToolCallPresentation> {
  const knownWorkers = new Map<string, WorkerToolIdentity>();
  const calls: WorkerToolCallPresentation[] = [];
  const identifiedCallIndexes = new Map<string, number>();
  for (const activity of [...activities].toSorted(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  )) {
    const call = parseWorkerToolActivity(activity, knownWorkers);
    if (!call) continue;
    for (const worker of call.workers) knownWorkers.set(worker.id, worker);
    const key = callKey(call);
    const identifiedIndex = call.callId !== undefined ? identifiedCallIndexes.get(key) : undefined;
    if (identifiedIndex !== undefined) {
      calls[identifiedIndex] = mergeWorkerToolCallPresentations(calls[identifiedIndex]!, call);
      continue;
    }
    const previous = calls.at(-1);
    const previousKey = previous ? callKey(previous) : undefined;
    const canMergeLegacyLifecycle =
      call.callId === undefined &&
      previousKey === key &&
      previous?.toolName === call.toolName &&
      previous.state === "inProgress" &&
      call.state !== "inProgress";
    if (canMergeLegacyLifecycle && previous) {
      calls[calls.length - 1] = mergeWorkerToolCallPresentations(previous, call);
      continue;
    }
    calls.push(call);
    if (call.callId !== undefined) identifiedCallIndexes.set(key, calls.length - 1);
  }
  return calls;
}

export function deriveActiveWorkerWait(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  nowMs = Date.now(),
): ActiveWorkerWait | null {
  const knownWorkers = new Map<string, WorkerToolIdentity>();
  const active = new Map<string, ActiveWorkerWait>();
  const ordered = [...activities].toSorted((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  for (const activity of ordered) {
    const call = parseWorkerToolActivity(activity);
    if (!call) continue;
    for (const worker of call.workers) knownWorkers.set(worker.id, worker);
  }
  for (const activity of ordered) {
    const parsed = toolData(activity);
    if (!parsed || parsed.toolName !== "worker_wait") continue;
    const call = parseWorkerToolActivity(activity, knownWorkers);
    if (!call) continue;
    const args = parsed.args;
    const key = callKey(call);
    if (call.state === "inProgress") {
      const timeoutMillis = number(args?.timeoutMillis);
      const mode = text(args?.mode);
      const untilStatuses = Array.isArray(args?.until)
        ? args.until.filter((status): status is WorkerStatus => workerStatus(status) !== undefined)
        : [];
      const startedAtMs = Date.parse(activity.createdAt);
      const deadlineMs =
        timeoutMillis !== undefined && Number.isFinite(startedAtMs)
          ? startedAtMs + timeoutMillis
          : undefined;
      if (deadlineMs !== undefined && nowMs >= deadlineMs) {
        active.delete(key);
        continue;
      }
      const deadlineAt = deadlineMs !== undefined ? new Date(deadlineMs).toISOString() : undefined;
      const seconds = Number.isFinite(startedAtMs)
        ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000))
        : 0;
      active.set(key, {
        ...call,
        toolName: "worker_wait",
        ...(timeoutMillis !== undefined ? { timeoutMillis } : {}),
        ...(mode ? { mode } : {}),
        wakeReasons: Array.isArray(args?.wakeReasons)
          ? args.wakeReasons.filter((reason): reason is string => typeof reason === "string")
          : [],
        untilStatuses,
        ...(deadlineAt ? { deadlineAt } : {}),
        latestEvent: seconds > 0 ? `No wake event yet · ${seconds}s elapsed` : "No wake event yet",
      });
    } else {
      active.delete(key);
    }
  }
  return [...active.values()].at(-1) ?? null;
}

export function workerToolDisplayName(call: WorkerToolCallPresentation): string {
  return (
    call.workers.map((worker) => worker.name).join(", ") ||
    (call.workerIds.length > 0
      ? call.workerIds.length === 1
        ? call.workerIds[0]!
        : `${call.workerIds.length} Workers`
      : "Worker")
  );
}

export function workerToolElapsed(call: WorkerToolCallPresentation, nowMs = Date.now()): string {
  const start = Date.parse(call.startedAt);
  const end =
    call.durationMs !== undefined
      ? start + call.durationMs
      : call.endedAt
        ? Date.parse(call.endedAt)
        : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  return formatWorkerDuration(Math.max(0, end - start)) ?? "—";
}
