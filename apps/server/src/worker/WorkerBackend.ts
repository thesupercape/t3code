// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import {
  ThreadId,
  ProviderDriverKind,
  WorkerOperationError,
  type ModelSelection,
  type ProviderApprovalPolicy,
  type ProviderSandboxMode,
  type ProviderInstanceId,
  type ProviderTurnStartResult,
  type RuntimeMode,
  type WorkerContextPackage,
  type WorkerPermissionMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ServerConfig from "../config.ts";
import {
  createCodexDesktopMailboxLayout,
  isCodexDesktopCoordinatorLeaseFresh,
  publishCodexDesktopRequest,
  readCodexDesktopBinding,
  readCodexDesktopCoordinatorLease,
  readCodexDesktopResult,
  resolveCodexDesktopMailboxRoot,
  type CodexDesktopCoordinatorRequest,
} from "./CodexDesktopMailbox.ts";
import { buildWorkerAssignmentPrompt, buildWorkerFollowUpPrompt } from "./WorkerContext.ts";
export {
  WORKER_PROVIDER_THREAD_PREFIX,
  isWorkerLinkedProviderThreadId,
} from "./WorkerThreadBoundary.ts";

export interface WorkerBackendStartInput {
  readonly providerThreadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly title: string;
  readonly assignment: string;
  readonly context: WorkerContextPackage;
  readonly instructions?: string | undefined;
  readonly cwd?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: ProviderApprovalPolicy | undefined;
  readonly sandboxMode?: ProviderSandboxMode | undefined;
  readonly backendPreference?: string | undefined;
  readonly jobId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly workerId?: string | undefined;
  readonly activationId?: string | undefined;
  readonly parentThreadId?: string | undefined;
  readonly parentTurnId?: string | undefined;
}

export interface WorkerBackendActivation {
  readonly providerThreadId: ThreadId;
  readonly providerTurnId?: ProviderTurnStartResult["turnId"];
  /** Native Codex Desktop identity. The synthetic providerThreadId remains T3's key. */
  readonly nativeThreadId?: string | undefined;
  readonly nativeCursor?: unknown;
  /** The mailbox request is durable but has not received its native binding yet. */
  readonly pending?: boolean | undefined;
  readonly handoff?: string | undefined;
  readonly completionStatus?: "completed" | "failed" | "interrupted" | undefined;
  readonly completionError?: string | undefined;
  readonly resumeCursor?: unknown;
}

export interface WorkerBackendSendInput {
  readonly providerThreadId: ThreadId;
  readonly message: string;
  readonly context?: WorkerContextPackage | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly providerInstanceId: WorkerBackendStartInput["providerInstanceId"];
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly approvalPolicy?: ProviderApprovalPolicy | undefined;
  readonly sandboxMode?: ProviderSandboxMode | undefined;
  readonly backendPreference?: string | undefined;
  readonly jobId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly workerId?: string | undefined;
  readonly activationId?: string | undefined;
  readonly nativeThreadId?: string | undefined;
  readonly nativeCursor?: unknown;
  readonly parentThreadId?: string | undefined;
  readonly parentTurnId?: string | undefined;
}

