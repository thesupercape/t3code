/**
 * Provider-neutral contracts for T3-managed Workers.
 *
 * A Worker is a persistent T3 identity. Each execution is an Activation, and
 * the assignment/context package is kept separate from the parent thread's
 * transcript. Providers may implement the backend differently, but these
 * records are the stable boundary used by MCP, WebSocket clients, and the
 * Worker inbox.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  ProviderApprovalPolicy,
  ProviderSandboxMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Canonical T3-owned Worker tool names shared by server and web consumers. */
export const T3_WORKER_TOOL_NAMES = [
  "worker_start",
  "worker_list",
  "worker_status",
  "worker_observe",
  "worker_send",
  "worker_wait",
  "worker_interrupt",
  "worker_close",
  "worker_approval_respond",
] as const;
export type T3WorkerToolName = (typeof T3_WORKER_TOOL_NAMES)[number];

const WorkerEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkerId = WorkerEntityId("WorkerId");
export type WorkerId = typeof WorkerId.Type;

/** Display names are identity labels, not assignment titles. */
export const WORKER_DISPLAY_NAME_MAX_LENGTH = 64;

const WORKER_NAME_ADJECTIVES = [
  "Amber",
  "Brisk",
  "Cobalt",
  "Copper",
  "Jade",
  "Keen",
  "Quiet",
  "Silver",
  "Solar",
  "Swift",
] as const;
const WORKER_NAME_NOUNS = [
  "Badger",
  "Cedar",
  "Comet",
  "Falcon",
  "Finch",
  "Harbor",
  "Maple",
  "Orbit",
  "Pine",
  "Raven",
] as const;

/**
 * Normalizes a parent-supplied label at the contract boundary. Blank labels
 * intentionally return undefined so the server can assign an identity name.
 */
export function sanitizeWorkerDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WORKER_DISPLAY_NAME_MAX_LENGTH)
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Stable fallback/generation from the already-random Worker id. */
export function workerDisplayNameFor(workerId: string, suppliedName?: string): string {
  const supplied = sanitizeWorkerDisplayName(suppliedName);
  if (supplied !== undefined) return supplied;
  let hash = 0;
  for (const character of workerId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const adjective = WORKER_NAME_ADJECTIVES[hash % WORKER_NAME_ADJECTIVES.length];
  const noun = WORKER_NAME_NOUNS[(hash >>> 8) % WORKER_NAME_NOUNS.length];
  return `${adjective} ${noun}`;
}

export const WorkerActivationId = WorkerEntityId("WorkerActivationId");
export type WorkerActivationId = typeof WorkerActivationId.Type;

export const WorkerMessageId = WorkerEntityId("WorkerMessageId");
export type WorkerMessageId = typeof WorkerMessageId.Type;

export const WorkerWaitLeaseId = WorkerEntityId("WorkerWaitLeaseId");
export type WorkerWaitLeaseId = typeof WorkerWaitLeaseId.Type;

export const WorkerObserverReportId = WorkerEntityId("WorkerObserverReportId");
export type WorkerObserverReportId = typeof WorkerObserverReportId.Type;

export const WorkerActivityTone = Schema.Literals(["info", "tool", "approval", "error"]);
export type WorkerActivityTone = typeof WorkerActivityTone.Type;

/**
 * A deliberately small, client-safe projection of a Worker provider event.
 * Raw provider payloads and streamed model content never cross this boundary.
 */
export const WorkerActivity = Schema.Struct({
  id: EventId,
  tone: WorkerActivityTone,
  kind: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  detail: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
});
export type WorkerActivity = typeof WorkerActivity.Type;

/** The backend identifier is open so the contract does not encode one provider. */
export const WorkerBackendKind = TrimmedNonEmptyString;
export type WorkerBackendKind = typeof WorkerBackendKind.Type;

export const WorkerStatus = Schema.Literals([
  "starting",
  "running",
  "waitingApproval",
  "completed",
  "failed",
  "interrupted",
  "lost",
  "closed",
]);
export type WorkerStatus = typeof WorkerStatus.Type;

export const WorkerActivationStatus = Schema.Literals([
  "starting",
  "running",
  "waitingApproval",
  "completed",
  "failed",
  "interrupted",
  "lost",
]);
export type WorkerActivationStatus = typeof WorkerActivationStatus.Type;

export const WorkerPermissionMode = Schema.Literals(["readOnly", "workspaceWrite", "fullAccess"]);
export type WorkerPermissionMode = typeof WorkerPermissionMode.Type;

export const WorkerMessageAuthor = Schema.Literals(["parent", "worker", "observer", "system"]);
export type WorkerMessageAuthor = typeof WorkerMessageAuthor.Type;

export const WorkerMessageKind = Schema.Literals([
  "assignment",
  "followUp",
  "handoff",
  "observerReport",
  "approvalRequest",
  "approvalDecision",
  "lifecycle",
  "error",
  "interrupt",
  "close",
]);
export type WorkerMessageKind = typeof WorkerMessageKind.Type;

export const WorkerWakeReason = Schema.Literals([
  "message",
  "statusChanged",
  "approvalRequested",
  "completed",
  "failed",
  "interrupted",
  "closed",
  "lost",
  "expired",
  "userInput",
]);
export type WorkerWakeReason = typeof WorkerWakeReason.Type;

export const WorkerApprovalDecision = Schema.Literals(["accept", "decline", "cancel"]);
export type WorkerApprovalDecision = typeof WorkerApprovalDecision.Type;

export const WorkerWaitLeaseStatus = Schema.Literals(["waiting", "woken", "expired", "cancelled"]);
export type WorkerWaitLeaseStatus = typeof WorkerWaitLeaseStatus.Type;

/** A file, symbol, or bounded excerpt explicitly selected for the worker. */
export const WorkerContextReference = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineStart: Schema.optionalKey(PositiveInt),
  lineEnd: Schema.optionalKey(PositiveInt),
  symbol: Schema.optionalKey(TrimmedNonEmptyString),
  excerpt: Schema.optionalKey(Schema.String),
});
export type WorkerContextReference = typeof WorkerContextReference.Type;

