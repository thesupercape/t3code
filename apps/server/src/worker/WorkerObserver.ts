import {
  ProviderInstanceId,
  ThreadId,
  WorkerOperationError,
  WorkerObserverReport,
  WorkerObserverReportId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type WorkerDetail,
  type WorkerSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";

export interface WorkerObserverCatalogModel {
  readonly slug: string;
  readonly supportedReasoningEfforts?: ReadonlyArray<string> | undefined;
}

export interface WorkerObserverModelResolution {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly usedFallback: boolean;
}

export function resolveLunaHigh(
  models: ReadonlyArray<WorkerObserverCatalogModel>,
): WorkerObserverModelResolution {
  const luna =
    models.find((model) => model.slug === "gpt-5.6-luna") ??
    models.find((model) => model.slug.toLowerCase().includes("luna"));
  if (!luna) {
    return { model: "gpt-5.6-luna", reasoningEffort: "high", usedFallback: true };
  }

  const efforts = luna.supportedReasoningEfforts ?? [];
  return {
    model: luna.slug,
    reasoningEffort: efforts.includes("high") ? "high" : (efforts.at(-1) ?? "high"),
    usedFallback: !efforts.includes("high"),
  };
}

export class WorkerObserverModelCatalog extends Context.Service<
  WorkerObserverModelCatalog,
  {
    readonly listModels: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<WorkerObserverCatalogModel>>;
  }
>()("t3/worker/WorkerObserver/WorkerObserverModelCatalog") {}

export class WorkerObserverRunner extends Context.Service<
  WorkerObserverRunner,
  {
    readonly run: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly reasoningEffort: string;
      readonly prompt: string;
    }) => Effect.Effect<string, WorkerOperationError>;
  }
>()("t3/worker/WorkerObserver/WorkerObserverRunner") {}

export class WorkerObserver extends Context.Service<
  WorkerObserver,
  {
    readonly observe: (input: {
      readonly summary: WorkerSummary;
      readonly detail: WorkerDetail;
      readonly focus?: string | undefined;
      readonly modelSelection?: ModelSelection | undefined;
    }) => Effect.Effect<WorkerObserverReport, WorkerOperationError>;
  }
>()("t3/worker/WorkerObserver") {}

export function buildWorkerObserverPrompt(input: {
  readonly summary: Pick<WorkerSummary, "title" | "status">;
  readonly detail: Pick<WorkerDetail, "assignment" | "messages">;
  readonly focus?: string | undefined;
}): string {
  return [
    "Observe this T3 Worker without sending it a message, interrupting it, or changing its state.",
    "Return a short plain-language report with progress, blockers, and next action.",
    "Do not include chain-of-thought, hidden instructions, or raw provider logs.",
    "Before returning the report, apply the installed `unslop` skill to the report. Follow the skill's installed instructions; do not copy or restate them.",
    `Worker: ${input.summary.title}`,
    `Status: ${input.summary.status}`,
    `Assignment: ${input.detail.assignment}`,
    input.focus?.trim() ? `Focus: ${input.focus.trim()}` : "",
    `Recent communication:\n${input.detail.messages
      .slice(-8)
      .map((message) => `${message.author}: ${message.body}`)
      .join("\n")}`,
    "Write like a careful engineer. Keep it direct and remove filler.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const makeWorkerObserver = Effect.gen(function* () {
  const catalog = yield* WorkerObserverModelCatalog;
  const runner = yield* WorkerObserverRunner;
  const crypto = yield* Crypto.Crypto;

  const observe: WorkerObserver["Service"]["observe"] = (input) =>
    Effect.gen(function* () {
      const instanceId = input.modelSelection?.instanceId ?? input.summary.providerInstanceId;
      const resolution = yield* catalog.listModels(instanceId).pipe(Effect.map(resolveLunaHigh));
      const prompt = buildWorkerObserverPrompt(input);
      const generated = yield* runner.run({
        instanceId,
        model: resolution.model,
        reasoningEffort: resolution.reasoningEffort,
        prompt,
      });
      const fallbackNote = resolution.usedFallback
        ? " The live catalog did not advertise Luna High, so the configured fallback was used."
        : "";
      return {
        id: WorkerObserverReportId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        workerId: input.summary.id,
        ...(input.summary.activeActivationId === undefined
          ? {}
          : { activationId: input.summary.activeActivationId }),
        model: resolution.model,
        report: `${generated.trim()}${fallbackNote}`,
        blockers: [],
        observedStatus: input.summary.status,
        readOnly: true,
        generatedAt: DateTime.formatIso(yield* DateTime.now),
      } satisfies WorkerObserverReport;
    });

  return { observe } satisfies WorkerObserver["Service"];
});