export interface WorkerBackendShape {
  readonly start: (
    input: WorkerBackendStartInput,
  ) => Effect.Effect<WorkerBackendActivation, WorkerOperationError>;
  readonly send: (
    input: WorkerBackendSendInput,
  ) => Effect.Effect<WorkerBackendActivation, WorkerOperationError>;
  readonly interrupt: (input: {
    readonly providerThreadId: ThreadId;
    readonly providerTurnId?: ProviderTurnStartResult["turnId"] | undefined;
    readonly backendPreference?: string | undefined;
  }) => Effect.Effect<void, WorkerOperationError>;
  readonly stop: (
    providerThreadId: ThreadId,
    backendPreference?: string | undefined,
  ) => Effect.Effect<void, WorkerOperationError>;
  readonly respondToApproval: (input: {
    readonly providerThreadId: ThreadId;
    readonly requestId: import("@t3tools/contracts").ApprovalRequestId;
    readonly decision: "accept" | "decline" | "cancel";
    readonly backendPreference?: string | undefined;
  }) => Effect.Effect<void, WorkerOperationError>;
  readonly hasLiveSession: (
    providerThreadId: ThreadId,
    backendPreference?: string | undefined,
  ) => Effect.Effect<boolean, WorkerOperationError>;
  /** Resolve a durable native binding after a T3 process restart. */
  readonly resolveNativeThread?: (
    jobId: string,
    backendPreference?: string | undefined,
  ) => Effect.Effect<string | undefined, WorkerOperationError>;
  readonly observe?: (input: {
    readonly jobId: string;
    readonly backendPreference?: string | undefined;
  }) => Effect.Effect<
    | {
        readonly status: "completed" | "failed" | "interrupted" | "approval_required";
        readonly handoff?: string | undefined;
        readonly error?: string | undefined;
      }
    | undefined,
    WorkerOperationError
  >;
}

export class WorkerBackend extends Context.Service<WorkerBackend, WorkerBackendShape>()(
  "t3/worker/WorkerBackend",
) {}

const operationError = (operation: string, cause: unknown) =>
  new WorkerOperationError({ operation, message: `${operation} failed`, cause });

const isWorkerOperationError = Schema.is(WorkerOperationError);
const codexDriverKind = ProviderDriverKind.make("codex");

const runtimeModeFromPermission = (
  mode: WorkerPermissionMode | undefined,
): RuntimeMode | undefined => {
  switch (mode) {
    case "readOnly":
      return "approval-required";
    case "workspaceWrite":
      return "auto-accept-edits";
    case "fullAccess":
      return "full-access";
    default:
      return undefined;
  }
};

const desktopMailboxRoot = (config: ServerConfig.ServerConfig["Service"]): string =>
  resolveCodexDesktopMailboxRoot(config.baseDir);

const desktopError = (operation: string, message: string, cause?: unknown) =>
  new WorkerOperationError({ operation, message, ...(cause === undefined ? {} : { cause }) });

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const readDesktopLease = async (root: string) => {
  try {
    return await readCodexDesktopCoordinatorLease(createCodexDesktopMailboxLayout(root));
  } catch {
    return undefined;
  }
};

const waitForDesktopBinding = async (root: string, jobId: string, timeoutMs: number) => {
  const layout = createCodexDesktopMailboxLayout(root);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const binding = await readCodexDesktopBinding(layout, jobId);
    if (binding !== undefined) return binding;
    const result = await readCodexDesktopResult(layout, jobId);
    if (result?.status === "failed" || result?.status === "uncertain_start") {
      throw new Error(result.error ?? `Coordinator failed to bind job '${jobId}'`);
    }
    await sleep(250);
  }
  return undefined;
};

const waitForDesktopResult = async (root: string, jobId: string, timeoutMs: number) => {
  const layout = createCodexDesktopMailboxLayout(root);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readCodexDesktopResult(layout, jobId);
    if (result !== undefined) return result;
    await sleep(250);
  }
  return undefined;
};

const desktopRequestBase = (
  input: WorkerBackendStartInput | WorkerBackendSendInput,
  operation: CodexDesktopCoordinatorRequest["operation"],
): CodexDesktopCoordinatorRequest => {
  const jobId = input.jobId;
  const requestId = input.requestId ?? jobId;
  if (jobId === undefined || requestId === undefined) {
    throw desktopError("worker.desktop", "Desktop Worker requests require a durable job id");
  }
  return {
    schemaVersion: 1,
    jobId,
    requestId,
    operation,
    ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    ...(input.activationId === undefined ? {} : { activationId: input.activationId }),
    ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
    ...(input.parentTurnId === undefined ? {} : { parentTurnId: input.parentTurnId }),
    ...(input.title === undefined ? {} : { title: input.title }),
    requestedAt: new Date().toISOString(),
  };
};

