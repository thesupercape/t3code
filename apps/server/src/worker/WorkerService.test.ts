import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkerActivationId,
  WorkerId,
  WorkerOperationError,
  workerDisplayNameFor,
  type WorkerActivation,
  type WorkerApprovalRequest,
  type WorkerMessage,
  type WorkerSummary,
  type ModelSelection,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { WorkerBackend, type WorkerBackendShape } from "./WorkerBackend.ts";
import { WorkerObserver } from "./WorkerObserver.ts";
import { __testing as WorkerServiceTesting } from "./WorkerService.ts";
import { WorkerStore, type StoredWorker, type WorkerStoreShape } from "./WorkerStore.ts";

const now = "2026-08-22T20:00:00.000Z";
const workerId = WorkerId.make("worker-approval");
const activationId = WorkerActivationId.make("activation-approval");
const requestId = ApprovalRequestId.make("request-approval");
const providerThreadId = ThreadId.make("t3-worker:worker-approval");
const providerInstanceId = ProviderInstanceId.make("codex");
const parentThreadId = ThreadId.make("parent-thread");

function makeMemoryWorkerStore() {
  const workers = new Map<WorkerId, StoredWorker>();
  const activations = new Map<WorkerActivationId, WorkerActivation>();
  const messages = new Map<WorkerId, Array<WorkerMessage>>();
  const approvals = new Map<WorkerId, WorkerApprovalRequest>();
  const providerEvents = new Map<WorkerId, Array<ProviderRuntimeEvent>>();
  const store = WorkerStore.of({
    saveWorker: (worker) => Effect.sync(() => void workers.set(worker.summary.id, worker)),
    getWorker: (id) => Effect.succeed(Option.fromNullishOr(workers.get(id))),
    listWorkers: () => Effect.succeed([...workers.values()]),
    saveActivation: (activation) =>
      Effect.sync(() => void activations.set(activation.id, activation)),
    getActivation: (id) => Effect.succeed(Option.fromNullishOr(activations.get(id))),
    listActivations: (id) =>
      Effect.succeed([...activations.values()].filter((activation) => activation.workerId === id)),
    findProviderActivation: (input) => {
      const candidates = [...activations.values()]
        .filter((activation) => activation.providerThreadId === input.providerThreadId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      const exact =
        input.providerTurnId === undefined
          ? undefined
          : candidates.find((activation) => activation.providerTurnId === input.providerTurnId);
      const fallback = candidates.find(
        (activation) => activation.status === "starting" && activation.providerTurnId === undefined,
      );
      const matched =
        exact ?? fallback ?? (input.providerTurnId === undefined ? candidates[0] : undefined);
      return Effect.succeed(
        matched === undefined
          ? Option.none()
          : Option.some({ workerId: matched.workerId, activationId: matched.id }),
      );
    },
    saveMessage: (message) =>
      Effect.sync(() => {
        messages.set(message.workerId, [...(messages.get(message.workerId) ?? []), message]);
      }),
    listMessages: (id) => Effect.succeed(messages.get(id) ?? []),
    saveApproval: (approval) => Effect.sync(() => void approvals.set(approval.workerId, approval)),
    getPendingApproval: (id) =>
      Effect.succeed(
        Option.fromNullishOr(
          approvals.get(id)?.status === "pending" ? approvals.get(id) : undefined,
        ),
      ),
    resolveApproval: (input) =>
      Effect.sync(() => {
        for (const [id, approval] of approvals) {
          if (approval.requestId === input.requestId) {
            approvals.set(id, { ...approval, status: "resolved", ...input });
          }
        }
      }),
    saveObserverReport: () => Effect.void,
    listObserverReports: () => Effect.succeed([]),
    saveWaitLease: () => Effect.void,
    finishWaitLease: () => Effect.void,
    appendProviderEvent: (input) =>
      Effect.sync(() => {
        const event = input.payload as ProviderRuntimeEvent;
        const existing = providerEvents.get(input.workerId) ?? [];
        if (!existing.some((candidate) => candidate.eventId === event.eventId)) {
          providerEvents.set(input.workerId, [...existing, event]);
        }
      }),
    listProviderEvents: (id) => Effect.succeed(providerEvents.get(id) ?? []),
  } satisfies WorkerStoreShape);
  return { store, workers, activations, messages, providerEvents };
}

const workerLayer = (store: WorkerStoreShape, backend: WorkerBackendShape) =>
  Layer.mergeAll(
    Layer.succeed(WorkerStore, store),
    Layer.succeed(WorkerBackend, backend),
    Layer.succeed(WorkerObserver, WorkerObserver.of({ observe: () => Effect.die("unused") })),
    NodeServices.layer,
  );

it("preserves provider input, output, and cached-input usage dimensions", () => {
  expect(
    WorkerServiceTesting.projectWorkerTokenUsage({
      usedTokens: 900,
      totalProcessedTokens: 1_250,
      inputTokens: 1_000,
      cachedInputTokens: 640,
      outputTokens: 250,
      reasoningOutputTokens: 75,
    }),
  ).toEqual({
    inputTokens: 1_000,
    cachedInputTokens: 640,
    outputTokens: 250,
    reasoningTokens: 75,
    totalTokens: 1_250,
  });

  expect(
    WorkerServiceTesting.projectWorkerTokenUsage({
      usedTokens: 12,
      inputTokens: 10,
      outputTokens: 2,
    }),
  ).toEqual({
    inputTokens: 10,
    outputTokens: 2,
    reasoningTokens: 0,
    totalTokens: 12,
  });
});

it.effect("persists Worker identity and exact model options across follow-up activations", () => {
  let stored: StoredWorker | undefined;
  let activation: WorkerActivation | undefined;
  const followUpModelSelections: Array<ModelSelection | undefined> = [];
  const messages: Array<WorkerMessage> = [];
  const providerThread = ThreadId.make("t3-worker-name-test");
  const store = WorkerStore.of({
    saveWorker: (worker) => Effect.sync(() => void (stored = worker)),
    getWorker: () => Effect.succeed(Option.fromNullishOr(stored)),
    listWorkers: () => Effect.succeed(stored === undefined ? [] : [stored]),
    saveActivation: (next) => Effect.sync(() => void (activation = next)),
    getActivation: () => Effect.succeed(Option.fromNullishOr(activation)),
    listActivations: () => Effect.succeed(activation === undefined ? [] : [activation]),
    findProviderActivation: () => Effect.succeed(Option.none()),
    saveMessage: (message) => Effect.sync(() => void messages.push(message)),
    listMessages: () => Effect.succeed(messages),
    saveApproval: () => Effect.void,
    getPendingApproval: () => Effect.succeed(Option.none()),
    resolveApproval: () => Effect.void,
    saveObserverReport: () => Effect.void,
    listObserverReports: () => Effect.succeed([]),
    saveWaitLease: () => Effect.void,
    finishWaitLease: () => Effect.void,
    appendProviderEvent: () => Effect.void,
    listProviderEvents: () => Effect.succeed([]),
  } satisfies WorkerStoreShape);
  const backend = WorkerBackend.of({
    start: () =>
      Effect.succeed({
        providerThreadId: providerThread,
        providerTurnId: TurnId.make("name-turn"),
      }),
    send: (input) =>
      Effect.sync(() => {
        followUpModelSelections.push(input.modelSelection);
        return {
          providerThreadId: providerThread,
          providerTurnId: TurnId.make("follow-up-turn"),
        };
      }),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(true),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const started = yield* service.start({
      parentThreadId,
      providerInstanceId,
      input: {
        displayName: "  Review Bot\n1  ",
        title: "Historical assignment title",
        assignment: "Inspect naming.",
        context: { references: [], snippets: [] },
        modelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "computerControl", value: "chrome" }],
        },
      },
    });
    expect(started.summary.displayName).toBe("Review Bot 1");
    expect(stored?.summary.displayName).toBe("Review Bot 1");
    const reloadedService = yield* WorkerServiceTesting.make;
    yield* reloadedService.send({
      workerId: started.summary.id,
      message: "Continue in Chrome.",
    });
    expect(followUpModelSelections[0]).toEqual({
      instanceId: providerInstanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "computerControl", value: "chrome" }],
    });

    const { modelSelection: _modelSelection, ...legacyWithoutModelSelection } = stored!;
    stored = legacyWithoutModelSelection;
    const legacyService = yield* WorkerServiceTesting.make;
    yield* legacyService.send({
      workerId: started.summary.id,
      message: "Continue with the legacy record.",
    });
    expect(followUpModelSelections[1]).toEqual({
      instanceId: providerInstanceId,
      model: "gpt-5.6-sol",
    });

    const { displayName: _displayName, ...legacySummary } = stored!.summary;
    const legacy = { ...stored!, summary: legacySummary };
    stored = legacy;
    const migrated = yield* service.get(started.summary.id);
    expect(migrated.summary.displayName).toBe(workerDisplayNameFor(started.summary.id));
    expect(stored?.summary.displayName).toBe(migrated.summary.displayName);
    const reloaded = yield* service.get(started.summary.id);
    expect(reloaded.summary.displayName).toBe(migrated.summary.displayName);
    expect(reloaded.summary.title).toBe("Historical assignment title");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkerStore, store),
        Layer.succeed(WorkerBackend, backend),
        Layer.succeed(WorkerObserver, WorkerObserver.of({ observe: () => Effect.die("unused") })),
        NodeServices.layer,
      ),
    ),
  );
});