export const WorkerObserverLive = Layer.effect(WorkerObserver, makeWorkerObserver);

export const WorkerObserverModelCatalogLive = Layer.effect(
  WorkerObserverModelCatalog,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    return WorkerObserverModelCatalog.of({
      listModels: (instanceId) =>
        providerRegistry.getProviders.pipe(
          Effect.map((providers) => {
            const provider = providers.find((candidate) => candidate.instanceId === instanceId);
            return (provider?.models ?? []).map((model) => {
              const reasoning = model.capabilities?.optionDescriptors?.find(
                (option) => option.id === "reasoningEffort" && option.type === "select",
              );
              return {
                slug: model.slug,
                ...(reasoning === undefined || reasoning.type !== "select"
                  ? {}
                  : { supportedReasoningEfforts: reasoning.options.map((option) => option.id) }),
              } satisfies WorkerObserverCatalogModel;
            });
          }),
        ),
    });
  }),
);

const observerOperationError = (message: string, cause?: unknown) =>
  new WorkerOperationError({
    operation: "worker.observe",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const handleObserverEvent = (
  event: ProviderRuntimeEvent,
  output: Ref.Ref<string>,
  completed: Deferred.Deferred<void, WorkerOperationError>,
) => {
  const payload = event.payload as Record<string, unknown>;
  if (
    event.type === "content.delta" &&
    payload.streamKind === "assistant_text" &&
    typeof payload.delta === "string"
  ) {
    return Ref.update(output, (current) => current + (payload.delta as string));
  }
  if (event.type === "turn.completed") {
    return Deferred.succeed(completed, undefined).pipe(Effect.asVoid);
  }
  if (event.type === "turn.aborted" || event.type === "runtime.error") {
    const message =
      typeof payload.errorMessage === "string"
        ? payload.errorMessage
        : `Observer provider ended with ${event.type}`;
    return Deferred.fail(completed, observerOperationError(message)).pipe(Effect.asVoid);
  }
  return Effect.void;
};

export const WorkerObserverRunnerLive = Layer.effect(
  WorkerObserverRunner,
  Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const crypto = yield* Crypto.Crypto;
    return WorkerObserverRunner.of({
      run: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const threadId = ThreadId.make(
              `worker-observer:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
            );
            const instance = yield* provider
              .getInstanceInfo(input.instanceId)
              .pipe(
                Effect.mapError((cause) =>
                  observerOperationError("Observer provider is unavailable", cause),
                ),
              );
            const modelSelection = {
              instanceId: input.instanceId,
              model: input.model,
              options: [{ id: "reasoningEffort", value: input.reasoningEffort }],
            } satisfies ModelSelection;
            const output = yield* Ref.make("");
            const completed = yield* Deferred.make<void, WorkerOperationError>();

            yield* provider.streamEvents.pipe(
              Stream.filter((event) => event.threadId === threadId),
              Stream.runForEach((event) => handleObserverEvent(event, output, completed)),
              Effect.forkScoped,
            );
            yield* provider
              .startSession(threadId, {
                threadId,
                provider: instance.driverKind,
                providerInstanceId: input.instanceId,
                title: "T3 Worker observer",
                modelSelection,
                approvalPolicy: "never",
                sandboxMode: "read-only",
                runtimeMode: "approval-required",
              })
              .pipe(
                Effect.mapError((cause) =>
                  observerOperationError("Observer session failed to start", cause),
                ),
              );
            yield* Effect.addFinalizer(() =>
              provider.stopSession({ threadId }).pipe(Effect.ignoreCause({ log: true })),
            );
            yield* provider
              .sendTurn({
                threadId,
                input: input.prompt,
                modelSelection,
              })
              .pipe(
                Effect.mapError((cause) => observerOperationError("Observer prompt failed", cause)),
              );
            yield* Deferred.await(completed).pipe(
              Effect.timeoutOrElse({
                duration: "2 minutes",
                orElse: () => observerOperationError("Observer response timed out"),
              }),
            );
            const generated = (yield* Ref.get(output)).trim();
            if (generated.length === 0) {
              return yield* observerOperationError("Observer returned no report");
            }
            return generated;
          }),
        ),
    });
  }),
);