export const makeCodexDesktopWorkerBackend = Effect.fn("makeCodexDesktopWorkerBackend")(
  function* () {
    const config = yield* ServerConfig.ServerConfig;
    const root = desktopMailboxRoot(config);
    const layout = createCodexDesktopMailboxLayout(root);

    const ensureReady = Effect.tryPromise({
      try: async () => {
        const lease = await readDesktopLease(root);
        if (!isCodexDesktopCoordinatorLeaseFresh(lease)) {
          throw desktopError(
            "worker.desktop.readiness",
            "Codex Desktop coordinator is unavailable; queued work was not silently routed to T3",
          );
        }
      },
      catch: (cause) =>
        isWorkerOperationError(cause)
          ? cause
          : desktopError(
              "worker.desktop.readiness",
              "Codex Desktop coordinator readiness failed",
              cause,
            ),
    });

    const start: WorkerBackendShape["start"] = (input) =>
      Effect.gen(function* () {
        yield* ensureReady;
        const request = desktopRequestBase(input, "start");
        const startRequest: CodexDesktopCoordinatorRequest = {
          ...request,
          title: input.title,
          assignment: input.assignment,
          context: input.context,
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.modelSelection?.model === undefined
            ? {}
            : { model: input.modelSelection.model }),
          permissionMode:
            input.runtimeMode === "full-access"
              ? "fullAccess"
              : input.runtimeMode === "auto-accept-edits"
                ? "workspaceWrite"
                : "readOnly",
        };
        yield* Effect.tryPromise({
          try: () => publishCodexDesktopRequest(layout, startRequest),
          catch: (cause) =>
            desktopError("worker.desktop.start", "Could not queue Desktop Worker", cause),
        });
        const binding = yield* Effect.tryPromise({
          try: () => waitForDesktopBinding(root, startRequest.jobId, 10_000),
          catch: (cause) =>
            desktopError("worker.desktop.start", "Could not read Desktop Worker binding", cause),
        });
        return {
          providerThreadId: input.providerThreadId,
          ...(binding === undefined
            ? { pending: true as const }
            : { nativeThreadId: binding.childThreadId }),
        } satisfies WorkerBackendActivation;
      }).pipe(
        Effect.mapError((cause) =>
          isWorkerOperationError(cause)
            ? cause
            : desktopError("worker.desktop.start", "Desktop Worker start failed", cause),
        ),
      );

    const send: WorkerBackendShape["send"] = (input) =>
      Effect.gen(function* () {
        yield* ensureReady;
        if (input.nativeThreadId === undefined) {
          return yield* desktopError(
            "worker.desktop.send",
            "Desktop Worker has no recovered native child binding",
          );
        }
        const request = desktopRequestBase(input, "send");
        const sendRequest: CodexDesktopCoordinatorRequest = {
          ...request,
          threadId: input.nativeThreadId,
          message: input.message,
        };
        yield* Effect.tryPromise({
          try: () => publishCodexDesktopRequest(layout, sendRequest),
          catch: (cause) =>
            desktopError("worker.desktop.send", "Could not queue Desktop Worker message", cause),
        });
        const result = yield* Effect.tryPromise({
          try: () => waitForDesktopResult(root, sendRequest.jobId, 30_000),
          catch: (cause) =>
            desktopError("worker.desktop.send", "Could not read Desktop Worker result", cause),
        });
        if (result === undefined) {
          return {
            providerThreadId: input.providerThreadId,
            nativeThreadId: input.nativeThreadId,
            pending: true as const,
          } satisfies WorkerBackendActivation;
        }
        if (result.status === "failed" || result.status === "interrupted") {
          return yield* desktopError(
            "worker.desktop.send",
            result.error ?? `Desktop Worker message ${result.status}`,
          );
        }
        if (
          result.status === "approval_required" ||
          result.status === "unsupported" ||
          result.status === "uncertain_start"
        ) {
          return yield* desktopError(
            "worker.desktop.send",
            result.error ?? `Desktop Worker message requires attention: ${result.status}`,
          );
        }
        if (result.status !== "completed") {
          return {
            providerThreadId: input.providerThreadId,
            nativeThreadId: input.nativeThreadId,
            pending: true as const,
          } satisfies WorkerBackendActivation;
        }
        return {
          providerThreadId: input.providerThreadId,
          nativeThreadId: input.nativeThreadId,
          ...(result.text === undefined ? {} : { handoff: result.text }),
          completionStatus: "completed" as const,
        } satisfies WorkerBackendActivation;
      }).pipe(
        Effect.mapError((cause) =>
          isWorkerOperationError(cause)
            ? cause
            : desktopError("worker.desktop.send", "Desktop Worker send failed", cause),
        ),
      );

    const unsupported = (operation: string) =>
      Effect.fail(
        desktopError(
          `worker.desktop.${operation}`,
          `Codex Desktop coordinator does not support Worker ${operation}; the Worker remains unchanged`,
        ),
      );
    return {
      start,
      send,
      interrupt: (_input) => unsupported("interrupt"),
      stop: (_providerThreadId) => unsupported("close"),
      respondToApproval: (_input) => unsupported("approvalRespond"),
      // Desktop turns are reconciled from durable receipts; they are not
      // ProviderService sessions and a coordinator lease alone cannot prove a
      // child is still alive.
      hasLiveSession: () => Effect.succeed(false),
      resolveNativeThread: (jobId) =>
        Effect.tryPromise({
          try: async () => (await readCodexDesktopBinding(layout, jobId))?.childThreadId,
          catch: (cause) =>
            desktopError("worker.desktop.recover", "Could not read Desktop binding", cause),
        }),
      observe: (input) =>
        Effect.tryPromise({
          try: async () => {
            const result = await readCodexDesktopResult(layout, input.jobId);
            if (result === undefined) return undefined;
            if (result.status === "completed") {
              return {
                status: "completed" as const,
                ...(result.text === undefined ? {} : { handoff: result.text }),
              };
            }
            if (result.status === "failed")
              return { status: "failed" as const, error: result.error };
            if (result.status === "interrupted")
              return { status: "interrupted" as const, error: result.error };
            if (result.status === "approval_required")
              return { status: "approval_required" as const, error: result.error };
            if (result.status === "unsupported" || result.status === "uncertain_start") {
              return {
                status: "failed" as const,
                error: result.error ?? `Desktop Worker requires attention: ${result.status}`,
              };
            }
            return undefined;
          },
          catch: (cause) =>
            desktopError("worker.desktop.observe", "Could not read Desktop result", cause),
        }),
    } satisfies WorkerBackendShape;
  },
);

