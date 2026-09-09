import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProviderOptionSelection,
  type WorkerDetail,
  type WorkerId,
  type WorkerMcpStartInput,
  WorkerOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerService from "../../../worker/WorkerService.ts";
import { isWorkerLinkedProviderThreadId } from "../../../worker/WorkerThreadBoundary.ts";
import { WorkerToolkit } from "./tools.ts";

const mergeModelOptions = (
  inherited: ReadonlyArray<ProviderOptionSelection> | undefined,
  overrides: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> => {
  const merged = new Map<string, ProviderOptionSelection>();
  for (const option of inherited ?? []) merged.set(option.id, option);
  for (const option of overrides ?? []) merged.set(option.id, option);
  return [...merged.values()];
};

const resolveWorkerModelSelection = (
  scope: McpInvocationContext.McpInvocationScope,
  input: WorkerMcpStartInput,
): Effect.Effect<ModelSelection, WorkerOperationError> => {
  const inherited = scope.parentModelSelection;
  if (inherited === undefined) {
    return Effect.fail(
      new WorkerOperationError({
        operation: "worker.start",
        message:
          "The parent model selection is unavailable for this Worker call. Start a new parent turn, then omit modelSelection to inherit its supported provider model.",
      }),
    );
  }
  if (inherited.instanceId !== scope.providerInstanceId) {
    return Effect.fail(
      new WorkerOperationError({
        operation: "worker.start",
        message:
          "The parent model selection does not match its provider session. Start a new parent turn before starting a Worker.",
      }),
    );
  }
  const requestedInstanceId = input.modelSelection?.instanceId;
  if (requestedInstanceId !== undefined && requestedInstanceId !== inherited.instanceId) {
    return Effect.fail(
      new WorkerOperationError({
        operation: "worker.start",
        message: `Worker modelSelection.instanceId '${requestedInstanceId}' does not match this parent provider instance '${inherited.instanceId}'. Omit instanceId to inherit the parent automatically.`,
      }),
    );
  }
  const requestedModel = input.modelSelection?.model;
  if (input.backendPreference === "codex-desktop" && requestedModel !== undefined) {
    // Native Desktop owns model validation. Keep the parent provider instance
    // as T3 ownership metadata while allowing an exact native model slug.
    const options = mergeModelOptions(inherited.options, input.modelSelection?.options);
    return Effect.succeed({
      instanceId: inherited.instanceId,
      model: requestedModel,
      ...(options.length === 0 ? {} : { options }),
    });
  }
  if (requestedModel !== undefined && requestedModel !== inherited.model) {
    return Effect.fail(
      new WorkerOperationError({
        operation: "worker.start",
        message: `Worker model '${requestedModel}' is not the parent session's active supported model '${inherited.model}'. Omit model to inherit '${inherited.model}'. Exact provider model slugs are required; display aliases are not accepted.`,
      }),
    );
  }
  const options = mergeModelOptions(inherited.options, input.modelSelection?.options);
  return Effect.succeed({
    instanceId: inherited.instanceId,
    model: inherited.model,
    ...(options.length === 0 ? {} : { options }),
  });
};

export const mapWorkerStartRequest = (
  scope: McpInvocationContext.McpInvocationScope,
  input: WorkerMcpStartInput,
): Effect.Effect<WorkerService.WorkerStartRequest, WorkerOperationError> => {
  const cwd = input.cwd ?? scope.workingDirectory;
  return resolveWorkerModelSelection(scope, input).pipe(
    Effect.map((modelSelection) => ({
      parentThreadId: scope.threadId,
      ...(scope.parentTurnId === undefined ? {} : { parentTurnId: scope.parentTurnId }),
      providerInstanceId: scope.providerInstanceId,
      input: {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        title: input.title,
        assignment: input.assignment,
        context: input.context,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.backendPreference === undefined
          ? {}
          : { backendPreference: input.backendPreference }),
        runtimeMode: scope.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        parentThreadId: scope.threadId,
        ...(cwd === undefined ? {} : { cwd }),
        modelSelection,
      },
    })),
  );
};

const ownershipError = (operation: string) =>
  new WorkerOperationError({
    operation,
    message: "Worker is not available in this parent scope",
  });

const requireOwnedWorker = (
  workers: WorkerService.WorkerServiceShape,
  scope: McpInvocationContext.McpInvocationScope,
  workerId: WorkerId,
  operation: string,
): Effect.Effect<WorkerDetail, WorkerOperationError> =>
  workers
    .get(workerId)
    .pipe(
      Effect.flatMap((detail) =>
        detail.summary.parentThreadId === scope.threadId
          ? Effect.succeed(detail)
          : ownershipError(operation),
      ),
    );

const withWorkerScope = Effect.fn("WorkerToolkit.withScope")(function* <A>(
  operation: string,
  use: (
    workers: WorkerService.WorkerServiceShape,
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, WorkerOperationError>,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("workers");
  yield* requireParentScope(scope, operation);
  const workers = yield* WorkerService.WorkerService;
  return yield* use(workers, scope);
});

const requireParentScope = (
  scope: McpInvocationContext.McpInvocationScope,
  operation: string,
): Effect.Effect<void, WorkerOperationError> =>
  isWorkerLinkedProviderThreadId(scope.threadId)
    ? new WorkerOperationError({
        operation,
        message: "Worker sessions cannot invoke Worker tools.",
      })
    : Effect.void;

export const workerHandlers = {
  worker_start: (input) =>
    withWorkerScope("worker.start", (workers, scope) =>
      mapWorkerStartRequest(scope, input).pipe(Effect.flatMap((request) => workers.start(request))),
    ),
  worker_list: (input) =>
    withWorkerScope("worker.list", (workers, scope) =>
      workers.list({ ...input, parentThreadId: scope.threadId }),
    ),
  worker_wait: (input) =>
    withWorkerScope("worker.wait", (workers, scope) =>
      Effect.forEach(input.workerIds, (workerId) =>
        requireOwnedWorker(workers, scope, workerId, "worker.wait"),
      ).pipe(Effect.andThen(workers.wait(input))),
    ),
  worker_status: (input) =>
    withWorkerScope("worker.status", (workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.status"),
    ),
  worker_observe: (input) =>
    withWorkerScope("worker.observe", (workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.observe").pipe(
        Effect.andThen(workers.observe(input)),
      ),
    ),
  worker_send: (input) =>
    withWorkerScope("worker.send", (workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.send").pipe(
        Effect.andThen(workers.send(input)),
      ),
    ),
  worker_interrupt: (input) =>
    withWorkerScope("worker.interrupt", (workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.interrupt").pipe(
        Effect.andThen(workers.interrupt(input)),
      ),
    ),
  worker_close: (input) =>
    withWorkerScope("worker.close", (workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.close").pipe(
        Effect.andThen(workers.close(input.workerId)),
      ),
    ),
  worker_approval_respond: (input) =>
    withWorkerScope("worker.approvalRespond", (workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.approvalRespond").pipe(
        Effect.andThen(workers.respondToApproval(input)),
      ),
    ),
} satisfies Parameters<typeof WorkerToolkit.toLayer>[0];

export const WorkerToolkitHandlersLive = WorkerToolkit.toLayer(workerHandlers);