/**
 * Explicit context sent to a Worker. This deliberately has no transcript or
 * opaque parent-history field: callers must select the paths and snippets.
 */
export const WorkerContextPackage = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  references: Schema.Array(WorkerContextReference).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  snippets: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  maxCharacters: Schema.optionalKey(PositiveInt),
});
export type WorkerContextPackage = typeof WorkerContextPackage.Type;

export const WorkerTokenUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  reasoningOutputTokens: Schema.optionalKey(NonNegativeInt),
  totalTokens: NonNegativeInt,
  toolUses: Schema.optionalKey(NonNegativeInt),
  durationMillis: Schema.optionalKey(NonNegativeInt),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerTokenUsage = typeof WorkerTokenUsage.Type;

/** Usage is persisted per activation and rolled up on the Worker summary. */
export const WorkerUsage = WorkerTokenUsage;
export type WorkerUsage = WorkerTokenUsage;

export const WorkerMessage = Schema.Struct({
  id: WorkerMessageId,
  workerId: WorkerId,
  activationId: Schema.optionalKey(WorkerActivationId),
  author: WorkerMessageAuthor,
  kind: WorkerMessageKind,
  body: Schema.String,
  createdAt: IsoDateTime,
  readAt: Schema.optionalKey(IsoDateTime),
});
export type WorkerMessage = typeof WorkerMessage.Type;

