// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  type ProviderSessionStartInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkerService from "../../worker/WorkerService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );
  const sessions: ProviderSession[] = hasSession
    ? [
        {
          provider: providerName,
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
          runtimeMode: "approval-required",
          threadId: ThreadId.make("thread-1"),
          cwd: sessionCwd,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [];
  const startSession = vi.fn((threadId: ThreadId, input: ProviderSessionStartInput) => {
    const session: ProviderSession = {
      provider: providerName,
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId,
      cwd: input.cwd ?? sessionCwd,
      resumeCursor: { threadId: `provider-${threadId}-${startSession.mock.calls.length}` },
      createdAt: now,
      updatedAt: now,
    };
    const existingIndex = sessions.findIndex((candidate) => candidate.threadId === threadId);
    if (existingIndex >= 0) {
      sessions.splice(existingIndex, 1);
    }
    sessions.push(session);
    return Effect.succeed(session);
  });
  const forkConversation = vi.fn(
    (input: {
      readonly targetThreadId: ThreadId;
      readonly startSession: ProviderSessionStartInput;
    }) => startSession(input.targetThreadId, input.startSession),
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () => Effect.succeed([...sessions]);
  const service: ProviderServiceShape = {
    startSession: startSession as ProviderServiceShape["startSession"],
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: ({ threadId }) =>
      Effect.sync(() => {
        const existingIndex = sessions.findIndex((candidate) => candidate.threadId === threadId);
        if (existingIndex >= 0) sessions.splice(existingIndex, 1);
      }),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    uploadFeedback: () => unsupported(),
    forkConversation: forkConversation as ProviderServiceShape["forkConversation"],
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    startSession,
    forkConversation,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly latestTurn: { readonly turnId: string } | null;
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
      readonly activities: ReadonlyArray<{ readonly kind: string }>;
    }>;
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(
        `Timed out waiting for orchestration event. Seen: ${events.map((event) => event.type).join(", ")}`,
      );
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  NodeFS.mkdirSync(NodePath.join(cwd, "apps", "server"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, "apps", "server", ".keep"), "tracked\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore.CheckpointStore
    | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly threadBranch?: string | null;
    readonly secondThreadSharingWorktree?: boolean;
    readonly localStatusRefName?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly useLinkedWorktree?: boolean;
    readonly useNestedThreadCwd?: boolean;
  }) {
    const repositoryRoot = createGitRepository();
    tempDirs.push(repositoryRoot);
    let cwd = repositoryRoot;
    let projectWorkspaceRoot = options?.projectWorkspaceRoot ?? repositoryRoot;
    let threadWorktreePath = options?.threadWorktreePath ?? repositoryRoot;
    let threadBranch = options?.threadBranch ?? null;
    if (options?.useLinkedWorktree === true) {
      const worktreeParent = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-linked-parent-"),
      );
      tempDirs.push(worktreeParent);
      cwd = NodePath.join(worktreeParent, "linked");
      threadWorktreePath = cwd;
      threadBranch = "checkpoint-reactor-linked";
      runGit(repositoryRoot, ["worktree", "add", "-b", threadBranch, cwd]);
      projectWorkspaceRoot = repositoryRoot;
    }
    if (options?.useNestedThreadCwd === true) {
      threadWorktreePath = NodePath.join(repositoryRoot, "apps", "server");
    }
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-checkpoint-reactor-test-",
    });
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName:
              options?.localStatusRefName !== undefined ? options.localStatusRefName : "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      refreshPullRequestStatus: () => Effect.succeed(null),
      streamStatus: () => Stream.empty,
    });
    const reconcileParentAfterRewind = vi.fn(() => Effect.succeed([]));
    const workerService = WorkerService.WorkerService.of({
      start: () => Effect.die("unused Worker start"),
      list: () => Effect.die("unused Worker list"),
      get: () => Effect.die("unused Worker get"),
      send: () => Effect.die("unused Worker send"),
      wait: () => Effect.die("unused Worker wait"),
      observe: () => Effect.die("unused Worker observe"),
      interrupt: () => Effect.die("unused Worker interrupt"),
      close: () => Effect.die("unused Worker close"),
      respondToApproval: () => Effect.die("unused Worker approval"),
      reconcileParentAfterRewind,
      handleProviderEvent: () => Effect.void,
      recover: Effect.void,
      stream: Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(Layer.succeed(WorkerService.WorkerService, workerService)),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const harnessRuntime = ManagedRuntime.make(layer);
    runtime = harnessRuntime;
    const engine = await harnessRuntime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await harnessRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await harnessRuntime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await harnessRuntime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);
    const restartReactor = async () => {
      if (scope) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
      scope = await Effect.runPromise(Scope.make("sequential"));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    };

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: projectWorkspaceRoot,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: threadBranch,
          worktreePath: threadWorktreePath,
          createdAt,
        })
        .pipe(
          options?.secondThreadSharingWorktree
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-2"),
                  threadId: ThreadId.make("thread-2"),
                  projectId: asProjectId("project-1"),
                  title: "Thread 2",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  runtimeMode: "approval-required",
                  branch: null,
                  worktreePath: threadWorktreePath,
                  createdAt,
                }),
              )
            : Effect.asVoid,
        ),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await harnessRuntime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      await harnessRuntime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      await harnessRuntime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      dispatch: (command: OrchestrationCommand) =>
        harnessRuntime.runPromise(engine.dispatch(command)),
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider,
      reconcileParentAfterRewind,
      cwd,
      drain,
      restartReactor,
      checkpointStore,
    };
  }

  async function seedEditFromHereConversation(harness: Awaited<ReturnType<typeof createHarness>>) {
    const threadId = ThreadId.make("thread-1");
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
    const user1 = MessageId.make("edit-user-1");
    const assistant1 = MessageId.make("edit-assistant-1");
    const user2 = MessageId.make("edit-user-2");
    const assistant2 = MessageId.make("edit-assistant-2");

    const setReady = (tag: string, createdAt: string) =>
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`edit-session-${tag}`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    const startUserTurn = (tag: string, messageId: MessageId, text: string, createdAt: string) =>
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`edit-user-turn-${tag}`),
        threadId,
        message: { messageId, role: "user", text, attachments: [] },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });
    const appendAssistant = async (
      tag: string,
      messageId: MessageId,
      turnId: TurnId,
      text: string,
      deltaAt: string,
      completedAt: string,
    ) => {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`edit-assistant-delta-${tag}`),
          threadId,
          messageId,
          delta: text,
          turnId,
          createdAt: deltaAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`edit-assistant-complete-${tag}`),
          threadId,
          messageId,
          turnId,
          createdAt: completedAt,
        }),
      );
    };
    const completeCheckpoint = (
      tag: string,
      turnId: TurnId,
      assistantMessageId: MessageId,
      createdAt: string,
    ) =>
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(`edit-checkpoint-${tag}`),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, Number(tag)),
        status: "ready",
        files: [],
        assistantMessageId,
        checkpointTurnCount: Number(tag),
        createdAt,
      });

    await Effect.runPromise(setReady("initial", at(0)));
    await Effect.runPromise(startUserTurn("1", user1, "Original first message", at(1)));
    await appendAssistant("1", assistant1, asTurnId("edit-turn-1"), "First answer", at(2), at(3));
    await Effect.runPromise(completeCheckpoint("1", asTurnId("edit-turn-1"), assistant1, at(4)));
    await Effect.runPromise(setReady("between", at(5)));
    await Effect.runPromise(startUserTurn("2", user2, "Original second message", at(6)));
    await appendAssistant("2", assistant2, asTurnId("edit-turn-2"), "Second answer", at(7), at(8));
    await Effect.runPromise(completeCheckpoint("2", asTurnId("edit-turn-2"), assistant2, at(9)));
    await Effect.runPromise(setReady("final", at(10)));
    await harness.drain();

    return { threadId, user1, assistant1, user2, assistant2, createdAt: at(11) };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it.each([
    ["completed", "ready"],
    ["interrupted", "missing"],
    ["failed", "error"],
  ] as const)(
    "attributes edits after a mid-turn diff to the %s turn, not the following no-edit turn",
    async (completionState, checkpointStatus) => {
      const harness = await createHarness({ seedFilesystemCheckpoints: false });
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-with-late-edit");
      const createdAt = "2026-01-01T00:00:00.000Z";

      await harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-late-edit"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-late-edit-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt,
      });
      await harness.drain();
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))).toBe(true);

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
      // This is the domain placeholder produced by an in-progress turn.diff.updated.
      await harness.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-in-progress-diff-placeholder"),
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("provider-diff:mid-turn"),
        status: "missing",
        files: [],
        assistantMessageId: MessageId.make("assistant:mid-turn"),
        completedAt: createdAt,
        createdAt,
      });
      await harness.drain();
      expect.soft(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v3\n", "utf8");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-late-edit-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt: "2026-01-01T00:01:00.000Z",
        payload: { state: completionState },
      });
      await harness.drain();

      await harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-no-edit"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-no-edit"),
          lastError: null,
          updatedAt: "2026-01-01T00:02:00.000Z",
        },
        createdAt: "2026-01-01T00:02:00.000Z",
      });
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-no-edit-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("turn-no-edit"),
        createdAt: "2026-01-01T00:02:00.000Z",
      });
      await harness.drain();
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-no-edit-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("turn-no-edit"),
        createdAt: "2026-01-01T00:03:00.000Z",
        payload: { state: "completed" },
      });
      await harness.drain();

      const snapshot = await harness.readModel();
      const checkpoints = snapshot.threads.find((thread) => thread.id === threadId)?.checkpoints;
      expect.soft(checkpoints).toMatchObject([
        {
          turnId,
          checkpointTurnCount: 1,
          status: checkpointStatus,
          files: [{ path: "README.md", additions: 1, deletions: 1 }],
        },
        { turnId: "turn-no-edit", checkpointTurnCount: 2, status: "ready", files: [] },
      ]);
      expect(
        gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
      ).toBe("v3\n");
      expect(
        runGit(harness.cwd, [
          "diff",
          checkpointRefForThreadTurn(threadId, 1),
          checkpointRefForThreadTurn(threadId, 2),
        ]),
      ).toBe("");
    },
  );

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.meta-updated" &&
        (event as unknown as { payload: { branch?: string } }).payload.branch ===
          "t3code/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/renamed-by-agent");
  });

  it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
      secondThreadSharingWorktree: true,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-shared"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-baseline"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("restores from the thread workspace when the provider session cwd is stale", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-stale-session-"),
    );
    tempDirs.push(nonRepositorySessionCwd);
    const harness = await createHarness({ providerSessionCwd: nonRepositorySessionCwd });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-stale-session-set"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-stale-session-diff-1"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      completedAt: createdAt,
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      status: "ready",
      files: [],
      checkpointTurnCount: 1,
      createdAt,
    });
    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-stale-session-diff-2"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-2"),
      completedAt: createdAt,
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
      status: "ready",
      files: [],
      checkpointTurnCount: 2,
      createdAt,
    });

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-stale-session-revert"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    });
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
  });

  it("resolves a nested recorded workspace through the Git repository", async () => {
    const harness = await createHarness({ useNestedThreadCwd: true });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-nested-session-set"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
    for (const turnCount of [1, 2] as const) {
      await harness.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(`cmd-nested-diff-${turnCount}`),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId(`nested-turn-${turnCount}`),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
        status: "ready",
        files: [],
        checkpointTurnCount: turnCount,
        createdAt,
      });
    }

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-nested-revert"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    });
    const revertEvents = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.reverted" || event.type === "thread.activity-appended",
    );
    const reverted = revertEvents.find((event) => event.type === "thread.reverted");
    const revertFailure = revertEvents.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        (event as { payload?: { activity?: { kind?: string } } }).payload?.activity?.kind ===
          "checkpoint.revert.failed",
    );
    if (!reverted) {
      throw new Error(`Nested restore failed: ${JSON.stringify(revertFailure)}`);
    }

    expect(reverted).toMatchObject({
      type: "thread.reverted",
      payload: { workspaceRestore: { filesRestored: true } },
    });
    expect(NodeFS.existsSync(NodePath.join(harness.cwd, "apps", "server", ".keep"))).toBe(true);
  });

  it("marks a legacy rewind as conversation-only and continues the replacement turn", async () => {
    const unavailableWorkspace = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-unavailable-workspace-"),
    );
    tempDirs.push(unavailableWorkspace);
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      projectWorkspaceRoot: unavailableWorkspace,
      threadWorktreePath: unavailableWorkspace,
    });
    const sourceMessageId = MessageId.make("legacy-root-source");
    const replacementMessageId = MessageId.make("legacy-root-replacement");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("legacy-root-turn"),
      threadId: ThreadId.make("thread-1"),
      message: { messageId: sourceMessageId, role: "user", text: "Old prompt", attachments: [] },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    });
    await harness.drain();
    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: CommandId.make("legacy-root-rewind"),
      threadId: ThreadId.make("thread-1"),
      sourceMessageId,
      replacementMessageId,
      editedText: "New prompt",
      mode: "rewind",
      createdAt,
    });
    const finished = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.edit-from-here-finished",
    );
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    const finishedEvent = finished.find((event) => event.type === "thread.edit-from-here-finished");
    expect(finishedEvent).toMatchObject({
      payload: {
        workspaceRestore: { filesRestored: false, conversationOnly: true },
      },
    });
    expect(thread?.messages.map((message) => message.id)).toContain(replacementMessageId);
    expect(thread?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "thread.edit-from-here.files-not-restored",
          payload: expect.objectContaining({ filesRestored: false, conversationOnly: true }),
        }),
      ]),
    );
  });

  it("restores a linked worktree owned by the project repository", async () => {
    const harness = await createHarness({ useLinkedWorktree: true });
    const createdAt = "2026-01-01T00:00:00.000Z";
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-linked-session-set"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
    for (const turnCount of [1, 2] as const) {
      await harness.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(`cmd-linked-diff-${turnCount}`),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId(`turn-${turnCount}`),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
        status: "ready",
        files: [],
        checkpointTurnCount: turnCount,
        createdAt,
      });
    }

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-linked-revert"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    });
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");

    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
  });

  it("rejects a rewind when the worktree changed after its latest checkpoint", async () => {
    const harness = await createHarness();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "user-change.txt"), "keep me\n", "utf8");
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-dirty-session-set"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-dirty-diff-1"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      completedAt: "2026-01-01T00:00:00.000Z",
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      status: "ready",
      files: [],
      checkpointTurnCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-dirty-diff-2"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-2"),
      completedAt: "2026-01-01T00:00:00.000Z",
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
      status: "ready",
      files: [],
      checkpointTurnCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-dirty-revert"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const failureEvents = await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.activity-appended" &&
        (event as { readonly payload?: { readonly activity?: { readonly kind?: string } } }).payload
          ?.activity?.kind === "checkpoint.revert.failed",
    );
    const failure = failureEvents.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        (event as { readonly payload?: { readonly activity?: { readonly kind?: string } } }).payload
          ?.activity?.kind === "checkpoint.revert.failed",
    ) as
      | {
          readonly type: "thread.activity-appended";
          readonly payload: { readonly activity: { readonly payload: unknown } };
        }
      | undefined;
    expect(failure).toBeDefined();
    expect(failure?.payload.activity.payload).toMatchObject({ reason: "current-worktree-dirty" });
    expect(NodeFS.existsSync(NodePath.join(harness.cwd, "user-change.txt"))).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-claude"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });

    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-diff-claude-1"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      completedAt: createdAt,
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      status: "ready",
      files: [],
      checkpointTurnCount: 1,
      createdAt,
    });
    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-diff-claude-2"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-2"),
      completedAt: createdAt,
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
      status: "ready",
      files: [],
      checkpointTurnCount: 2,
      createdAt,
    });

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-revert-request-claude"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-inline-revert"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });

    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-inline-revert-diff-1"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      completedAt: createdAt,
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      status: "ready",
      files: [],
      checkpointTurnCount: 1,
      createdAt,
    });
    await harness.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-inline-revert-diff-2"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-2"),
      completedAt: createdAt,
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
      status: "ready",
      files: [],
      checkpointTurnCount: 2,
      createdAt,
    });

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-sequenced-revert-request-1"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    });
    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-sequenced-revert-request-0"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 0,
      createdAt,
    });

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("branches from the exact provider boundary, preserves the source, and deduplicates retries", async () => {
    const harness = await createHarness();
    const seeded = await seedEditFromHereConversation(harness);
    const sourceBefore = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    const targetThreadId = ThreadId.make("thread-edit-branch");
    const request = {
      type: "thread.edit-from-here" as const,
      commandId: CommandId.make("edit-branch-request"),
      threadId: seeded.threadId,
      sourceMessageId: seeded.user2,
      replacementMessageId: MessageId.make("edit-branch-replacement"),
      editedText: "Edited second message",
      mode: "branch" as const,
      targetThreadId,
      createdAt: seeded.createdAt,
    };

    await harness.dispatch(request);
    await harness.dispatch(request);
    await waitForEvent(harness.engine, (event) => event.type === "thread.edit-from-here-finished");
    await harness.drain();

    const snapshot = await harness.readModel();
    const sourceAfter = snapshot.threads.find((thread) => thread.id === seeded.threadId);
    const target = snapshot.threads.find((thread) => thread.id === targetThreadId);
    expect(sourceAfter?.messages).toEqual(sourceBefore?.messages);
    expect(target?.messages.map((message) => message.text)).toEqual(["Edited second message"]);
    expect(
      target?.messages.filter((message) => message.id === request.replacementMessageId),
    ).toHaveLength(1);
    expect(harness.provider.forkConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.forkConversation.mock.calls[0]?.[0]).toMatchObject({
      sourceThreadId: seeded.threadId,
      targetThreadId,
      lastTurnId: asTurnId("edit-turn-1"),
    });
    expect(harness.reconcileParentAfterRewind).not.toHaveBeenCalled();
  });

  it("branches from the first user message without requiring a prior provider cursor", async () => {
    const harness = await createHarness();
    const seeded = await seedEditFromHereConversation(harness);
    const sourceBefore = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    const targetThreadId = ThreadId.make("thread-edit-root-branch");
    const replacementMessageId = MessageId.make("edit-root-branch-replacement");

    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: CommandId.make("edit-root-branch-request"),
      threadId: seeded.threadId,
      sourceMessageId: seeded.user1,
      replacementMessageId,
      editedText: "Rewritten first message",
      mode: "branch",
      targetThreadId,
      createdAt: seeded.createdAt,
    });
    await waitForEvent(harness.engine, (event) => event.type === "thread.edit-from-here-finished");
    await harness.drain();

    const snapshot = await harness.readModel();
    const sourceAfter = snapshot.threads.find((thread) => thread.id === seeded.threadId);
    const target = snapshot.threads.find((thread) => thread.id === targetThreadId);
    expect(sourceAfter?.messages).toEqual(sourceBefore?.messages);
    expect(target?.messages.map((message) => [message.id, message.text])).toEqual([
      [replacementMessageId, "Rewritten first message"],
    ]);
    expect(harness.provider.forkConversation).not.toHaveBeenCalled();
    expect(harness.provider.startSession).toHaveBeenCalledTimes(1);
  });

  it("rewinds to the selected user boundary and submits the replacement exactly once", async () => {
    const harness = await createHarness();
    const seeded = await seedEditFromHereConversation(harness);
    const replacementMessageId = MessageId.make("edit-rewind-replacement");

    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: CommandId.make("edit-rewind-request"),
      threadId: seeded.threadId,
      sourceMessageId: seeded.user2,
      replacementMessageId,
      editedText: "Rewritten second message",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    await waitForEvent(harness.engine, (event) => event.type === "thread.edit-from-here-finished");
    await harness.drain();

    const source = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    expect(
      source?.messages.map((message) => [message.id, message.text]),
      JSON.stringify(source?.activities),
    ).toEqual([
      [seeded.user1, "Original first message"],
      [seeded.assistant1, "First answer"],
      [replacementMessageId, "Rewritten second message"],
    ]);
    expect(harness.reconcileParentAfterRewind).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: seeded.threadId,
        retainedTurnIds: new Set([asTurnId("edit-turn-1")]),
        requestId: CommandId.make("edit-rewind-request"),
        discardUnattributed: false,
      }),
    );
    expect(source?.messages.some((message) => message.id === seeded.user2)).toBe(false);
    expect(source?.messages.some((message) => message.id === seeded.assistant2)).toBe(false);
    expect(source?.messages.filter((message) => message.id === replacementMessageId)).toHaveLength(
      1,
    );
    expect(source?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: seeded.threadId,
      numTurns: 1,
    });
  });

  it("ignores an older queued edit after a newer request becomes active", async () => {
    const harness = await createHarness();
    const seeded = await seedEditFromHereConversation(harness);
    const restoreCheckpointLive = harness.checkpointStore.restoreCheckpoint.bind(
      harness.checkpointStore,
    );
    const restoreCheckpoint = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    const deleteCheckpointRefs = vi.spyOn(harness.checkpointStore, "deleteCheckpointRefs");
    const oldRequestId = CommandId.make("edit-stale-old-request");
    const newRequestId = CommandId.make("edit-stale-new-request");
    let releaseBlockingRestore!: () => void;
    let markBlockingRestoreStarted!: () => void;
    const blockingRestore = new Promise<void>((resolve) => {
      releaseBlockingRestore = resolve;
    });
    const blockingRestoreStarted = new Promise<void>((resolve) => {
      markBlockingRestoreStarted = resolve;
    });
    restoreCheckpoint.mockImplementationOnce((input) => {
      markBlockingRestoreStarted();
      return Effect.promise(() => blockingRestore).pipe(
        Effect.andThen(restoreCheckpointLive(input)),
      );
    });

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("edit-stale-blocking-revert"),
      threadId: seeded.threadId,
      turnCount: 2,
      createdAt: seeded.createdAt,
    });
    await blockingRestoreStarted;
    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: oldRequestId,
      threadId: seeded.threadId,
      sourceMessageId: seeded.user2,
      replacementMessageId: MessageId.make("edit-stale-old-replacement"),
      editedText: "Stale replacement",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    await harness.dispatch({
      type: "thread.edit-from-here.finish",
      commandId: CommandId.make("edit-stale-old-finish"),
      threadId: seeded.threadId,
      requestId: oldRequestId,
      error: "Superseded for test",
      createdAt: seeded.createdAt,
    });
    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: newRequestId,
      threadId: seeded.threadId,
      sourceMessageId: seeded.user2,
      replacementMessageId: MessageId.make("edit-stale-new-replacement"),
      editedText: "Current replacement",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    releaseBlockingRestore();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId === newRequestId,
    );
    await harness.drain();

    expect(restoreCheckpoint).toHaveBeenCalledTimes(2);
    expect(deleteCheckpointRefs).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    const source = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    expect(source?.messages.some((message) => message.text === "Stale replacement")).toBe(false);
    expect(source?.messages.some((message) => message.text === "Current replacement")).toBe(true);
  });

  it("keeps the existing provider binding when a dirty root rewind is rejected", async () => {
    const harness = await createHarness();
    const seeded = await seedEditFromHereConversation(harness);
    await harness.drain();
    const before = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    harness.provider.startSession.mockClear();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "keep root change\n", "utf8");

    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: CommandId.make("edit-dirty-root-request"),
      threadId: seeded.threadId,
      sourceMessageId: seeded.user1,
      replacementMessageId: MessageId.make("edit-dirty-root-replacement"),
      editedText: "Rejected root replacement",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId ===
          "edit-dirty-root-request",
    );
    await harness.drain();

    const after = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    expect(harness.provider.startSession).not.toHaveBeenCalled();
    expect(after?.session).toEqual(before?.session);
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toContain(
      "keep root change",
    );
    expect(after?.messages.some((message) => message.id === seeded.user1)).toBe(true);
    expect(after?.messages.some((message) => message.id === "edit-dirty-root-replacement")).toBe(
      false,
    );
  });

  it("keeps bounded Git restore diagnostics on the failed edit activity without rewinding", async () => {
    const harness = await createHarness();
    const seeded = await seedEditFromHereConversation(harness);
    await harness.drain();
    const before = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    const fileBefore = NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8");
    const technicalDetail = JSON.stringify({
      operation: "GitVcsDriver.checkpoints.restoreCheckpoint",
      cwd: "C:\\repo\\apps\\server",
      checkpointRef: "refs/t3/threads/restore-failure",
      commitOid: "0123456789abcdef0123456789abcdef01234567",
      exitCode: 128,
      stdout: "diagnostic stdout",
      stderr: "fatal: token=[REDACTED]",
    });
    vi.spyOn(harness.checkpointStore, "restoreCheckpoint").mockImplementationOnce(() =>
      Effect.succeed({
        restored: false,
        reason: "checkpoint-invalid",
        detail: technicalDetail,
      }),
    );

    const requestId = CommandId.make("edit-restore-diagnostics");
    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: requestId,
      threadId: seeded.threadId,
      sourceMessageId: seeded.user2,
      replacementMessageId: MessageId.make("edit-restore-diagnostics-replacement"),
      editedText: "This replacement must not be projected",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId === requestId,
    );
    await harness.drain();

    const after = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    const failure = after?.activities.find(
      (activity) => activity.kind === "thread.edit-from-here.failed",
    );
    expect(failure?.payload).toMatchObject({
      requestId,
      reason: "checkpoint-invalid",
      technicalDetail: expect.stringContaining(
        `checkpoint-restore:checkpoint-invalid:${technicalDetail}`,
      ),
    });
    expect(after?.messages).toEqual(before?.messages);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(fileBefore);
  });

  it("rewinds the first message of a rehydrated branch task by resetting its provider binding", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const seeded = await seedEditFromHereConversation(harness);
    const branchThreadId = ThreadId.make("1662a599-73a7-424f-981a-1366aee6d944");
    const originalMessageId = MessageId.make("ae26aa09-5a76-439e-bdbd-4390cf4dc141");
    const originalAssistantId = MessageId.make("assistant:msg_032e740-live-shape");
    const originalTurnId = asTurnId("01a02bb5-live-shape");
    const branchRequestId = CommandId.make("404529a1-live-root-branch");

    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: branchRequestId,
      threadId: seeded.threadId,
      sourceMessageId: seeded.user1,
      replacementMessageId: originalMessageId,
      editedText: "Original branch message",
      mode: "branch",
      targetThreadId: branchThreadId,
      createdAt: seeded.createdAt,
    });
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId === branchRequestId,
    );
    await harness.drain();

    await harness.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.make("live-branch-assistant-delta"),
      threadId: branchThreadId,
      messageId: originalAssistantId,
      delta: "Original branch result",
      turnId: originalTurnId,
      createdAt: "2026-01-01T00:00:12.000Z",
    });
    await harness.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make("live-branch-assistant-complete"),
      threadId: branchThreadId,
      messageId: originalAssistantId,
      turnId: originalTurnId,
      createdAt: "2026-01-01T00:00:13.000Z",
    });
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("live-branch-stale-edit-failure"),
      threadId: branchThreadId,
      activity: {
        id: EventId.make("live-branch-stale-edit-failure"),
        tone: "error",
        kind: "thread.edit-from-here.failed",
        summary: "Edit from here failed",
        payload: { detail: "Error: old raw stack at A:\\Dev\\server.ts:1:1" },
        turnId: null,
        createdAt: "2026-01-01T00:00:13.500Z",
      },
      createdAt: "2026-01-01T00:00:13.500Z",
    });
    const sourceBefore = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    await harness.restartReactor();

    const restoreCheckpoint = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    const rewindRequest = {
      type: "thread.edit-from-here" as const,
      commandId: CommandId.make("404529a1-c203-4cbf-9c53-01a6cbd712f3"),
      threadId: branchThreadId,
      sourceMessageId: originalMessageId,
      replacementMessageId: MessageId.make("dd4aaf15-c142-4fd6-8cb9-dce81c6c38e3"),
      editedText: "Rewritten first branch message",
      mode: "rewind" as const,
      createdAt: "2026-01-01T00:00:14.000Z",
    };
    await harness.dispatch(rewindRequest);
    const finishedEvents = await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId ===
          rewindRequest.commandId,
    );
    await harness.drain();
    await harness.dispatch(rewindRequest);
    await harness.drain();

    const snapshot = await harness.readModel();
    const sourceAfter = snapshot.threads.find((thread) => thread.id === seeded.threadId);
    const branchAfter = snapshot.threads.find((thread) => thread.id === branchThreadId);
    expect(sourceAfter?.messages).toEqual(sourceBefore?.messages);
    expect(branchAfter?.id).toBe(branchThreadId);
    expect(branchAfter?.messages.map((message) => [message.id, message.text])).toEqual([
      [rewindRequest.replacementMessageId, "Rewritten first branch message"],
    ]);
    expect(branchAfter?.messages.some((message) => message.id === originalMessageId)).toBe(false);
    expect(branchAfter?.messages.some((message) => message.id === originalAssistantId)).toBe(false);
    expect(branchAfter?.activities).toEqual([
      expect.objectContaining({
        kind: "thread.edit-from-here.files-not-restored",
        payload: expect.objectContaining({ filesRestored: false, conversationOnly: true }),
      }),
    ]);
    expect(
      branchAfter?.messages.filter((message) => message.id === rewindRequest.replacementMessageId),
    ).toHaveLength(1);
    expect(restoreCheckpoint).not.toHaveBeenCalled();
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(harness.provider.forkConversation).not.toHaveBeenCalled();
    expect(harness.reconcileParentAfterRewind).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: branchThreadId,
        retainedTurnIds: new Set(),
        requestId: rewindRequest.commandId,
        discardUnattributed: true,
      }),
    );
    const branchStarts = harness.provider.startSession.mock.calls.filter(
      ([threadId]) => threadId === branchThreadId,
    );
    expect(branchStarts).toHaveLength(2);
    expect(branchStarts[1]?.[1]).toMatchObject({
      threadId: branchThreadId,
      resumeCursor: null,
    });
    const reverted = finishedEvents.find(
      (event) => event.type === "thread.reverted" && event.aggregateId === branchThreadId,
    );
    expect(reverted?.payload).toMatchObject({
      threadId: branchThreadId,
      turnCount: 0,
      sourceMessageId: originalMessageId,
      cutoffCreatedAt: seeded.createdAt,
      workspaceRestore: { filesRestored: false, conversationOnly: true },
    });
  });

  it("preserves root history when the fresh provider session cannot start", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const seeded = await seedEditFromHereConversation(harness);
    const sourceBefore = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    const requestId = CommandId.make("edit-root-rewind-start-failure");
    const replacementMessageId = MessageId.make("edit-root-rewind-start-failure-replacement");
    harness.provider.startSession.mockImplementationOnce(() =>
      Effect.die(new Error("fresh provider start failed")),
    );

    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: requestId,
      threadId: seeded.threadId,
      sourceMessageId: seeded.user1,
      replacementMessageId,
      editedText: "This replacement must not be projected",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId === requestId,
    );
    await harness.drain();

    const sourceAfter = (await harness.readModel()).threads.find(
      (thread) => thread.id === seeded.threadId,
    );
    expect(sourceAfter?.messages).toEqual(sourceBefore?.messages);
    expect(sourceAfter?.messages.some((message) => message.id === replacementMessageId)).toBe(
      false,
    );
    expect(
      sourceAfter?.activities.some((activity) => activity.kind === "thread.edit-from-here.failed"),
    ).toBe(true);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(harness.provider.forkConversation).not.toHaveBeenCalled();
    expect(harness.provider.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: seeded.threadId,
      resumeCursor: null,
    });
  });

  it("starts a fresh root session when the provider binding was rehydrated away", async () => {
    const harness = await createHarness({ hasSession: false, seedFilesystemCheckpoints: false });
    const seeded = await seedEditFromHereConversation(harness);
    const requestId = CommandId.make("edit-root-rewind-rehydrated-session");
    const replacementMessageId = MessageId.make("edit-root-rewind-rehydrated-replacement");

    await harness.dispatch({
      type: "thread.edit-from-here",
      commandId: requestId,
      threadId: seeded.threadId,
      sourceMessageId: seeded.user1,
      replacementMessageId,
      editedText: "Rewritten after provider rehydration",
      mode: "rewind",
      createdAt: seeded.createdAt,
    });
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.edit-from-here-finished" &&
        (event as { payload?: { requestId?: string } }).payload?.requestId === requestId,
    );
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === seeded.threadId,
    );
    expect(thread?.messages.map((message) => message.id)).toContain(replacementMessageId);
    expect(harness.provider.startSession).toHaveBeenCalledWith(
      seeded.threadId,
      expect.objectContaining({ cwd: harness.cwd, resumeCursor: null }),
    );
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-revert-no-session"),
      threadId: ThreadId.make("thread-1"),
      turnCount: 1,
      createdAt,
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
