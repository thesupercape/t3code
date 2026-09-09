import { CommunityCheckFinding, CommunityCheckState, ResetCheckState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { toJsonSchemaObject } from "../textGeneration/TextGenerationUtils.ts";
import {
  resetCheckArgs,
  resetCheckPrompt,
  RESET_CHECK_TIMEOUT_MS,
  ResetResearchFinding,
  ResetPublicFeed,
  validateResearchFinding,
} from "./resetCheckResearch.ts";
import { communityCheckPrompt, validateCommunityFinding } from "./communityCheckResearch.ts";

export class ResetResearchFailed extends Data.TaggedError("ResetResearchFailed")<{
  readonly stage?: string;
}> {}
const decodeFinding = Schema.decodeUnknownEffect(Schema.fromJsonString(ResetResearchFinding));
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(ResetCheckState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(ResetCheckState));
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePublicFeed = Schema.decodeUnknownEffect(Schema.fromJsonString(ResetPublicFeed));
export const IDLE_RESET_CHECK = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
} satisfies ResetCheckState;

type ResearchState<Finding> = Omit<ResetCheckState, "result"> & { readonly result: Finding | null };

/** A fixed, read-only Luna job using the configured Codex sign-in, not an API key. */
const makeLunaResearch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettings.ServerSettingsService;
  return <Finding>(definition: {
    readonly schema: Schema.Top;
    readonly decode: (raw: string) => Effect.Effect<Finding, Schema.SchemaError>;
    readonly validate: (finding: Finding, checkedAt: number) => Omit<Finding, "timingBasis">;
    readonly prompt: (now: string, publicEvidence: string | null) => string;
  }) =>
    (now: string) =>
      Effect.gen(function* () {
        const config = (yield* settings.getSettings).providers.codex;
        const homeLayout = yield* resolveCodexHomeLayout(
          config.useDesktopAppDaemon ? { ...config, shadowHomePath: "" } : config,
        ).pipe(Effect.provideService(Path.Path, path));
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reset-check-" });
        const schemaPath = path.join(directory, "result-schema.json");
        const outputPath = path.join(directory, "result.json");
        const publicEvidence = yield* Effect.gen(function* () {
          const response = yield* HttpClient.get("https://resetbeacon.com/api/forecast");
          if (response.status !== 200) return null;
          const body = yield* response.text;
          if (body.length > 256_000) return null;
          const feed = yield* decodePublicFeed(body);
          const nowMs = yield* Clock.currentTimeMillis;
          if (
            !Number.isFinite(Date.parse(feed.calculatedAt)) ||
            !Number.isFinite(Date.parse(feed.validUntil)) ||
            Date.parse(feed.validUntil) <= nowMs ||
            Date.parse(feed.calculatedAt) > nowMs + 60_000 ||
            nowMs - Date.parse(feed.calculatedAt) > 60 * 60_000
          )
            return null;
          const evidence = yield* encodeUnknown(feed);
          return evidence.length <= 12_000 ? evidence : null;
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => null),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provideService(FetchHttpClient.RequestInit, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "error",
            cache: "no-cache",
          }),
        );
        yield* fs.writeFileString(
          schemaPath,
          yield* encodeUnknown(toJsonSchemaObject(definition.schema)),
        );
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          OPENAI_API_KEY: undefined,
          CODEX_API_KEY: undefined,
          ...(homeLayout.effectiveHomePath ? { CODEX_HOME: homeLayout.effectiveHomePath } : {}),
        };
        const spawn = yield* resolveSpawnCommand(
          config.binaryPath || "codex",
          resetCheckArgs(schemaPath, outputPath),
          { env: environment },
        );
        const child = yield* spawner.spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            cwd: directory,
            env: environment,
            shell: spawn.shell,
            stdin: {
              stream: Stream.encodeText(Stream.make(definition.prompt(now, publicEvidence))),
            },
            killSignal: "SIGTERM",
            forceKillAfter: "5 seconds",
          }),
        );
        const [exitCode] = yield* Effect.all(
          [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0)
          return yield* new ResetResearchFailed({ stage: `Codex exit ${exitCode}` });
        const info = yield* fs.stat(outputPath);
        if (Number(info.size) > 32_000)
          return yield* new ResetResearchFailed({ stage: "Oversized output" });
        const finding = yield* fs
          .readFileString(outputPath)
          .pipe(Effect.flatMap(definition.decode));
        const checkedAt = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => definition.validate(finding, checkedAt),
          catch: (error) =>
            new ResetResearchFailed({
              stage: error instanceof Error ? error.message : "Invalid finding",
            }),
        });
      }).pipe(
        Effect.scoped,
        Effect.mapError((error) =>
          error instanceof ResetResearchFailed
            ? error
            : new ResetResearchFailed({ stage: "Research process failed" }),
        ),
      );
});

export const makeResetResearch = makeLunaResearch.pipe(
  Effect.map((create) =>
    create({
      schema: ResetResearchFinding,
      decode: decodeFinding,
      validate: validateResearchFinding,
      prompt: resetCheckPrompt,
    }),
  ),
);
export const makeCommunityResearch = makeLunaResearch.pipe(
  Effect.map((create) =>
    create({
      schema: CommunityCheckFinding,
      decode: Schema.decodeUnknownEffect(Schema.fromJsonString(CommunityCheckFinding)),
      validate: validateCommunityFinding,
      prompt: communityCheckPrompt,
    }),
  ),
);