it.effect("rejects an unsupported backend before persisting a Worker", () => {
  const memory = makeMemoryWorkerStore();
  let backendStarts = 0;
  const backend = WorkerBackend.of({
    start: () =>
      Effect.sync(() => {
        backendStarts += 1;
        return { providerThreadId, providerTurnId: TurnId.make("unused") };
      }),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(false),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const result = yield* service
      .start({
        parentThreadId,
        providerInstanceId,
        input: {
          title: "Unsupported backend",
          assignment: "Do not run.",
          context: { references: [], snippets: [] },
          backendPreference: "unsupported-backend",
        },
      })
      .pipe(Effect.result);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "WorkerOperationError",
        operation: "worker.start",
        message: "Worker backend 'unsupported-backend' is not supported by this server",
      });
    }
    expect(backendStarts).toBe(0);
    expect(memory.workers.size).toBe(0);
    expect(memory.activations.size).toBe(0);
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect("reconciles a delayed Desktop receipt into one canonical handoff", () => {
  const memory = makeMemoryWorkerStore();
  let completed = false;
  const backend = WorkerBackend.of({
    start: (input) => Effect.succeed({ providerThreadId: input.providerThreadId, pending: true }),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(false),
    observe: () =>
      Effect.succeed(
        completed
          ? { status: "completed" as const, handoff: "Native Desktop completed." }
          : undefined,
      ),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const started = yield* service.start({
      parentThreadId,
      providerInstanceId,
      input: {
        title: "Desktop assignment",
        assignment: "Use the native app.",
        context: { references: [], snippets: [] },
        backendPreference: "codex-desktop",
      },
    });
    expect(started.summary.status).toBe("starting");
    completed = true;
    yield* service.reconcileDesktop!;
    yield* service.reconcileDesktop!;
    const detail = yield* service.get(started.summary.id);
    expect(detail.summary.status).toBe("completed");
    expect(detail.messages.filter((message) => message.kind === "handoff")).toHaveLength(1);
    expect(detail.messages.find((message) => message.kind === "handoff")?.body).toBe(
      "Native Desktop completed.",
    );
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect("surfaces a native Desktop attention receipt as pending approval", () => {
  const memory = makeMemoryWorkerStore();
  const backend = WorkerBackend.of({
    start: (input) => Effect.succeed({ providerThreadId: input.providerThreadId, pending: true }),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(false),
    observe: () =>
      Effect.succeed({ status: "approval_required" as const, error: "Sign in to Desktop" }),
  });
  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const started = yield* service.start({
      parentThreadId,
      providerInstanceId,
      input: {
        title: "Desktop approval",
        assignment: "Use the native app.",
        context: { references: [], snippets: [] },
        backendPreference: "codex-desktop",
      },
    });
    yield* service.reconcileDesktop!;
    const detail = yield* service.get(started.summary.id);
    expect(detail.summary.status).toBe("waitingApproval");
    expect(detail.pendingApproval?.summary).toBe("Sign in to Desktop");
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect("settles a failed start durably and makes worker_wait return immediately", () => {
  const memory = makeMemoryWorkerStore();
  const backend = WorkerBackend.of({
    start: () =>
      Effect.fail(
        new WorkerOperationError({ operation: "worker.start", message: "provider refused start" }),
      ),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(false),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    yield* service
      .start({
        parentThreadId,
        providerInstanceId,
        input: {
          title: "Failure test",
          assignment: "Fail cleanly.",
          context: { references: [], snippets: [] },
        },
      })
      .pipe(Effect.flip);

    const failed = [...memory.workers.values()][0]!;
    expect(failed.summary.status).toBe("failed");
    expect(failed.summary.activeActivationId).toBeUndefined();
    expect([...memory.activations.values()][0]).toMatchObject({
      status: "failed",
      error: "provider refused start",
    });
    const waited = yield* service.wait({
      workerIds: [failed.summary.id],
      timeoutMillis: 1_000,
      until: ["failed"],
    });
    expect(waited).toMatchObject({ status: "woken", reason: "failed" });
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect("wakes worker_wait only for configured wake reasons", () => {
  const memory = makeMemoryWorkerStore();
  let turnIndex = 0;
  const backend = WorkerBackend.of({
    start: (input) =>
      Effect.succeed({
        providerThreadId: input.providerThreadId,
        providerTurnId: TurnId.make(`worker-start-${++turnIndex}`),
      }),
    send: (input) =>
      Effect.succeed({
        providerThreadId: input.providerThreadId,
        providerTurnId: TurnId.make(`worker-follow-up-${++turnIndex}`),
      }),
    interrupt: () => Effect.void,
    stop: () => Effect.void,
    respondToApproval: () => Effect.void,
    hasLiveSession: () => Effect.succeed(true),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const started = yield* service.start({
      parentThreadId,
      providerInstanceId,
      input: {
        title: "Wake reason filter",
        assignment: "Wait for a completion event.",
        context: { references: [], snippets: [] },
      },
    });
    const waitFiber = yield* Effect.forkChild(
      service.wait({
        workerIds: [started.summary.id],
        timeoutMillis: 5_000,
        wakeReasons: ["completed"],
      }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;

    yield* service.interrupt({ workerId: started.summary.id, force: true });
    const followUp = yield* service.send({
      workerId: started.summary.id,
      message: "Continue and finish the bounded assignment.",
    });
    const followUpActivation = followUp.activations.at(-1)!;
    yield* service.handleProviderEvent({
      eventId: EventId.make("wake-reason-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: followUpActivation.providerThreadId,
      turnId: followUpActivation.providerTurnId,
      createdAt: now,
      type: "turn.completed",
      payload: { state: "completed" },
    });

    expect(yield* Fiber.join(waitFiber)).toMatchObject({
      status: "woken",
      reason: "completed",
    });
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect(
  "keeps late events on their provider turn and publishes live tool and token updates",
  () => {
    const memory = makeMemoryWorkerStore();
    let turnIndex = 0;
    const backend = WorkerBackend.of({
      start: (input) =>
        Effect.succeed({
          providerThreadId: input.providerThreadId,
          providerTurnId: TurnId.make(`worker-turn-${++turnIndex}`),
        }),
      send: (input) =>
        Effect.succeed({
          providerThreadId: input.providerThreadId,
          providerTurnId: TurnId.make(`worker-turn-${++turnIndex}`),
        }),
      interrupt: () => Effect.die("unused"),
      stop: () => Effect.die("unused"),
      respondToApproval: () => Effect.die("unused"),
      hasLiveSession: () => Effect.succeed(true),
    });

    return Effect.gen(function* () {
      const service = yield* WorkerServiceTesting.make;
      const started = yield* service.start({
        parentThreadId,
        providerInstanceId,
        input: {
          title: "Browser acceptance",
          assignment: "Open Wikipedia.",
          context: { references: [], snippets: [] },
        },
      });
      const first = started.activations[0]!;
      const eventFiber = yield* Effect.forkChild(Stream.runHead(service.stream), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      yield* service.handleProviderEvent({
        eventId: EventId.make("tool-completed-live"),
        provider: ProviderDriverKind.make("codex"),
        threadId: first.providerThreadId,
        turnId: first.providerTurnId,
        createdAt: now,
        type: "item.completed",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          title: "chrome.navigate",
        },
      });
      expect(Option.getOrUndefined(yield* Fiber.join(eventFiber))).toMatchObject({
        workerId: started.summary.id,
        type: "updated",
      });

      const tokenFiber = yield* Effect.forkChild(Stream.runHead(service.stream), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      yield* service.handleProviderEvent({
        eventId: EventId.make("token-live"),
        provider: ProviderDriverKind.make("codex"),
        threadId: first.providerThreadId,
        turnId: first.providerTurnId,
        createdAt: now,
        type: "thread.token-usage.updated",
        payload: {
          usage: { usedTokens: 30, inputTokens: 20, outputTokens: 10 },
        },
      });
      expect(Option.getOrUndefined(yield* Fiber.join(tokenFiber))?.summary.usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      });

      yield* service.handleProviderEvent({
        eventId: EventId.make("assistant-final-no-delta"),
        provider: ProviderDriverKind.make("codex"),
        threadId: first.providerThreadId,
        turnId: first.providerTurnId,
        createdAt: now,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Wikipedia opened and the Wi-Fi page was downloaded.",
        },
      });
      yield* service.handleProviderEvent({
        eventId: EventId.make("first-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: first.providerThreadId,
        turnId: first.providerTurnId,
        createdAt: now,
        type: "turn.completed",
        payload: { state: "completed" },
      });
      expect((yield* service.get(started.summary.id)).messages.at(-1)?.body).toBe(
        "Wikipedia opened and the Wi-Fi page was downloaded.",
      );

      const followedUp = yield* service.send({
        workerId: started.summary.id,
        message: "Verify the saved file.",
      });
      const second = followedUp.activations.at(-1)!;
      yield* service.handleProviderEvent({
        eventId: EventId.make("second-turn-token"),
        provider: ProviderDriverKind.make("codex"),
        threadId: second.providerThreadId,
        turnId: second.providerTurnId,
        createdAt: now,
        type: "thread.token-usage.updated",
        payload: {
          usage: { usedTokens: 100, inputTokens: 70, outputTokens: 30 },
        },
      });
      yield* service.handleProviderEvent({
        eventId: EventId.make("late-first-token"),
        provider: ProviderDriverKind.make("codex"),
        threadId: first.providerThreadId,
        turnId: first.providerTurnId,
        createdAt: now,
        type: "thread.token-usage.updated",
        payload: {
          usage: { usedTokens: 40, inputTokens: 25, outputTokens: 15 },
        },
      });
      const afterLateEvent = yield* service.get(started.summary.id);
      expect(
        afterLateEvent.activations.find((item) => item.id === first.id)?.usageDelta,
      ).toMatchObject({
        totalTokens: 40,
      });
      expect(afterLateEvent.activations.find((item) => item.id === second.id)?.status).toBe(
        "running",
      );
      expect(afterLateEvent.summary.activeActivationId).toBe(second.id);
      expect(afterLateEvent.summary.usage.totalTokens).toBe(100);
    }).pipe(Effect.provide(workerLayer(memory.store, backend)));
  },
);

it.effect("does not overwrite a fast provider completion back to running", () => {
  const memory = makeMemoryWorkerStore();
  let handleEvent: ((event: ProviderRuntimeEvent) => Effect.Effect<void>) | undefined;
  const backend = WorkerBackend.of({
    start: (input) =>
      Effect.gen(function* () {
        const providerTurnId = TurnId.make("fast-complete-turn");
        yield* handleEvent!({
          eventId: EventId.make("fast-complete"),
          provider: ProviderDriverKind.make("codex"),
          threadId: input.providerThreadId,
          turnId: providerTurnId,
          createdAt: now,
          type: "turn.completed",
          payload: { state: "completed" },
        });
        return { providerThreadId: input.providerThreadId, providerTurnId };
      }),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(true),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    handleEvent = service.handleProviderEvent;
    const detail = yield* service.start({
      parentThreadId,
      providerInstanceId,
      input: {
        title: "Fast completion",
        assignment: "Finish before start returns.",
        context: { references: [], snippets: [] },
      },
    });
    expect(detail.summary.status).toBe("completed");
    expect(detail.summary.activeActivationId).toBeUndefined();
    expect(detail.activations[0]?.status).toBe("completed");
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect("records a failed follow-up activation without corrupting the completed Worker", () => {
  const memory = makeMemoryWorkerStore();
  const backend = WorkerBackend.of({
    start: (input) =>
      Effect.succeed({
        providerThreadId: input.providerThreadId,
        providerTurnId: TurnId.make("completed-before-follow-up"),
      }),
    send: () =>
      Effect.fail(
        new WorkerOperationError({ operation: "worker.send", message: "follow-up rejected" }),
      ),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(true),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const started = yield* service.start({
      parentThreadId,
      providerInstanceId,
      input: {
        title: "Follow-up failure",
        assignment: "Complete once.",
        context: { references: [], snippets: [] },
      },
    });
    yield* service.handleProviderEvent({
      eventId: EventId.make("complete-before-failed-follow-up"),
      provider: ProviderDriverKind.make("codex"),
      threadId: started.activations[0]!.providerThreadId,
      turnId: started.activations[0]!.providerTurnId,
      createdAt: now,
      type: "turn.completed",
      payload: { state: "completed" },
    });
    yield* service
      .send({ workerId: started.summary.id, message: "This follow-up should fail." })
      .pipe(Effect.flip);

    const detail = yield* service.get(started.summary.id);
    expect(detail.summary.status).toBe("completed");
    expect(detail.summary.activeActivationId).toBeUndefined();
    expect(detail.activations.at(-1)).toMatchObject({
      status: "failed",
      error: "follow-up rejected",
    });
  }).pipe(Effect.provide(workerLayer(memory.store, backend)));
});

it.effect("reconciles Worker lineage after rewind and stops discarded active work", () => {
  const retainedTurnId = TurnId.make("turn-retained");
  const discardedTurnId = TurnId.make("turn-discarded");
  const makeStored = (
    id: string,
    status: WorkerSummary["status"],
    parentTurnId: TurnId | undefined,
  ): StoredWorker => {
    const idValue = WorkerId.make(id);
    const activeActivationId =
      status === "running" ? WorkerActivationId.make(`${id}-activation`) : undefined;
    return {
      summary: {
        id: idValue,
        title: id,
        status,
        backend: "codex",
        parentThreadId,
        providerInstanceId,
        model: "gpt-5.6-luna",
        runtimeMode: "full-access",
        createdAt: now,
        updatedAt: now,
        ...(activeActivationId === undefined ? {} : { activeActivationId }),
        lastActivityAt: now,
        unreadMessageCount: 0,
        activationCount: 1,
        resumable: true,
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      },
      assignment: id,
      context: { references: [], snippets: [] },
      ...(parentTurnId === undefined ? {} : { parentTurnId }),
    };
  };
  const retained = makeStored("worker-retained", "completed", retainedTurnId);
  const discardedCompleted = makeStored("worker-discarded-completed", "completed", undefined);
  const discardedActive = makeStored("worker-discarded-active", "running", discardedTurnId);
  const workers = new Map(
    [retained, discardedCompleted, discardedActive].map((worker) => [worker.summary.id, worker]),
  );
  const activations = new Map<WorkerId, ReadonlyArray<WorkerActivation>>([
    [
      retained.summary.id,
      [
        {
          id: WorkerActivationId.make("retained-activation"),
          workerId: retained.summary.id,
          status: "completed",
          providerInstanceId,
          providerThreadId: ThreadId.make("t3-worker-worker-retained"),
          parentTurnId: retainedTurnId,
          startedAt: now,
          finishedAt: now,
          lastActivityAt: now,
          usageBaseline: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
          usageDelta: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        },
      ],
    ],
    [discardedCompleted.summary.id, []],
    [
      discardedActive.summary.id,
      [
        {
          id: discardedActive.summary.activeActivationId!,
          workerId: discardedActive.summary.id,
          status: "running",
          providerInstanceId,
          providerThreadId: ThreadId.make("t3-worker-worker-discarded-active"),
          parentTurnId: discardedTurnId,
          startedAt: now,
          lastActivityAt: now,
          usageBaseline: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
          usageDelta: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        },
      ],
    ],
  ]);
  const stopped: Array<ThreadId> = [];
  let appendedProviderEvents = 0;
  const historicalResult = JSON.stringify({ summary: { id: discardedCompleted.summary.id } });
  const preRewindActivities = [
    {
      id: EventId.make("historical-worker-start"),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Start Worker",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "mcp__t3_code__worker_start",
            result: { content: [{ type: "text", text: historicalResult }] },
          },
        },
      },
      turnId: discardedTurnId,
      createdAt: now,
    },
  ];
  const store = WorkerStore.of({
    saveWorker: (worker) => Effect.sync(() => void workers.set(worker.summary.id, worker)),
    getWorker: (id) => Effect.succeed(Option.fromNullishOr(workers.get(id))),
    listWorkers: (input) =>
      Effect.succeed(
        [...workers.values()].filter(
          (worker) => input.includeDiscarded || worker.discardedAt === undefined,
        ),
      ),
    saveActivation: (activation) =>
      Effect.sync(() => {
        const current = activations.get(activation.workerId) ?? [];
        activations.set(
          activation.workerId,
          current.some((item) => item.id === activation.id)
            ? current.map((item) => (item.id === activation.id ? activation : item))
            : [...current, activation],
        );
      }),
    getActivation: (id) =>
      Effect.succeed(
        Option.fromNullishOr([...activations.values()].flat().find((item) => item.id === id)),
      ),
    listActivations: (id) => Effect.succeed(activations.get(id) ?? []),
    findProviderActivation: () =>
      Effect.succeed(
        Option.some({
          workerId: discardedActive.summary.id,
          activationId: discardedActive.summary.activeActivationId!,
        }),
      ),
    saveMessage: () => Effect.void,
    listMessages: () => Effect.succeed([]),
    saveApproval: () => Effect.void,
    getPendingApproval: () => Effect.succeed(Option.none()),
    resolveApproval: () => Effect.void,
    saveObserverReport: () => Effect.void,
    listObserverReports: () => Effect.succeed([]),
    saveWaitLease: () => Effect.void,
    finishWaitLease: () => Effect.void,
    appendProviderEvent: () => Effect.sync(() => void (appendedProviderEvents += 1)),
    listProviderEvents: () => Effect.succeed([]),
    // The live projection has already truncated future activity by apply time.
    listParentActivities: () => Effect.succeed([]),
  } satisfies WorkerStoreShape);
  const backend = WorkerBackend.of({
    start: () => Effect.die("unused"),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: (threadId) => Effect.sync(() => void stopped.push(threadId)),
    respondToApproval: () => Effect.die("unused"),
    hasLiveSession: () => Effect.succeed(true),
  });

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const eventFiber = yield* Effect.forkChild(Stream.runHead(service.stream), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    const discarded = yield* service.reconcileParentAfterRewind({
      parentThreadId,
      retainedTurnIds: new Set([retainedTurnId]),
      requestId: "rewind-request",
      discardUnattributed: false,
      parentActivities: preRewindActivities,
    });

    expect(discarded).toEqual([discardedCompleted.summary.id, discardedActive.summary.id]);
    expect(Option.getOrUndefined(yield* Fiber.join(eventFiber))).toMatchObject({
      type: "deleted",
      workerId: discardedCompleted.summary.id,
    });
    expect(stopped).toEqual([ThreadId.make("t3-worker-worker-discarded-active")]);
    expect((yield* service.list({ parentThreadId, includeClosed: true })).workers).toEqual([
      expect.objectContaining({ id: retained.summary.id }),
    ]);
    expect(yield* service.get(discardedActive.summary.id).pipe(Effect.flip)).toMatchObject({
      operation: "worker.read",
    });
    yield* service.handleProviderEvent({
      eventId: EventId.make("late-discarded-event"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("t3-worker-worker-discarded-active"),
      createdAt: now,
      type: "turn.completed",
      payload: { state: "completed" },
    });
    expect(appendedProviderEvents).toBe(0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkerStore, store),
        Layer.succeed(WorkerBackend, backend),
        Layer.succeed(WorkerObserver, WorkerObserver.of({ observe: () => Effect.die("unused") })),
        NodeServices.layer,
      ),
    ),
  );
});

it.effect("resumes persisted Worker status after an accepted provider approval", () => {
  const operations: Array<string> = [];
  let stored: StoredWorker = {
    summary: {
      id: workerId,
      title: "Approval worker",
      status: "waitingApproval",
      backend: "codex",
      parentThreadId,
      providerInstanceId,
      model: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      createdAt: now,
      updatedAt: now,
      activeActivationId: activationId,
      lastActivityAt: now,
      unreadMessageCount: 0,
      activationCount: 1,
      resumable: true,
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    } satisfies WorkerSummary,
    assignment: "Inspect the repository.",
    context: { references: [], snippets: [] },
  };
  let activation: WorkerActivation = {
    id: activationId,
    workerId,
    status: "waitingApproval",
    providerInstanceId,
    providerThreadId,
    runtimeMode: "approval-required",
    startedAt: now,
    lastActivityAt: now,
    usageBaseline: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    usageDelta: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
  };
  let approval: WorkerApprovalRequest | undefined = {
    requestId,
    workerId,
    activationId,
    kind: "provider-request",
    summary: "Approve command",
    requestedAt: now,
    status: "pending",
  };
  const messages: Array<WorkerMessage> = [];

  const store = WorkerStore.of({
    saveWorker: (next) =>
      Effect.sync(() => {
        stored = next;
        operations.push(`worker:${next.summary.status}`);
      }),
    getWorker: () => Effect.succeed(Option.some(stored)),
    listWorkers: () => Effect.succeed([stored]),
    saveActivation: (next) =>
      Effect.sync(() => {
        activation = next;
        operations.push(`activation:${next.status}`);
      }),
    getActivation: () => Effect.succeed(Option.some(activation)),
    listActivations: () => Effect.succeed([activation]),
    findProviderActivation: () => Effect.succeed(Option.some({ workerId, activationId })),
    saveMessage: (message) =>
      Effect.sync(() => {
        messages.push(message);
        operations.push(`message:${message.kind}`);
      }),
    listMessages: () => Effect.succeed(messages),
    saveApproval: (next) =>
      Effect.sync(() => {
        approval = next;
      }),
    getPendingApproval: () =>
      Effect.succeed(approval === undefined ? Option.none() : Option.some(approval)),
    resolveApproval: () =>
      Effect.sync(() => {
        approval = undefined;
        operations.push("approval:resolved");
      }),
    saveObserverReport: () => Effect.void,
    listObserverReports: () => Effect.succeed([]),
    saveWaitLease: () => Effect.void,
    finishWaitLease: () => Effect.void,
    appendProviderEvent: () => Effect.void,
    listProviderEvents: () =>
      Effect.succeed([
        {
          eventId: EventId.make("worker-tool-started"),
          provider: ProviderDriverKind.make("codex"),
          threadId: providerThreadId,
          createdAt: now,
          itemId: "worker-tool-item",
          type: "item.started",
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            title: "Inspect status",
            detail: "Command started",
          },
        } as ProviderRuntimeEvent,
        {
          eventId: EventId.make("worker-tool-completed"),
          provider: ProviderDriverKind.make("codex"),
          threadId: providerThreadId,
          createdAt: now,
          itemId: "worker-tool-item",
          type: "item.completed",
          payload: {
            itemType: "command_execution",
            title: "Inspect status",
            detail: "Command completed",
          },
        } as ProviderRuntimeEvent,
      ]),
    listParentActivities: () =>
      Effect.succeed([
        {
          id: EventId.make("parent-worker-start"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Start Worker",
          payload: {
            itemType: "mcp_tool_call",
            data: { item: { tool: "worker_start", status: "completed" } },
          },
          turnId: null,
          createdAt: now,
        },
      ]),
  } satisfies WorkerStoreShape);

  const backend = WorkerBackend.of({
    start: () => Effect.die("unused"),
    send: () => Effect.die("unused"),
    interrupt: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    respondToApproval: () =>
      Effect.sync(() => {
        operations.push("backend:accepted");
      }),
    hasLiveSession: () => Effect.succeed(true),
  } satisfies WorkerBackendShape);

  return Effect.gen(function* () {
    const service = yield* WorkerServiceTesting.make;
    const detail = yield* service.respondToApproval({ workerId, requestId, decision: "accept" });

    expect(operations).toEqual([
      "worker:waitingApproval",
      "backend:accepted",
      "approval:resolved",
      "activation:running",
      "worker:running",
      "message:approvalDecision",
      "worker:running",
    ]);
    expect(detail.summary.status).toBe("running");
    expect(detail.activations[0]?.status).toBe("running");
    expect(detail.pendingApproval).toBeUndefined();
    expect(detail.activities).toEqual([
      expect.objectContaining({
        id: "worker-tool-started",
        kind: "tool.completed",
        title: "Inspect status",
      }),
    ]);
    expect(detail.messages.at(-1)).toMatchObject({
      author: "parent",
      kind: "approvalDecision",
      body: "Approval accept",
    });
    const list = yield* service.list({ parentThreadId, includeClosed: true });
    expect(list.overview).toMatchObject({
      workersCreated: 1,
      workersActive: 1,
      toolCalls: 1,
      parentCoordinationCalls: 1,
      parentCoordinationCoverage: { status: "complete" },
      parentCoordinationTokenCoverage: { status: "unavailable" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkerStore, store),
        Layer.succeed(WorkerBackend, backend),
        Layer.succeed(WorkerObserver, WorkerObserver.of({ observe: () => Effect.die("unused") })),
        NodeServices.layer,
      ),
    ),
  );
});
