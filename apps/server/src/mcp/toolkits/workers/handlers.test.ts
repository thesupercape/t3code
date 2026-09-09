import {
  ApprovalRequestId,
  EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkerDisabledError,
  WorkerId,
  WorkerOperationError,
  type WorkerDetail,
  type WorkerMcpStartInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerService from "../../../worker/WorkerService.ts";
import { WORKER_PROVIDER_THREAD_PREFIX } from "../../../worker/WorkerThreadBoundary.ts";
import { mapWorkerStartRequest, workerHandlers } from "./handlers.ts";

const parentThreadId = ThreadId.make("parent-thread");
const otherParentThreadId = ThreadId.make("other-parent-thread");
const workerId = WorkerId.make("worker-1");
const providerInstanceId = ProviderInstanceId.make("codex-parent");
const parentTurnId = TurnId.make("parent-turn");
const parentModelSelection: ModelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.6-luna",
  options: [
    { id: "reasoningEffort", value: "medium" },
    { id: "serviceTier", value: "default" },
  ],
};
const now = "2026-08-22T00:00:00.000Z";

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["workers"]),
  threadId: ThreadId = parentThreadId,
  runtimeMode: RuntimeMode = "full-access",
  modelSelection: ModelSelection | undefined = parentModelSelection,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId,
  ...(modelSelection === undefined ? {} : { parentModelSelection: modelSelection }),
  parentTurnId,
  runtimeMode,
  workingDirectory: "A:/Dev/Worktrees/project",
  capabilities,
  issuedAt: 1,
});

const detail = (owner: ThreadId = parentThreadId): WorkerDetail => ({
  summary: {
    id: workerId,
    title: "Persistence worker",
    status: "running",
    backend: "codex",
    parentThreadId: owner,
    providerInstanceId,
    model: "gpt-5.6-luna",
    runtimeMode: "full-access",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    unreadMessageCount: 0,
    activationCount: 1,
    resumable: true,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  },
  assignment: "Review persistence.",
  context: { references: [], snippets: [] },
  messages: [],
  activations: [],
  observerReports: [],
  activities: [],
});

const makeWorkerService = (
  overrides: Partial<WorkerService.WorkerServiceShape> = {},
): WorkerService.WorkerServiceShape => ({
  start: () => Effect.die("unused start"),
  list: () => Effect.die("unused list"),
  get: () => Effect.die("unused get"),
  send: () => Effect.die("unused send"),
  wait: () => Effect.die("unused wait"),
  observe: () => Effect.die("unused observe"),
  interrupt: () => Effect.die("unused interrupt"),
  close: () => Effect.die("unused close"),
  respondToApproval: () => Effect.die("unused approval"),
  handleProviderEvent: () => Effect.void,
  recover: Effect.void,
  stream: Stream.empty,
  ...overrides,
  reconcileParentAfterRewind:
    overrides.reconcileParentAfterRewind ?? (() => Effect.die("unused reconciliation")),
});

const provideHandler = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    McpInvocationContext.McpInvocationContext | WorkerService.WorkerService
  >,
  scope: McpInvocationContext.McpInvocationScope,
  service: WorkerService.WorkerServiceShape,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(WorkerService.WorkerService, service),
  );

it.effect("inherits parent permissions and strips model-authored permission overrides", () => {
  const untrustedInput = {
    title: "Persistence",
    assignment: "Review persistence.",
    context: { references: [], snippets: [] },
    modelSelection: {
      model: "gpt-5.6-luna",
    },
    parentThreadId: otherParentThreadId,
    runtimeMode: "approval-required",
    permissionMode: "readOnly",
    approvalPolicy: "untrusted",
    sandboxMode: "read-only",
  } as unknown as WorkerMcpStartInput;
  return Effect.gen(function* () {
    const mapped = yield* mapWorkerStartRequest(invocation(), untrustedInput);

    expect(mapped.parentThreadId).toBe(parentThreadId);
    expect(mapped.parentTurnId).toBe(parentTurnId);
    expect(mapped.providerInstanceId).toBe(providerInstanceId);
    expect(mapped.input.parentThreadId).toBe(parentThreadId);
    expect(mapped.input.modelSelection?.instanceId).toBe(providerInstanceId);
    expect(mapped.input.cwd).toBe("A:/Dev/Worktrees/project");
    expect(mapped.input.runtimeMode).toBe("full-access");
    expect(mapped.input.permissionMode).toBeUndefined();
    expect(mapped.input.approvalPolicy).toBeUndefined();
    expect(mapped.input.sandboxMode).toBeUndefined();
    expect(Object.hasOwn(mapped.input, "transcript")).toBe(false);

    const restricted = yield* mapWorkerStartRequest(
      invocation(new Set(["workers"]), parentThreadId, "approval-required"),
      untrustedInput,
    );
    expect(restricted.input.runtimeMode).toBe("approval-required");

    const defaulted = yield* mapWorkerStartRequest(
      { ...invocation(), runtimeMode: undefined },
      untrustedInput,
    );
    expect(defaulted.input.runtimeMode).toBe("full-access");
  });
});