export const WorkerActivation = Schema.Struct({
  id: WorkerActivationId,
  workerId: WorkerId,
  status: WorkerActivationStatus,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: ThreadId,
  /** Native Codex Desktop child identity, kept separate from T3's synthetic key. */
  nativeThreadId: Schema.optionalKey(ThreadId),
  nativeCursor: Schema.optionalKey(Schema.Unknown),
  providerTurnId: Schema.optionalKey(TurnId),
  parentTurnId: Schema.optionalKey(TurnId),
  assignment: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(WorkerContextPackage),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  permissionMode: Schema.optionalKey(WorkerPermissionMode),
  startedAt: IsoDateTime,
  finishedAt: Schema.optionalKey(IsoDateTime),
  lastActivityAt: IsoDateTime,
  usageBaseline: WorkerTokenUsage,
  usageDelta: WorkerTokenUsage,
  latestUsage: Schema.optionalKey(WorkerTokenUsage),
  handoff: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type WorkerActivation = typeof WorkerActivation.Type;

export const WorkerApprovalRequest = Schema.Struct({
  requestId: ApprovalRequestId,
  workerId: WorkerId,
  activationId: WorkerActivationId,
  kind: TrimmedNonEmptyString,
  summary: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  requestedAt: IsoDateTime,
  status: Schema.optionalKey(Schema.Literals(["pending", "resolved", "stale"])),
  resolvedAt: Schema.optionalKey(IsoDateTime),
  decision: Schema.optionalKey(WorkerApprovalDecision),
});
export type WorkerApprovalRequest = typeof WorkerApprovalRequest.Type;

export const WorkerObserverReport = Schema.Struct({
  id: WorkerObserverReportId,
  workerId: WorkerId,
  activationId: Schema.optionalKey(WorkerActivationId),
  model: TrimmedNonEmptyString,
  report: Schema.String,
  progress: Schema.optionalKey(Schema.String),
  blockers: Schema.Array(Schema.String),
  nextAction: Schema.optionalKey(Schema.String),
  appearsBlocked: Schema.optionalKey(Schema.Boolean),
  safeToLeaveRunning: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  verification: Schema.optionalKey(Schema.Array(Schema.String)),
  parentDecision: Schema.optionalKey(Schema.String),
  observedStatus: WorkerStatus,
  readOnly: Schema.Literal(true),
  generatedAt: IsoDateTime,
});
export type WorkerObserverReport = typeof WorkerObserverReport.Type;

export const WorkerSummary = Schema.Struct({
  id: WorkerId,
  /** Optional on the wire for legacy records; the server persists a fallback. */
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  status: WorkerStatus,
  backend: WorkerBackendKind,
  parentThreadId: ThreadId,
  projectId: Schema.optionalKey(ProjectId),
  environmentId: Schema.optionalKey(EnvironmentId),
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.optionalKey(ThreadId),
  model: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optionalKey(TrimmedNonEmptyString),
  permissionMode: Schema.optionalKey(WorkerPermissionMode),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.optionalKey(IsoDateTime),
  activeActivationId: Schema.optionalKey(WorkerActivationId),
  lastActivityAt: IsoDateTime,
  lastDirectMessageAt: Schema.optionalKey(IsoDateTime),
  unreadMessageCount: NonNegativeInt,
  activationCount: NonNegativeInt,
  resumable: Schema.Boolean,
  usage: WorkerTokenUsage,
  /** Exact cumulative dimensions are available for newly projected provider data. */
  usageCoverage: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["complete", "partial", "unavailable"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  /** The most recent provider-reported model call, kept separate from cumulative usage. */
  lastModelCallUsage: Schema.optionalKey(WorkerTokenUsage),
  elapsedMs: Schema.optionalKey(NonNegativeInt),
  latestDirectMessage: Schema.optionalKey(WorkerMessage),
  hasPendingApproval: Schema.optionalKey(Schema.Boolean),
  hasUnreadEvents: Schema.optionalKey(Schema.Boolean),
  latestObserverReport: Schema.optionalKey(WorkerObserverReport),
});
export type WorkerSummary = typeof WorkerSummary.Type;

export const WorkerDetail = Schema.Struct({
  summary: WorkerSummary,
  assignment: Schema.String,
  context: WorkerContextPackage,
  instructions: Schema.optionalKey(Schema.String),
  messages: Schema.Array(WorkerMessage),
  activations: Schema.Array(WorkerActivation),
  pendingApproval: Schema.optionalKey(WorkerApprovalRequest),
  observerReports: Schema.Array(WorkerObserverReport),
  activities: Schema.Array(WorkerActivity).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type WorkerDetail = typeof WorkerDetail.Type;

export const WorkerStartInput = Schema.Struct({
  /** Optional identity label; blank or omitted values receive a server name. */
  displayName: Schema.optionalKey(Schema.String),
  title: TrimmedNonEmptyString,
  assignment: Schema.String,
  context: WorkerContextPackage,
  instructions: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(ModelSelection),
  backendPreference: Schema.optionalKey(WorkerBackendKind),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  permissionMode: Schema.optionalKey(WorkerPermissionMode),
  approvalPolicy: Schema.optionalKey(ProviderApprovalPolicy),
  sandboxMode: Schema.optionalKey(ProviderSandboxMode),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  parentThreadId: Schema.optionalKey(ThreadId),
});
export type WorkerStartInput = typeof WorkerStartInput.Type;

export const WorkerSendInput = Schema.Struct({
  workerId: WorkerId,
  message: Schema.String,
  context: Schema.optionalKey(WorkerContextPackage),
});
export type WorkerSendInput = typeof WorkerSendInput.Type;

export const WorkerListInput = Schema.Struct({
  parentThreadId: Schema.optionalKey(ThreadId),
  includeClosed: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerListInput = typeof WorkerListInput.Type;

export const WorkerMetricCoverage = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  reason: Schema.optionalKey(Schema.String),
});
export type WorkerMetricCoverage = typeof WorkerMetricCoverage.Type;

export const WorkerToolMetric = Schema.Struct({
  name: TrimmedNonEmptyString,
  calls: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  unknown: NonNegativeInt,
});
export type WorkerToolMetric = typeof WorkerToolMetric.Type;

export const WorkerTimingMetrics = Schema.Struct({
  computedAt: IsoDateTime,
  totalWallTimeMs: NonNegativeInt,
  overallSpanMs: NonNegativeInt,
  busyTimeMs: NonNegativeInt,
  overlapTimeMs: NonNegativeInt,
  averageConcurrency: Schema.Number,
  peakConcurrency: NonNegativeInt,
  activeActivationCount: NonNegativeInt,
});
export type WorkerTimingMetrics = typeof WorkerTimingMetrics.Type;

export const WorkerComparisonMetrics = Schema.Struct({
  workerId: WorkerId,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  status: WorkerStatus,
  model: TrimmedNonEmptyString,
  backend: WorkerBackendKind,
  elapsedMs: NonNegativeInt,
  active: Schema.Boolean,
  activations: NonNegativeInt,
  usage: WorkerTokenUsage,
  usageCoverage: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["complete", "partial", "unavailable"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  lastModelCallUsage: Schema.optionalKey(WorkerTokenUsage),
  parentTurnUsage: Schema.optionalKey(WorkerTokenUsage),
  parentTurnUsageCoverage: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["complete", "partial", "unavailable"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  toolCalls: NonNegativeInt,
  completedToolCalls: NonNegativeInt,
  failedToolCalls: NonNegativeInt,
  unknownToolCalls: NonNegativeInt,
  tools: Schema.Array(WorkerToolMetric),
  toolCoverage: WorkerMetricCoverage,
});
export type WorkerComparisonMetrics = typeof WorkerComparisonMetrics.Type;

export const WorkerEfficiencyOverview = Schema.Struct({
  computedAt: IsoDateTime,
  workersCreated: NonNegativeInt,
  workersActive: NonNegativeInt,
  workersCompleted: NonNegativeInt,
  workersFailed: NonNegativeInt,
  workersInterrupted: NonNegativeInt,
  timing: WorkerTimingMetrics,
  usage: WorkerTokenUsage,
  usageCoverage: WorkerMetricCoverage,
  toolCalls: NonNegativeInt,
  completedToolCalls: NonNegativeInt,
  failedToolCalls: NonNegativeInt,
  unknownToolCalls: NonNegativeInt,
  tools: Schema.Array(WorkerToolMetric),
  toolCoverage: WorkerMetricCoverage,
  parentCoordinationCalls: NonNegativeInt,
  parentCoordinationCompleted: NonNegativeInt,
  parentCoordinationFailures: NonNegativeInt,
  parentCoordinationUnknown: NonNegativeInt,
  parentCoordinationTools: Schema.Array(WorkerToolMetric),
  parentCoordinationCoverage: WorkerMetricCoverage,
  parentCoordinationTokenCoverage: WorkerMetricCoverage,
  parentTurnUsageCoverage: Schema.optionalKey(WorkerMetricCoverage),
  workers: Schema.Array(WorkerComparisonMetrics),
});
export type WorkerEfficiencyOverview = typeof WorkerEfficiencyOverview.Type;

export const WorkerListResult = Schema.Struct({
  workers: Schema.Array(WorkerSummary),
  nextCursor: Schema.optionalKey(TrimmedNonEmptyString),
  overview: Schema.optionalKey(WorkerEfficiencyOverview),
});
export type WorkerListResult = typeof WorkerListResult.Type;

export const WorkerGetInput = Schema.Struct({ workerId: WorkerId });
export type WorkerGetInput = typeof WorkerGetInput.Type;

export const WorkerWaitInput = Schema.Struct({
  workerIds: Schema.Array(WorkerId),
  timeoutMillis: PositiveInt,
  until: Schema.optionalKey(Schema.Array(WorkerStatus)),
  mode: Schema.optionalKey(Schema.Literals(["anyRelevantEvent", "allSelectedSettled"])),
  wakeReasons: Schema.optionalKey(Schema.Array(WorkerWakeReason)),
  includeMessages: Schema.optionalKey(Schema.Boolean),
});
export type WorkerWaitInput = typeof WorkerWaitInput.Type;

export const WorkerWaitLease = Schema.Struct({
  leaseId: WorkerWaitLeaseId,
  parentThreadId: Schema.optionalKey(ThreadId),
  workerIds: Schema.Array(WorkerId),
  deadlineAt: IsoDateTime,
  status: WorkerWaitLeaseStatus,
  wakeReason: Schema.optionalKey(WorkerWakeReason),
  createdAt: IsoDateTime,
  completedAt: Schema.optionalKey(IsoDateTime),
});
export type WorkerWaitLease = typeof WorkerWaitLease.Type;

export const WorkerWakeEvent = Schema.Struct({
  workerId: WorkerId,
  activationId: Schema.optionalKey(WorkerActivationId),
  reason: WorkerWakeReason,
  status: WorkerStatus,
  occurredAt: IsoDateTime,
  messageId: Schema.optionalKey(WorkerMessageId),
});
export type WorkerWakeEvent = typeof WorkerWakeEvent.Type;

export const WorkerWaitResult = Schema.Struct({
  leaseId: WorkerWaitLeaseId,
  status: Schema.Literals(["woken", "expired"]),
  reason: WorkerWakeReason,
  events: Schema.Array(WorkerWakeEvent),
  workers: Schema.Array(WorkerSummary),
  lease: Schema.optionalKey(WorkerWaitLease),
  completedAt: IsoDateTime,
});
export type WorkerWaitResult = typeof WorkerWaitResult.Type;

export const WorkerObserveInput = Schema.Struct({
  workerId: WorkerId,
  focus: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type WorkerObserveInput = typeof WorkerObserveInput.Type;

export const WorkerInterruptInput = Schema.Struct({
  workerId: WorkerId,
  force: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.String),
});
export type WorkerInterruptInput = typeof WorkerInterruptInput.Type;

export const WorkerCloseInput = Schema.Struct({ workerId: WorkerId });
export type WorkerCloseInput = typeof WorkerCloseInput.Type;

export const WorkerApprovalResponseInput = Schema.Struct({
  workerId: WorkerId,
  requestId: ApprovalRequestId,
  decision: WorkerApprovalDecision,
  note: Schema.optionalKey(Schema.String),
});
export type WorkerApprovalResponseInput = typeof WorkerApprovalResponseInput.Type;

export const WorkerSubscribeInput = Schema.Struct({
  parentThreadId: Schema.optionalKey(ThreadId),
  includeClosed: Schema.optionalKey(Schema.Boolean),
});
export type WorkerSubscribeInput = typeof WorkerSubscribeInput.Type;

export const WorkerEvent = Schema.Struct({
  sequence: NonNegativeInt,
  workerId: WorkerId,
  type: Schema.Literals([
    "created",
    "updated",
    "message",
    "approvalRequested",
    "approvalResolved",
    "observerReport",
    "deleted",
  ]),
  occurredAt: IsoDateTime,
  summary: WorkerSummary,
  message: Schema.optionalKey(WorkerMessage),
  approval: Schema.optionalKey(WorkerApprovalRequest),
  observerReport: Schema.optionalKey(WorkerObserverReport),
});
export type WorkerEvent = typeof WorkerEvent.Type;

/** MCP uses the same validated payloads as WebSocket callers. These named
 * aliases make the tool surface discoverable without creating a second wire
 * model that could drift from the server API. */
/**
 * Parent-agent Worker creation input. Runtime access is deliberately absent:
 * the MCP server binds it to the calling parent session instead of trusting
 * model-authored arguments.
 */
/**
 * Model selection accepted by `worker_start`.
 *
 * The parent invocation scope is the routing authority, so callers normally
 * omit `instanceId`. An explicit value is accepted for diagnostics and is
 * validated against the calling parent before the canonical `ModelSelection`
 * reaches Worker storage or the provider runtime.
 */
export const WorkerMcpModelSelection = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type WorkerMcpModelSelection = typeof WorkerMcpModelSelection.Type;

export const WorkerMcpStartInput = Schema.Struct({
  /** Optional identity label; blank or omitted values receive a server name. */
  displayName: Schema.optionalKey(Schema.String),
  title: TrimmedNonEmptyString,
  assignment: Schema.String,
  context: WorkerContextPackage,
  instructions: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(WorkerMcpModelSelection),
  backendPreference: Schema.optionalKey(WorkerBackendKind),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerMcpStartInput = typeof WorkerMcpStartInput.Type;
export const WorkerMcpListInput = WorkerListInput;
export type WorkerMcpListInput = WorkerListInput;
export const WorkerMcpGetInput = WorkerGetInput;
export type WorkerMcpGetInput = WorkerGetInput;
export const WorkerMcpSendInput = WorkerSendInput;
export type WorkerMcpSendInput = WorkerSendInput;
export const WorkerMcpWaitInput = WorkerWaitInput;
export type WorkerMcpWaitInput = WorkerWaitInput;
export const WorkerMcpObserveInput = WorkerObserveInput;
export type WorkerMcpObserveInput = WorkerObserveInput;
export const WorkerMcpApprovalResponseInput = WorkerApprovalResponseInput;
export type WorkerMcpApprovalResponseInput = WorkerApprovalResponseInput;
export const WorkerMcpInterruptInput = WorkerInterruptInput;
export type WorkerMcpInterruptInput = WorkerInterruptInput;
export const WorkerMcpCloseInput = WorkerCloseInput;
export type WorkerMcpCloseInput = WorkerCloseInput;
export const WorkerMcpListResult = WorkerListResult;
export type WorkerMcpListResult = WorkerListResult;
export const WorkerMcpGetResult = WorkerDetail;
export type WorkerMcpGetResult = WorkerDetail;
export const WorkerMcpStartResult = WorkerDetail;
export type WorkerMcpStartResult = WorkerDetail;
export const WorkerMcpSendResult = WorkerDetail;
export type WorkerMcpSendResult = WorkerDetail;
export const WorkerMcpObserveResult = WorkerObserverReport;
export type WorkerMcpObserveResult = WorkerObserverReport;
export const WorkerMcpInterruptResult = WorkerDetail;
export type WorkerMcpInterruptResult = WorkerDetail;
export const WorkerMcpCloseResult = WorkerDetail;
export type WorkerMcpCloseResult = WorkerDetail;
export const WorkerMcpApprovalResponseResult = WorkerDetail;
export type WorkerMcpApprovalResponseResult = WorkerDetail;
export const WorkerMcpWaitResult = WorkerWaitResult;
export type WorkerMcpWaitResult = WorkerWaitResult;

export class WorkerNotFoundError extends Schema.TaggedError<WorkerNotFoundError>()(
  "WorkerNotFoundError",
  { workerId: WorkerId },
) {}

export class WorkerDisabledError extends Schema.TaggedError<WorkerDisabledError>()(
  "WorkerDisabledError",
  {},
) {}

export class WorkerOperationError extends Schema.TaggedError<WorkerOperationError>()(
  "WorkerOperationError",
  {
    operation: TrimmedNonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const WorkerError = Schema.Union([
  WorkerNotFoundError,
  WorkerDisabledError,
  WorkerOperationError,
]);
export type WorkerError = typeof WorkerError.Type;
