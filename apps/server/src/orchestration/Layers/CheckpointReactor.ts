import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type OrchestrationThread,
  type ThreadWorkspaceRestoreOutcome,
  type ProjectId,
  type ProviderSession,
  type SubagentBackend,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { WorkerService } from "../../worker/WorkerService.ts";
import type {
  VcsCheckpointRestoreFailureReason,
  VcsCheckpointRestoreResult,
} from "../../vcs/VcsDriver.ts";

type RewindFailureReason = VcsCheckpointRestoreFailureReason | "orchestration-receipt-rejected";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

export function resolveEditFromHereBoundary(
  thread: Pick<OrchestrationThread, "messages" | "checkpoints">,
  sourceMessageId: MessageId,
): {
  readonly sourceMessage: OrchestrationThread["messages"][number];
  readonly turnCount: number;
  readonly lastTurnId: TurnId | null;
  readonly retainedTurnIds: ReadonlySet<TurnId>;
} | null {
  const sourceIndex = thread.messages.findIndex((message) => message.id === sourceMessageId);
  const sourceMessage = thread.messages[sourceIndex];
  if (sourceIndex < 0 || !sourceMessage || sourceMessage.role !== "user") {
    return null;
  }

  const priorAssistantMessages = thread.messages
    .slice(0, sourceIndex)
    .filter((message) => message.role === "assistant");
  const priorAssistantIds = new Set(priorAssistantMessages.map((message) => message.id));
  const priorTurnIds = new Set(
    priorAssistantMessages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const turnCount = thread.checkpoints.reduce(
    (maximum, checkpoint) =>
      (checkpoint.assistantMessageId !== null &&
        priorAssistantIds.has(checkpoint.assistantMessageId)) ||
      priorTurnIds.has(checkpoint.turnId)
        ? Math.max(maximum, checkpoint.checkpointTurnCount)
        : maximum,
    0,
  );
  const lastTurnId =
    priorAssistantMessages.toReversed().find((message) => message.turnId !== null)?.turnId ?? null;
  const retainedTurnIds = new Set(
    thread.messages
      .slice(0, sourceIndex)
      .flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  return { sourceMessage, turnCount, lastTurnId, retainedTurnIds };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const editCommandId = (requestId: CommandId, tag: string) =>
    CommandId.make(`server:edit-from-here:${requestId}:${tag}`);
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const workerService = yield* WorkerService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const path = yield* Path.Path;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly reason?: RewindFailureReason;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendWorkspaceRestoreOutcomeActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly outcome: ThreadWorkspaceRestoreOutcome;
    readonly editFromHere: boolean;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-files-not-restored"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "info",
            kind: input.editFromHere
              ? "thread.edit-from-here.files-not-restored"
              : "checkpoint.revert.files-not-restored",
            summary: "Conversation rewound; files not restored",
            payload: {
              turnCount: input.turnCount,
              filesRestored: false,
              ...(input.outcome.conversationOnly === true ? { conversationOnly: true } : {}),
              ...(input.outcome.reason !== undefined ? { reason: input.outcome.reason } : {}),
              ...(input.outcome.detail !== undefined ? { detail: input.outcome.detail } : {}),
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetailAfterSequence = Effect.fn("resolveThreadDetailAfterSequence")(function* (
    threadId: ThreadId,
    minimumSequence: number,
  ) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const snapshot = yield* projectionSnapshotQuery.getThreadDetailSnapshot(threadId);
      if (Option.isSome(snapshot) && snapshot.value.snapshotSequence >= minimumSequence) {
        return snapshot.value.thread;
      }
      if (Option.isNone(snapshot)) {
        const { snapshotSequence } = yield* projectionSnapshotQuery.getSnapshotSequence();
        if (snapshotSequence >= minimumSequence) return undefined;
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(
      new Error(
        `Projection did not reach edit event sequence ${minimumSequence} for thread '${threadId}'.`,
      ),
    );
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const sessionCwd = Option.isSome(fromSession) ? fromSession.value.cwd : undefined;
    const candidates = input.preferSessionRuntime
      ? [sessionCwd, fromThread]
      : [fromThread, sessionCwd];
    for (const candidate of candidates) {
      if (
        candidate !== undefined &&
        path.isAbsolute(candidate) &&
        (yield* checkpointStore.isGitRepository(candidate).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return candidate;
      }
    }
    return undefined;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Only terminal runtime events finalize filesystem checkpoints. Diff placeholders
  // can arrive mid-turn, before the provider has finished editing files.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const restoreThreadToTurnCount = Effect.fn("restoreThreadToTurnCount")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly createdAt: string;
    readonly completionCommandId?: CommandId;
    readonly sourceMessageId?: MessageId;
    readonly cutoffCreatedAt?: string;
    readonly retainedTurnIds?: ReadonlySet<TurnId>;
    readonly reconciliationRequestId?: string;
    readonly skipProviderRollback?: boolean;
    readonly validateOnly?: boolean;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: input.threadId,
        turnCount: input.turnCount,
        reason: "workspace-unavailable",
        detail: "Thread was not found in read model.",
        createdAt: input.createdAt,
      }).pipe(Effect.catch(() => Effect.void));
      return {
        restored: false as const,
        reason: "workspace-unavailable" as const,
        detail: "The task is no longer present in the orchestration projection.",
      };
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const project = projects[0];
    const configuredCwd = resolveThreadWorkspaceCwd({ thread, projects });
    const sessionRuntime = yield* resolveSessionRuntimeForThread(input.threadId);
    const sessionCwd = Option.isSome(sessionRuntime) ? sessionRuntime.value.cwd : undefined;
    const candidateCwds = [
      ...new Set(
        [configuredCwd, sessionCwd].flatMap((candidate) =>
          candidate === undefined ? [] : [candidate],
        ),
      ),
    ].filter((candidate) => path.isAbsolute(candidate));
    let checkpointCwd: string | undefined;
    for (const candidate of candidateCwds) {
      if (
        yield* checkpointStore.isGitRepository(candidate).pipe(Effect.orElseSucceed(() => false))
      ) {
        checkpointCwd = candidate;
        break;
      }
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (input.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: input.threadId,
        turnCount: input.turnCount,
        reason: "checkpoint-missing",
        detail: `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: input.createdAt,
      }).pipe(Effect.catch(() => Effect.void));
      return {
        restored: false as const,
        reason: "checkpoint-missing" as const,
        detail: `Checkpoint turn count ${input.turnCount} is not available in this task.`,
      };
    }

    const targetCheckpointRef =
      input.turnCount === 0
        ? checkpointRefForThreadTurn(input.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
          )?.checkpointRef;

    const hasFilesystemCheckpointSummary = thread.checkpoints.length > 0;
    if (
      hasFilesystemCheckpointSummary &&
      Option.isNone(sessionRuntime) &&
      input.skipProviderRollback !== true
    ) {
      const detail = "No active provider session is bound to this checkpoint-backed task.";
      yield* appendRevertFailureActivity({
        threadId: input.threadId,
        turnCount: input.turnCount,
        reason: "workspace-unavailable",
        detail,
        createdAt: input.createdAt,
      }).pipe(Effect.catch(() => Effect.void));
      return { restored: false as const, reason: "workspace-unavailable" as const, detail };
    }
    let restored: Extract<VcsCheckpointRestoreResult, { restored: true }> | undefined;
    let workspaceRestore: ThreadWorkspaceRestoreOutcome;
    if (!hasFilesystemCheckpointSummary) {
      workspaceRestore = {
        filesRestored: false,
        conversationOnly: true,
        detail:
          "No filesystem checkpoint summary is recorded for this task; the conversation was rewound without changing files.",
      };
    } else if (checkpointCwd === undefined || targetCheckpointRef === undefined) {
      const reason =
        targetCheckpointRef === undefined
          ? ("checkpoint-missing" as const)
          : ("workspace-unavailable" as const);
      const detail =
        targetCheckpointRef === undefined
          ? `Checkpoint ref for turn ${input.turnCount} is unavailable in the task record.`
          : "The task workspace is unavailable or is not a Git worktree.";
      yield* appendRevertFailureActivity({
        threadId: input.threadId,
        turnCount: input.turnCount,
        reason,
        detail,
        createdAt: input.createdAt,
      }).pipe(Effect.catch(() => Effect.void));
      return { restored: false as const, reason, detail };
    } else {
      const vcsRestore = yield* checkpointStore.restoreCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
        ...(project?.repositoryIdentity?.rootPath
          ? { expectedRepositoryRoot: project.repositoryIdentity.rootPath }
          : {}),
        expectedBranch: thread.branch,
        expectedCurrentCheckpointRef: checkpointRefForThreadTurn(input.threadId, currentTurnCount),
        fallbackToHead: input.turnCount === 0,
        ...(input.validateOnly ? { validateOnly: true } : {}),
      });
      if (!vcsRestore.restored) {
        yield* appendRevertFailureActivity({
          threadId: input.threadId,
          turnCount: input.turnCount,
          reason: vcsRestore.reason,
          detail: vcsRestore.detail,
          createdAt: input.createdAt,
        }).pipe(Effect.catch(() => Effect.void));
        return vcsRestore;
      }
      restored = vcsRestore;
      workspaceRestore = { filesRestored: true };
    }

    const restoreOutcome = !workspaceRestore.filesRestored
      ? {
          restored: true as const,
          filesRestored: false as const,
          workspaceRestore,
        }
      : {
          restored: true as const,
          filesRestored: true as const,
          commitOid: restored!.commitOid,
          workspaceRestore,
        };

    if (input.validateOnly) return restoreOutcome;

    // Refresh the workspace entry index so the @-mention file picker
    // reflects the reverted filesystem state.
    if (checkpointCwd !== undefined && restoreOutcome.filesRestored) {
      yield* workspaceEntries.refresh(checkpointCwd);
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - input.turnCount);
    if (rolledBackTurns > 0 && !input.skipProviderRollback) {
      yield* providerService.rollbackConversation({
        threadId: input.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > input.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (
      staleCheckpointRefs.length > 0 &&
      checkpointCwd !== undefined &&
      restoreOutcome.filesRestored
    ) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    const completed = yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId:
          input.completionCommandId ?? (yield* serverCommandId("checkpoint-revert-complete")),
        threadId: input.threadId,
        turnCount: input.turnCount,
        ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(input.cutoffCreatedAt !== undefined ? { cutoffCreatedAt: input.cutoffCreatedAt } : {}),
        ...(input.reconciliationRequestId !== undefined
          ? { editFromHereRequestId: CommandId.make(input.reconciliationRequestId) }
          : {}),
        workspaceRestore,
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: input.threadId,
            turnCount: input.turnCount,
            detail: error.message,
            createdAt: input.createdAt,
          }).pipe(Effect.as(false)),
        ),
      );
    if (completed) {
      const retainedTurnIds =
        input.retainedTurnIds ??
        new Set(
          thread.checkpoints
            .filter((checkpoint) => checkpoint.checkpointTurnCount <= input.turnCount)
            .map((checkpoint) => checkpoint.turnId),
        );
      yield* workerService.reconcileParentAfterRewind({
        parentThreadId: input.threadId,
        retainedTurnIds,
        requestId:
          input.reconciliationRequestId ?? String(input.completionCommandId ?? input.createdAt),
        discardUnattributed: input.turnCount === 0,
        parentActivities: thread.activities,
      });
      if (!restoreOutcome.filesRestored) {
        yield* appendWorkspaceRestoreOutcomeActivity({
          threadId: input.threadId,
          turnCount: input.turnCount,
          outcome: workspaceRestore,
          editFromHere: input.reconciliationRequestId !== undefined,
          createdAt: input.createdAt,
        }).pipe(Effect.catch(() => Effect.void));
      }
    }
    return completed
      ? restoreOutcome
      : {
          restored: false as const,
          reason: "orchestration-receipt-rejected" as const,
          detail:
            "The workspace restore was applied, but the conversation receipt was rejected. Files remain at the selected checkpoint; the conversation was not changed.",
        };
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    return yield* restoreThreadToTurnCount({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const finishEditFromHere = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly targetThreadId?: ThreadId;
    readonly error?: string;
    readonly workspaceRestore?: ThreadWorkspaceRestoreOutcome;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.edit-from-here.finish",
      commandId: editCommandId(input.requestId, "finish"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.targetThreadId !== undefined ? { targetThreadId: input.targetThreadId } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.workspaceRestore !== undefined ? { workspaceRestore: input.workspaceRestore } : {}),
      createdAt: input.createdAt,
    });

  const appendEditFromHereFailure = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly detail: string;
    readonly reason?: RewindFailureReason;
    readonly technicalDetail?: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: editCommandId(input.requestId, "failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(`edit-from-here:${input.requestId}:failure`),
        tone: "error",
        kind: "thread.edit-from-here.failed",
        summary: "Edit from here failed",
        payload: {
          requestId: input.requestId,
          detail: input.detail,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.technicalDetail !== undefined
            ? { technicalDetail: input.technicalDetail }
            : {}),
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const editFromHereFailureMessage = (reason: RewindFailureReason): string => {
    switch (reason) {
      case "current-worktree-dirty":
        return "The workspace changed after the latest checkpoint, so your changes were left untouched.";
      case "repository-mismatch":
        return "This task is attached to a different repository than the selected checkpoint.";
      case "branch-mismatch":
        return "The task branch changed, so the selected checkpoint was not applied.";
      case "checkpoint-missing":
      case "checkpoint-invalid":
      case "current-checkpoint-missing":
        return "This checkpoint is no longer available. The task was not changed.";
      case "workspace-unavailable":
        return "The task workspace is unavailable. The task was not changed.";
      case "orchestration-receipt-rejected":
        return "The files were restored, but the conversation receipt was rejected. The conversation was not changed.";
    }
  };

  const parseEditFromHereRestoreFailure = (detail: string) => {
    const match = detail.match(/checkpoint-restore:([^:]+):([\s\S]*)/);
    if (!match) return undefined;
    const reason = match[1];
    if (
      reason !== "workspace-unavailable" &&
      reason !== "repository-mismatch" &&
      reason !== "branch-mismatch" &&
      reason !== "checkpoint-missing" &&
      reason !== "checkpoint-invalid" &&
      reason !== "current-checkpoint-missing" &&
      reason !== "current-worktree-dirty" &&
      reason !== "orchestration-receipt-rejected"
    ) {
      return undefined;
    }
    return {
      reason,
      userDetail: editFromHereFailureMessage(reason),
      technicalDetail: detail,
    } as const;
  };

  const providerSessionStatus = (
    session: ProviderSession,
  ): "starting" | "running" | "ready" | "stopped" | "error" => {
    switch (session.status) {
      case "connecting":
        return "starting";
      case "closed":
        return "stopped";
      default:
        return session.status;
    }
  };

  const resolveEditSessionStart = Effect.fn("resolveEditSessionStart")(function* (input: {
    readonly sourceThread: OrchestrationThread;
    readonly targetThreadId: ThreadId;
    readonly title: string;
    readonly subagentBackend?: SubagentBackend | undefined;
    readonly freshConversation?: boolean;
  }) {
    const providerSessions = yield* providerService.listSessions();
    const sourceSession = providerSessions.find(
      (session) => session.threadId === input.sourceThread.id,
    );
    const projects = yield* resolveThreadProjects(input.sourceThread.projectId);
    const cwd =
      sourceSession?.cwd ?? resolveThreadWorkspaceCwd({ thread: input.sourceThread, projects });
    return {
      threadId: input.targetThreadId,
      providerInstanceId:
        sourceSession?.providerInstanceId ?? input.sourceThread.modelSelection.instanceId,
      ...(sourceSession?.provider !== undefined ? { provider: sourceSession.provider } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      title: input.title,
      modelSelection: input.sourceThread.modelSelection,
      ...(input.subagentBackend !== undefined ? { subagentBackend: input.subagentBackend } : {}),
      ...(input.freshConversation ? { resumeCursor: null } : {}),
      runtimeMode: input.sourceThread.runtimeMode,
    } as const;
  });

  const setThreadProviderSession = (input: {
    readonly requestId: CommandId;
    readonly commandTag: string;
    readonly threadId: ThreadId;
    readonly session: ProviderSession;
    readonly runtimeMode: OrchestrationThread["runtimeMode"];
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: editCommandId(input.requestId, input.commandTag),
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: providerSessionStatus(input.session),
        providerName: input.session.provider,
        ...(input.session.providerInstanceId !== undefined
          ? { providerInstanceId: input.session.providerInstanceId }
          : {}),
        runtimeMode: input.runtimeMode,
        activeTurnId: null,
        lastError: input.session.lastError ?? null,
        updatedAt: input.session.updatedAt,
      },
      createdAt: input.createdAt,
    });

  const handleEditFromHereRequested = Effect.fn("handleEditFromHereRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.edit-from-here-requested" }>,
  ) {
    const sourceThread = yield* resolveThreadDetailAfterSequence(
      event.payload.threadId,
      event.sequence,
    );
    if (!sourceThread) {
      return yield* Effect.die(
        new Error(`Source thread '${event.payload.threadId}' is unavailable.`),
      );
    }

    const latestSequence = yield* orchestrationEngine.latestSequence;
    const laterEvents =
      latestSequence > event.sequence
        ? yield* Stream.runCollect(
            orchestrationEngine.readEvents(event.sequence, latestSequence - event.sequence),
          )
        : [];
    const requestWasSuperseded = Array.from(laterEvents).some(
      (laterEvent) =>
        ((laterEvent.type === "thread.edit-from-here-requested" &&
          laterEvent.payload.requestId !== event.payload.requestId) ||
          (laterEvent.type === "thread.edit-from-here-finished" &&
            laterEvent.payload.requestId === event.payload.requestId)) &&
        laterEvent.payload.threadId === event.payload.threadId,
    );
    if (requestWasSuperseded) {
      return;
    }

    if (
      sourceThread.messages.some((message) => message.id === event.payload.replacementMessageId)
    ) {
      yield* finishEditFromHere({
        threadId: sourceThread.id,
        requestId: event.payload.requestId,
        ...(event.payload.targetThreadId !== undefined
          ? { targetThreadId: event.payload.targetThreadId }
          : {}),
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const boundary = resolveEditFromHereBoundary(sourceThread, event.payload.sourceMessageId);
    if (!boundary) {
      return yield* Effect.die(
        new Error(`Selected user message '${event.payload.sourceMessageId}' is unavailable.`),
      );
    }

    if (event.payload.mode === "rewind") {
      const isRootBoundary = boundary.turnCount === 0 && boundary.lastTurnId === null;
      const restored = isRootBoundary
        ? yield* Effect.gen(function* () {
            const preflight = yield* restoreThreadToTurnCount({
              threadId: sourceThread.id,
              turnCount: 0,
              createdAt: event.payload.createdAt,
              sourceMessageId: event.payload.sourceMessageId,
              cutoffCreatedAt: boundary.sourceMessage.createdAt,
              retainedTurnIds: boundary.retainedTurnIds,
              reconciliationRequestId: event.payload.requestId,
              skipProviderRollback: true,
              validateOnly: true,
            });
            if (!preflight.restored) return preflight;

            const startSession = yield* resolveEditSessionStart({
              sourceThread,
              targetThreadId: sourceThread.id,
              title: sourceThread.title,
              ...(event.payload.subagentBackend !== undefined
                ? { subagentBackend: event.payload.subagentBackend }
                : {}),
              freshConversation: true,
            });
            const session = yield* providerService.startSession(sourceThread.id, startSession);
            yield* setThreadProviderSession({
              requestId: event.payload.requestId,
              commandTag: "root-session",
              threadId: sourceThread.id,
              session,
              runtimeMode: sourceThread.runtimeMode,
              createdAt: event.payload.createdAt,
            });
            return yield* restoreThreadToTurnCount({
              threadId: sourceThread.id,
              turnCount: 0,
              createdAt: event.payload.createdAt,
              completionCommandId: editCommandId(event.payload.requestId, "revert-complete"),
              sourceMessageId: event.payload.sourceMessageId,
              cutoffCreatedAt: boundary.sourceMessage.createdAt,
              retainedTurnIds: boundary.retainedTurnIds,
              reconciliationRequestId: event.payload.requestId,
              skipProviderRollback: true,
            });
          })
        : yield* restoreThreadToTurnCount({
            threadId: sourceThread.id,
            turnCount: boundary.turnCount,
            createdAt: event.payload.createdAt,
            completionCommandId: editCommandId(event.payload.requestId, "revert-complete"),
            sourceMessageId: event.payload.sourceMessageId,
            cutoffCreatedAt: boundary.sourceMessage.createdAt,
            retainedTurnIds: boundary.retainedTurnIds,
            reconciliationRequestId: event.payload.requestId,
          });
      if (!restored.restored) {
        return yield* Effect.die(
          new Error(`checkpoint-restore:${restored.reason}:${restored.detail}`),
        );
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: editCommandId(event.payload.requestId, "replacement-turn"),
        threadId: sourceThread.id,
        message: {
          messageId: event.payload.replacementMessageId,
          role: "user",
          text: event.payload.editedText,
          attachments: [...(boundary.sourceMessage.attachments ?? [])],
        },
        modelSelection: sourceThread.modelSelection,
        runtimeMode: sourceThread.runtimeMode,
        interactionMode: sourceThread.interactionMode,
        ...(event.payload.subagentBackend !== undefined
          ? { subagentBackend: event.payload.subagentBackend }
          : {}),
        editFromHereRequestId: event.payload.requestId,
        createdAt: event.payload.createdAt,
      });
      yield* finishEditFromHere({
        threadId: sourceThread.id,
        requestId: event.payload.requestId,
        workspaceRestore: restored.workspaceRestore,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const targetThreadId = event.payload.targetThreadId;
    if (targetThreadId === undefined) {
      return yield* Effect.die(new Error("A target task is required for branch mode."));
    }
    const existingTarget = yield* resolveThreadDetail(targetThreadId);
    if (!existingTarget) {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: editCommandId(event.payload.requestId, "create-target"),
        threadId: targetThreadId,
        projectId: sourceThread.projectId,
        title: `${sourceThread.title} (edited)`,
        modelSelection: sourceThread.modelSelection,
        runtimeMode: sourceThread.runtimeMode,
        interactionMode: sourceThread.interactionMode,
        branch: sourceThread.branch,
        worktreePath: sourceThread.worktreePath,
        createdAt: event.payload.createdAt,
      });
    }

    const targetAfterCreate = yield* resolveThreadDetail(targetThreadId);
    if (
      targetAfterCreate?.messages.some(
        (message) => message.id === event.payload.replacementMessageId,
      )
    ) {
      yield* finishEditFromHere({
        threadId: sourceThread.id,
        requestId: event.payload.requestId,
        targetThreadId,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const providerSessions = yield* providerService.listSessions();
    let targetSession = providerSessions.find((session) => session.threadId === targetThreadId);
    if (!targetSession) {
      const startSession = yield* resolveEditSessionStart({
        sourceThread,
        targetThreadId,
        title: `${sourceThread.title} (edited)`,
        ...(event.payload.subagentBackend !== undefined
          ? { subagentBackend: event.payload.subagentBackend }
          : {}),
      });
      targetSession =
        boundary.lastTurnId === null
          ? yield* providerService.startSession(targetThreadId, startSession)
          : yield* providerService.forkConversation({
              sourceThreadId: sourceThread.id,
              targetThreadId,
              lastTurnId: boundary.lastTurnId,
              startSession,
            });
    }

    yield* setThreadProviderSession({
      requestId: event.payload.requestId,
      commandTag: "target-session",
      threadId: targetThreadId,
      session: targetSession,
      runtimeMode: sourceThread.runtimeMode,
      createdAt: event.payload.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: editCommandId(event.payload.requestId, "replacement-turn"),
      threadId: targetThreadId,
      message: {
        messageId: event.payload.replacementMessageId,
        role: "user",
        text: event.payload.editedText,
        attachments: [...(boundary.sourceMessage.attachments ?? [])],
      },
      modelSelection: sourceThread.modelSelection,
      runtimeMode: sourceThread.runtimeMode,
      interactionMode: sourceThread.interactionMode,
      ...(event.payload.subagentBackend !== undefined
        ? { subagentBackend: event.payload.subagentBackend }
        : {}),
      createdAt: event.payload.createdAt,
    });
    yield* finishEditFromHere({
      threadId: sourceThread.id,
      requestId: event.payload.requestId,
      targetThreadId,
      createdAt: event.payload.createdAt,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    if (event.type === "thread.edit-from-here-requested") {
      yield* handleEditFromHereRequested(event).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const detail = Cause.pretty(cause) || "Edit from here failed.";
          const restoreFailure = parseEditFromHereRestoreFailure(detail);
          const userDetail =
            restoreFailure?.userDetail ??
            "The edit could not be applied. The task was not changed.";
          return Effect.gen(function* () {
            yield* appendEditFromHereFailure({
              threadId: event.payload.threadId,
              requestId: event.payload.requestId,
              detail: userDetail,
              ...(restoreFailure !== undefined
                ? {
                    reason: restoreFailure.reason,
                    technicalDetail: restoreFailure.technicalDetail,
                  }
                : { technicalDetail: detail }),
              createdAt: event.payload.createdAt,
            }).pipe(Effect.catch(() => Effect.void));
            if (event.payload.mode === "branch" && event.payload.targetThreadId !== undefined) {
              yield* orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: editCommandId(event.payload.requestId, "delete-failed-target"),
                  threadId: event.payload.targetThreadId,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
            yield* finishEditFromHere({
              threadId: event.payload.threadId,
              requestId: event.payload.requestId,
              ...(event.payload.targetThreadId !== undefined
                ? { targetThreadId: event.payload.targetThreadId }
                : {}),
              error: userDetail,
              createdAt: event.payload.createdAt,
            });
          });
        }),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.edit-from-here-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