export const makeCodexLinkedWorkerBackend = Effect.fn("makeCodexLinkedWorkerBackend")(function* () {
  const provider = yield* ProviderService.ProviderService;
  const desktop = yield* makeCodexDesktopWorkerBackend();

  const ensureCodex = Effect.fn("WorkerBackend.ensureCodex")(function* (
    instanceId: WorkerBackendStartInput["providerInstanceId"],
  ) {
    const info = yield* provider.getInstanceInfo(instanceId);
    if (info.driverKind !== "codex") {
      return yield* new WorkerOperationError({
        operation: "worker.codexBackend",
        message: `Provider instance '${instanceId}' is '${info.driverKind}', not codex`,
      });
    }
    return info;
  });

  const start: WorkerBackendShape["start"] = (input) =>
    input.backendPreference === "codex-desktop"
      ? desktop.start(input)
      : Effect.gen(function* () {
          yield* ensureCodex(input.providerInstanceId);
          const session = yield* provider.startSession(input.providerThreadId, {
            threadId: input.providerThreadId,
            provider: codexDriverKind,
            providerInstanceId: input.providerInstanceId,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            title: input.title,
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
            ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
            ...(input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode }),
            runtimeMode: input.runtimeMode,
          });
          const turn = yield* provider.sendTurn({
            threadId: input.providerThreadId,
            input: buildWorkerAssignmentPrompt(input),
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          });
          return {
            providerThreadId: session.threadId,
            providerTurnId: turn.turnId,
            ...(turn.resumeCursor === undefined ? {} : { resumeCursor: turn.resumeCursor }),
          };
        }).pipe(
          Effect.mapError((cause) =>
            isWorkerOperationError(cause) ? cause : operationError("worker.start", cause),
          ),
        );

  const send: WorkerBackendShape["send"] = (input) =>
    input.backendPreference === "codex-desktop"
      ? desktop.send(input)
      : Effect.gen(function* () {
          yield* ensureCodex(input.providerInstanceId);
          const turn = yield* provider.sendTurn({
            threadId: input.providerThreadId,
            input: buildWorkerFollowUpPrompt(input),
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          });
          return {
            providerThreadId: input.providerThreadId,
            providerTurnId: turn.turnId,
            ...(turn.resumeCursor === undefined ? {} : { resumeCursor: turn.resumeCursor }),
          };
        }).pipe(
          Effect.mapError((cause) =>
            isWorkerOperationError(cause) ? cause : operationError("worker.send", cause),
          ),
        );

  const interrupt: WorkerBackendShape["interrupt"] = (input) =>
    input.backendPreference === "codex-desktop"
      ? desktop.interrupt(input)
      : provider
          .interruptTurn({
            threadId: input.providerThreadId,
            ...(input.providerTurnId === undefined ? {} : { turnId: input.providerTurnId }),
          })
          .pipe(Effect.mapError((cause) => operationError("worker.interrupt", cause)));

  const stop: WorkerBackendShape["stop"] = (providerThreadId, backendPreference) =>
    backendPreference === "codex-desktop"
      ? desktop.stop(providerThreadId)
      : provider
          .stopSession({ threadId: providerThreadId })
          .pipe(Effect.mapError((cause) => operationError("worker.close", cause)));

  const respondToApproval: WorkerBackendShape["respondToApproval"] = (input) =>
    input.backendPreference === "codex-desktop"
      ? desktop.respondToApproval(input)
      : provider
          .respondToRequest({
            threadId: input.providerThreadId,
            requestId: input.requestId,
            decision: input.decision,
          })
          .pipe(Effect.mapError((cause) => operationError("worker.approvalRespond", cause)));

  const hasLiveSession: WorkerBackendShape["hasLiveSession"] = (
    providerThreadId,
    backendPreference,
  ) =>
    backendPreference === "codex-desktop"
      ? desktop.hasLiveSession()
      : provider.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.some((session) => session.threadId === providerThreadId),
          ),
          Effect.mapError((cause) => operationError("worker.recover", cause)),
        );

  const resolveNativeThread: WorkerBackendShape["resolveNativeThread"] = (
    jobId,
    backendPreference,
  ) =>
    backendPreference === "codex-desktop"
      ? desktop.resolveNativeThread!(jobId)
      : Effect.succeed(undefined);

  const observe: WorkerBackendShape["observe"] = (input) =>
    input.backendPreference === "codex-desktop"
      ? desktop.observe!(input)
      : Effect.succeed(undefined);

  return {
    start,
    send,
    interrupt,
    stop,
    respondToApproval,
    hasLiveSession,
    resolveNativeThread,
    observe,
  } satisfies WorkerBackendShape;
});

export const CodexLinkedWorkerBackendLive = Layer.effect(
  WorkerBackend,
  makeCodexLinkedWorkerBackend(),
);

export { runtimeModeFromPermission };