it.effect("resolves an omitted Worker instance id from the parent invocation scope", () => {
  let started: WorkerService.WorkerStartRequest | undefined;
  const service = makeWorkerService({
    start: (request) => {
      started = request;
      return Effect.succeed(detail());
    },
  });
  return Effect.gen(function* () {
    yield* provideHandler(
      workerHandlers.worker_start({
        displayName: "Review Bot",
        title: "Luna review",
        assignment: "Inspect the provider boundary.",
        context: { references: [], snippets: [] },
        modelSelection: {
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
      invocation(),
      service,
    );

    expect(started?.providerInstanceId).toBe(providerInstanceId);
    expect(started?.input.displayName).toBe("Review Bot");
    expect(started?.input.modelSelection).toEqual({
      instanceId: providerInstanceId,
      model: "gpt-5.6-luna",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ],
    });
  });
});

it.effect("inherits the full parent model selection when modelSelection is omitted", () => {
  let started: WorkerService.WorkerStartRequest | undefined;
  const service = makeWorkerService({
    start: (request) => {
      started = request;
      return Effect.succeed(detail());
    },
  });
  return Effect.gen(function* () {
    yield* provideHandler(
      workerHandlers.worker_start({
        title: "Inherited Luna review",
        assignment: "Use the exact parent model.",
        context: { references: [], snippets: [] },
      }),
      invocation(),
      service,
    );

    expect(started?.input.modelSelection).toEqual(parentModelSelection);
  });
});

it.effect("rejects an explicit unsupported model before Worker creation", () => {
  let startCalled = false;
  const service = makeWorkerService({
    start: () => {
      startCalled = true;
      return Effect.succeed(detail());
    },
  });
  return Effect.gen(function* () {
    const error = yield* provideHandler(
      workerHandlers.worker_start({
        title: "Alias must fail",
        assignment: "Must not start.",
        context: { references: [], snippets: [] },
        modelSelection: { model: "luna" },
      }),
      invocation(),
      service,
    ).pipe(Effect.flip);

    expect(error).toBeInstanceOf(WorkerOperationError);
    expect(error.message).toContain("active supported model 'gpt-5.6-luna'");
    expect(error.message).toContain("Omit model");
    expect(error.message).toContain("display aliases are not accepted");
    expect(startCalled).toBe(false);
  });
});

it.effect("rejects an explicit Worker instance id that differs from the parent", () => {
  let startCalled = false;
  const service = makeWorkerService({
    start: () => {
      startCalled = true;
      return Effect.succeed(detail());
    },
  });
  return Effect.gen(function* () {
    const error = yield* provideHandler(
      workerHandlers.worker_start({
        title: "Wrong route",
        assignment: "Must not start.",
        context: { references: [], snippets: [] },
        modelSelection: {
          instanceId: ProviderInstanceId.make("another-codex"),
          model: "gpt-5.6-luna",
        },
      }),
      invocation(),
      service,
    ).pipe(Effect.flip);

    expect(error).toBeInstanceOf(WorkerOperationError);
    expect(error.message).toContain("does not match this parent provider instance");
    expect(error.message).toContain("Omit instanceId");
    expect(startCalled).toBe(false);
  });
});

it.effect("requires the workers capability before invoking the service", () => {
  const service = makeWorkerService({
    list: () => Effect.die("list must not run"),
  });
  return Effect.gen(function* () {
    const error = yield* provideHandler(
      workerHandlers.worker_list({}),
      invocation(new Set(["preview"])),
      service,
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(WorkerDisabledError);
  });
});

it.effect(
  "rejects nested worker_start even if a Worker session is mistakenly granted capability",
  () => {
    let startCalled = false;
    const service = makeWorkerService({
      start: () => {
        startCalled = true;
        return Effect.succeed(detail());
      },
    });
    return Effect.gen(function* () {
      const error = yield* provideHandler(
        workerHandlers.worker_start({
          title: "Nested Worker",
          assignment: "Must not start.",
          context: { references: [], snippets: [] },
        }),
        invocation(
          new Set(["workers"]),
          ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}${String(workerId)}`),
        ),
        service,
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerOperationError);
      expect(error.message).toBe("Worker sessions cannot invoke Worker tools.");
      expect(startCalled).toBe(false);
    });
  },
);

it.effect("rejects every Worker tool for a Worker-scoped caller before service dispatch", () => {
  const service = makeWorkerService();
  const workerScope = invocation(
    new Set(["workers"]),
    ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}${String(workerId)}`),
  );
  const requestId = ApprovalRequestId.make("approval-1");
  const attempts: ReadonlyArray<
    Effect.Effect<
      unknown,
      WorkerDisabledError | WorkerOperationError,
      McpInvocationContext.McpInvocationContext | WorkerService.WorkerService
    >
  > = [
    workerHandlers.worker_start({
      title: "Nested Worker",
      assignment: "Must not start.",
      context: { references: [], snippets: [] },
    }),
    workerHandlers.worker_list({}),
    workerHandlers.worker_wait({ workerIds: [workerId], timeoutMillis: 1_000 }),
    workerHandlers.worker_status({ workerId }),
    workerHandlers.worker_observe({ workerId }),
    workerHandlers.worker_send({ workerId, message: "Must not send." }),
    workerHandlers.worker_interrupt({ workerId }),
    workerHandlers.worker_close({ workerId }),
    workerHandlers.worker_approval_respond({
      workerId,
      requestId,
      decision: "decline",
    }),
  ];

  return Effect.gen(function* () {
    for (const attempt of attempts) {
      const error = yield* provideHandler(attempt, workerScope, service).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        }),
      );
      expect(error).toBeInstanceOf(WorkerOperationError);
      expect(error?.message).toBe("Worker sessions cannot invoke Worker tools.");
    }
  });
});

it.effect("forces list scope and rejects a Worker owned by another parent", () => {
  let listedParent: ThreadId | undefined;
  const service = makeWorkerService({
    list: (input) => {
      listedParent = input.parentThreadId;
      return Effect.succeed({ workers: [] });
    },
    get: () => Effect.succeed(detail(otherParentThreadId)),
  });
  return Effect.gen(function* () {
    yield* provideHandler(
      workerHandlers.worker_list({ parentThreadId: otherParentThreadId }),
      invocation(),
      service,
    );
    expect(listedParent).toBe(parentThreadId);

    const error = yield* provideHandler(
      workerHandlers.worker_status({ workerId }),
      invocation(),
      service,
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(WorkerOperationError);
    expect(error.message).toBe("Worker is not available in this parent scope");
  });
});

it.effect("routes approval responses only after ownership succeeds", () => {
  const requestId = ApprovalRequestId.make("approval-1");
  let response:
    | {
        readonly workerId: WorkerId;
        readonly requestId: ApprovalRequestId;
        readonly decision: "accept" | "decline" | "cancel";
      }
    | undefined;
  const service = makeWorkerService({
    get: () => Effect.succeed(detail()),
    respondToApproval: (input) => {
      response = input;
      return Effect.succeed(detail());
    },
  });
  return Effect.gen(function* () {
    yield* provideHandler(
      workerHandlers.worker_approval_respond({
        workerId,
        requestId,
        decision: "accept",
        note: "Approved for this activation.",
      }),
      invocation(),
      service,
    );
    expect(response).toMatchObject({ workerId, requestId, decision: "accept" });
  });
});