/** One environment-owned job survives page navigation and coalesces concurrent button presses. */
export const makeResetCheck = Effect.fn("makeResetCheck")(function* <Finding>(
  research: (now: string) => Effect.Effect<Finding, ResetResearchFailed>,
  initial: ResearchState<Finding> = IDLE_RESET_CHECK,
  save: (state: ResearchState<Finding>) => Effect.Effect<void> = () => Effect.void,
) {
  const scope = yield* Effect.scope;
  const state = yield* Ref.make(initial);
  const lock = yield* Semaphore.make(1);
  let worker: Fiber.Fiber<void, never> | undefined;
  const publish = (next: ResearchState<Finding>) =>
    Ref.set(state, next).pipe(Effect.andThen(save(next)));
  const start = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const now = yield* Clock.currentTimeMillis;
      if (current.status === "running") return current;
      const startedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
      const running: ResearchState<Finding> = {
        status: "running",
        startedAt,
        finishedAt: null,
        result: null,
        error: null,
      };
      yield* publish(running);
      worker = yield* research(startedAt).pipe(
        Effect.timeout(RESET_CHECK_TIMEOUT_MS),
        Effect.matchCauseEffect({
          onFailure: () =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((finished) =>
                publish({
                  ...running,
                  status: "failed",
                  finishedAt: DateTime.formatIso(DateTime.makeUnsafe(finished)),
                  error:
                    "Luna could not finish the check. Check the Codex sign-in and connection, then retry. Checks stop after 3 minutes.",
                }),
              ),
            ),
          onSuccess: (result) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((finished) =>
                publish({
                  ...running,
                  status: "completed",
                  finishedAt: DateTime.formatIso(DateTime.makeUnsafe(finished)),
                  result,
                }),
              ),
            ),
        }),
        Effect.forkIn(scope),
      );
      return running;
    }),
  );
  const cancel = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.status !== "running") return current;
      if (worker) yield* Fiber.interrupt(worker);
      const now = yield* Clock.currentTimeMillis;
      const cancelled: ResearchState<Finding> = {
        ...current,
        status: "cancelled",
        finishedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        error: null,
      };
      yield* publish(cancelled);
      return cancelled;
    }),
  );
  return { read: Ref.get(state), start, cancel };
});

export class UsageResetCheck extends Context.Service<
  UsageResetCheck,
  {
    readonly read: Effect.Effect<ResetCheckState>;
    readonly start: Effect.Effect<ResetCheckState>;
    readonly cancel: Effect.Effect<ResetCheckState>;
  }
>()("t3/usage/UsageResetCheck") {}

export const layerTest = Layer.succeed(UsageResetCheck, {
  read: Effect.succeed(IDLE_RESET_CHECK),
  start: Effect.succeed(IDLE_RESET_CHECK),
  cancel: Effect.succeed(IDLE_RESET_CHECK),
});

const makeSavedCheck = <Finding>(options: {
  readonly cacheName: string;
  readonly decode: (raw: string) => Effect.Effect<ResearchState<Finding>, Schema.SchemaError>;
  readonly encode: (state: ResearchState<Finding>) => Effect.Effect<string, Schema.SchemaError>;
  readonly research: (now: string) => Effect.Effect<Finding, ResetResearchFailed>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const cache = path.join(config.providerStatusCacheDir, options.cacheName);
    const saved = yield* Effect.gen(function* () {
      if (Number((yield* fs.stat(cache)).size) > 32_000) return IDLE_RESET_CHECK;
      return yield* fs.readFileString(cache).pipe(Effect.flatMap(options.decode));
    }).pipe(Effect.orElseSucceed(() => IDLE_RESET_CHECK));
    const initial: ResearchState<Finding> =
      saved.status === "running"
        ? {
            ...saved,
            status: "failed",
            error: "The server restarted during the last check. Press Check with Luna to retry.",
          }
        : saved;
    const save = (state: ResearchState<Finding>) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.providerStatusCacheDir, { recursive: true });
        yield* fs.writeFileString(`${cache}.tmp`, yield* options.encode(state));
        yield* fs.rename(`${cache}.tmp`, cache);
      }).pipe(Effect.catch(() => Effect.logWarning("Luna-check result could not be saved.")));
    return yield* makeResetCheck(options.research, initial, save);
  });

export const layer = Layer.effect(
  UsageResetCheck,
  Effect.flatMap(makeResetResearch, (research) =>
    makeSavedCheck({
      cacheName: "codex-reset-check.json",
      decode: decodeState,
      encode: encodeState,
      research,
    }),
  ),
);

export class UsageCommunityCheck extends Context.Service<
  UsageCommunityCheck,
  {
    readonly read: Effect.Effect<CommunityCheckState>;
    readonly start: Effect.Effect<CommunityCheckState>;
    readonly cancel: Effect.Effect<CommunityCheckState>;
  }
>()("t3/usage/UsageResetCheck/UsageCommunityCheck") {}

export const communityLayerTest = Layer.succeed(UsageCommunityCheck, {
  read: Effect.succeed(IDLE_RESET_CHECK),
  start: Effect.succeed(IDLE_RESET_CHECK),
  cancel: Effect.succeed(IDLE_RESET_CHECK),
});
export const communityLayer = Layer.effect(
  UsageCommunityCheck,
  Effect.flatMap(makeCommunityResearch, (research) =>
    makeSavedCheck({
      cacheName: "codex-community-check.json",
      decode: Schema.decodeUnknownEffect(Schema.fromJsonString(CommunityCheckState)),
      encode: Schema.encodeEffect(Schema.fromJsonString(CommunityCheckState)),
      research,
    }),
  ),
);
