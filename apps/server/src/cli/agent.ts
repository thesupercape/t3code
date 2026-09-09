import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentId,
  EnvironmentAuthInvalidError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import {
  AGENT_ACTION_MAX_BYTES,
  AGENT_COMMAND_TYPES,
  AGENT_OUTPUT_MAX_BYTES,
  AGENT_RECEIPT_METADATA_MAX_BYTES,
  AgentCliError,
  agentCommandSchema,
  compactAgentSnapshot,
  decodeAgentAction,
  encodeAgentOutput,
  validateAgentAction,
  validateAgentIdentity,
  validateAgentOrigin,
  validateAgentReceiptMetadata,
  type AgentAction,
} from "./agentProtocol.ts";

const fail = (message: string) => Effect.fail(new AgentCliError({ message }));
const isAgentCliError = Schema.is(AgentCliError);
/** Expected CLI refusals must let pending native close callbacks drain on Windows. */
export const handleAgentCliFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(isAgentCliError, (error) =>
      Effect.gen(function* () {
        yield* Console.error(`Agent request rejected: ${error.message}`);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }),
    ),
  );
const isDispatchRejection = Schema.is(
  Schema.Union([
    EnvironmentAuthInvalidError,
    EnvironmentRequestInvalidError,
    EnvironmentScopeRequiredError,
  ]),
);
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      isAgentCliError(error) ? error : new AgentCliError({ message: "Invalid agent request." }),
  });
const boundedHttp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.mapError(
      () =>
        new AgentCliError({
          message:
            "Live server request failed. No credentials or server response body are included in this error.",
        }),
    ),
  );

export const resolveAgentTarget = Effect.fn("resolveAgentTarget")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(baseDir))
    return yield* fail("--base-dir must be an explicit absolute path.");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: true,
  });
  const runtime = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath).pipe(
    Effect.mapError(
      () =>
        new AgentCliError({
          message: "Cannot read runtime state from the selected data directory.",
        }),
    ),
  );
  if (Option.isNone(runtime))
    return yield* fail(
      "No running server is recorded for this data directory. Agent commands have no offline fallback.",
    );
  const localIdText = yield* fs
    .readFileString(paths.environmentIdPath)
    .pipe(
      Effect.mapError(
        () => new AgentCliError({ message: "Cannot read the selected environment identity." }),
      ),
    );
  const environmentId = yield* checked(() => EnvironmentId.make(localIdText.trim()));
  const origin = yield* checked(() => validateAgentOrigin(runtime.value.origin));
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
  const descriptor = yield* boundedHttp(client.metadata.descriptor());
  if (descriptor.environmentId !== environmentId)
    return yield* fail(
      "Server descriptor does not match the selected environment. No token was issued or transmitted.",
    );
  return {
    environmentId,
    runtime: { pid: runtime.value.pid, startedAt: runtime.value.startedAt },
    origin,
    descriptor,
    runtimeStatePath: paths.serverRuntimeStatePath,
    dbPath: paths.dbPath,
  };
});
type AgentTarget = Effect.Success<ReturnType<typeof resolveAgentTarget>>;

export type AgentRequest =
  | { readonly kind: "capabilities"; readonly command?: string }
  | {
      readonly kind: "snapshot";
      readonly threadId?: ThreadId;
      readonly turnLimit: number;
      readonly offset?: number;
      readonly beforeCursor?: string;
    }
  | { readonly kind: "act"; readonly action: AgentAction };

export const withAgentSession = <A, E, R>(
  auth: Pick<EnvironmentAuth.EnvironmentAuth["Service"], "issueSession" | "revokeSession">,
  operate: boolean,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    auth
      .issueSession({
        ttl: Duration.minutes(2),
        label: "t3 agent cli",
        scopes: operate
          ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
          : [AuthOrchestrationReadScope],
      })
      .pipe(
        Effect.mapError(
          () => new AgentCliError({ message: "Could not issue a short-lived agent session." }),
        ),
      ),
    (issued) => run(issued.token),
    (issued) =>
      auth
        .revokeSession(issued.sessionId)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning(
              "Agent session cleanup failed; the session expires after two minutes.",
            ),
          ),
        ),
  );

/** Existing environment-wide authorization and HTTP commands, without an offline engine. */
export const executeAgentRequest = Effect.fn("executeAgentRequest")(function* (
  target: AgentTarget,
  request: AgentRequest,
  auth: Pick<EnvironmentAuth.EnvironmentAuth["Service"], "issueSession" | "revokeSession">,
) {
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: target.origin });
  return yield* withAgentSession(auth, request.kind === "act", (token) =>
    Effect.gen(function* () {
      const headers = { authorization: `Bearer ${token}` };
      const shell = yield* boundedHttp(client.orchestration.shellSnapshot({ headers }));
      const context = {
        environmentId: target.environmentId,
        runtime: target.runtime,
        origin: target.origin,
      };
      if (request.kind === "capabilities") {
        const capabilities = target.descriptor.capabilities;
        const commands = AGENT_COMMAND_TYPES.filter((type) => {
          if (type === "thread.pin" || type === "thread.unpin")
            return capabilities.threadPinning === true;
          if (type === "thread.settle" || type === "thread.unsettle")
            return capabilities.threadSettlement === true;
          return true;
        });
        if (request.command !== undefined && !commands.some((type) => type === request.command))
          return yield* fail("Command is not advertised by this running server.");
        return {
          ...context,
          serverVersion: target.descriptor.serverVersion,
          snapshotSequence: shell.snapshotSequence,
          commands,
          commandSchema: request.command
            ? yield* checked(() => agentCommandSchema(request.command!))
            : undefined,
          actionEnvelope: {
            environmentId: target.environmentId,
            runtime: target.runtime,
            command: "Use capabilities --command <type> for its existing JSON Schema.",
          },
          authentication: {
            scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            scopeBoundary: "environment-wide, not thread-bound",
            ttlSeconds: 120,
            cleanup: "session revoked on exit",
          },
          limits: {
            actionBytes: AGENT_ACTION_MAX_BYTES,
            outputBytes: AGENT_OUTPUT_MAX_BYTES,
            receiptMetadataBytes: AGENT_RECEIPT_METADATA_MAX_BYTES,
            turnLimit: 5,
          },
          restrictions: [
            "--confirm required for act",
            "Unique commandId for each distinct payload; never automatically retry an action",
            "New threads use approval-required mode and the project's existing checkout",
            "No bootstrap, deletes, checkpoint rewinds, runtime mode changes, or session-wide approval",
            "Metadata updates change titles only",
            "Send preserves existing runtimeMode; steer/interrupt require the observed active turn ID",
            "Receipt confirms persisted acceptance, not provider execution or completion",
            "Local preflight identity checks are not atomic server-side concurrency guards",
            "No visible browser navigation or subscription-based wait",
          ],
        };
      }
      const threadId =
        request.kind === "snapshot"
          ? request.threadId
          : "threadId" in request.action.command && request.action.command.type !== "thread.create"
            ? request.action.command.threadId
            : undefined;
      // GET query fields are the endpoint's payload, including its optional history cursor.
      const loadThread = (id: ThreadId, turnLimit = 3, beforeCursor?: string) =>
        boundedHttp(
          client.orchestration.threadSnapshot({
            headers,
            params: { threadId: id },
            payload: { turnLimit, ...(beforeCursor ? { beforeCursor } : {}) },
          }),
        );
      const detail = threadId
        ? yield* loadThread(
            threadId,
            request.kind === "snapshot" ? request.turnLimit : 3,
            request.kind === "snapshot" ? request.beforeCursor : undefined,
          )
        : undefined;
      if (request.kind === "snapshot")
        return { ...context, ...compactAgentSnapshot(target, shell, detail, request.offset) };
      const { action } = request;
      yield* checked(() =>
        validateAgentAction(action, target, shell, detail, target.descriptor.capabilities),
      );
      const runtimeNow = yield* readPersistedServerRuntimeState(target.runtimeStatePath).pipe(
        Effect.mapError(
          () => new AgentCliError({ message: "Runtime state cannot be checked before dispatch." }),
        ),
      );
      if (Option.isNone(runtimeNow))
        return yield* fail("Server runtime disappeared before dispatch.");
      yield* checked(() =>
        validateAgentIdentity(action, {
          environmentId: target.environmentId,
          runtime: runtimeNow.value,
        }),
      );
      const descriptorNow = yield* boundedHttp(client.metadata.descriptor());
      if (descriptorNow.environmentId !== action.environmentId)
        return yield* fail("Server identity changed before dispatch.");
      const command = action.command;
      const commandTarget = {
        ...("threadId" in command ? { threadId: command.threadId } : {}),
        ...("projectId" in command ? { projectId: command.projectId } : {}),
        ...(command.type === "thread.turn.start" ? { messageId: command.message.messageId } : {}),
        ...(command.type === "thread.turn.steer"
          ? { turnId: command.expectedTurnId, messageId: command.messageId }
          : {}),
        ...(command.type === "thread.turn.interrupt" ? { turnId: command.turnId } : {}),
        ...("requestId" in command ? { requestId: command.requestId } : {}),
      };
      const receiptMetadata = {
        ...context,
        commandId: command.commandId,
        commandType: command.type,
        target: commandTarget,
      };
      yield* checked(() => validateAgentReceiptMetadata(receiptMetadata));
      const receipt = yield* Effect.result(
        client.orchestration
          .dispatch({ headers, payload: command } as Parameters<
            typeof client.orchestration.dispatch
          >[0])
          .pipe(Effect.timeout(Duration.seconds(10))),
      );
      if (receipt._tag === "Failure" && isDispatchRejection(receipt.failure))
        return {
          ...receiptMetadata,
          status: "rejected",
          rejection: { code: receipt.failure.code, traceId: receipt.failure.traceId },
          message:
            "The server rejected the request before orchestration dispatch. No action was retried.",
        };
      if (receipt._tag === "Failure")
        return {
          ...receiptMetadata,
          status: "unknown",
          message:
            "Dispatch did not return a receipt. It may have been accepted. Inspect the target before any further action; this CLI did not retry.",
        };
      const readback = yield* Effect.result(
        Effect.gen(function* () {
          const nextShell = yield* boundedHttp(client.orchestration.shellSnapshot({ headers }));
          const nextDetail =
            "threadId" in command ? yield* loadThread(command.threadId) : undefined;
          return compactAgentSnapshot(target, nextShell, nextDetail);
        }),
      );
      return {
        ...receiptMetadata,
        status: "accepted",
        sequence: receipt.success.sequence,
        providerCompletion: "not-confirmed",
        projectionObserved:
          readback._tag === "Success" &&
          readback.success.snapshotSequence >= receipt.success.sequence,
        readback: readback._tag === "Success" ? readback.success : undefined,
        readbackError:
          readback._tag === "Failure" ? "Receipt accepted; subsequent readback failed." : undefined,
      };
    }),
  );
});

export const readAgentActionFile = Effect.fn("readAgentActionFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(filePath, { flag: "r" });
      const info = yield* file.stat;
      if (info.type !== "File" || info.size > BigInt(AGENT_ACTION_MAX_BYTES))
        return yield* fail("Action must be a regular file no larger than 256 KiB.");
      const bytes = new Uint8Array(AGENT_ACTION_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.byteLength) {
        const size = Number(yield* file.read(bytes.subarray(length)));
        if (size === 0) break;
        length += size;
      }
      if (length === 0) return yield* fail("Action file is empty.");
      if (length > AGENT_ACTION_MAX_BYTES) return yield* fail("Action file exceeds 256 KiB.");
      return yield* checked(() =>
        decodeAgentAction(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
        ),
      );
    }),
  ).pipe(
    Effect.mapError((error) =>
      isAgentCliError(error) ? error : new AgentCliError({ message: "Cannot read action file." }),
    ),
  );
});

const printOutput = Effect.fn("printAgentOutput")(function* (output: unknown) {
  const json = yield* checked(() => encodeAgentOutput(output));
  yield* Console.log(json);
});

const runAgent = Effect.fn("runAgent")(
  function* (baseDir: string, request: AgentRequest) {
    const logLevel = yield* GlobalFlag.LogLevel;
    const target = yield* resolveAgentTarget(baseDir);
    // Resolve the existing auth store only after checking the unauthenticated descriptor.
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, logLevel);
    const path = yield* Path.Path;
    if (
      path.normalize(config.dbPath) !== path.normalize(target.dbPath) ||
      path.normalize(config.serverRuntimeStatePath) !== path.normalize(target.runtimeStatePath)
    )
      return yield* fail(
        "Resolved auth storage differs from the selected runtime. No session was issued.",
      );
    const result = yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* executeAgentRequest(target, request, auth);
    }).pipe(
      Effect.provide(
        EnvironmentAuth.existingRuntimeLayer.pipe(Layer.provide(ServerConfig.layer(config))),
      ),
    );
    yield* printOutput(result);
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
);

const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Required absolute T3 data directory for the running local environment."),
);
const threadFlag = Flag.string("thread").pipe(Flag.withSchema(ThreadId), Flag.optional);
const capabilitiesCommand = Command.make("capabilities", {
  baseDir: baseDirFlag,
  command: Flag.choice("command", AGENT_COMMAND_TYPES).pipe(Flag.optional),
}).pipe(
  Command.withDescription("Show live semantic actions and optional existing command JSON Schema."),
  Command.withHandler((flags) =>
    runAgent(flags.baseDir, {
      kind: "capabilities",
      ...Option.match(flags.command, { onNone: () => ({}), onSome: (command) => ({ command }) }),
    }).pipe(handleAgentCliFailure),
  ),
);
const snapshotCommand = Command.make("snapshot", {
  baseDir: baseDirFlag,
  thread: threadFlag,
  turnLimit: Flag.integer("turn-limit").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
    Flag.withDefault(3),
  ),
  beforeCursor: Flag.string("before-cursor").pipe(Flag.optional),
  offset: Flag.integer("offset").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
    Flag.withDefault(0),
    Flag.withDescription(
      "Project/thread list offset, 25 entries per list; use listPage.nextOffset.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Read bounded projects/tasks, or one task's messages, activity and request IDs.",
  ),
  Command.withHandler((flags) => {
    if (Option.isSome(flags.beforeCursor) && Option.isNone(flags.thread))
      return fail("--before-cursor requires --thread.").pipe(handleAgentCliFailure);
    return runAgent(flags.baseDir, {
      kind: "snapshot",
      turnLimit: flags.turnLimit,
      offset: flags.offset,
      ...Option.match(flags.thread, { onNone: () => ({}), onSome: (threadId) => ({ threadId }) }),
      ...Option.match(flags.beforeCursor, {
        onNone: () => ({}),
        onSome: (beforeCursor) => ({ beforeCursor }),
      }),
    }).pipe(handleAgentCliFailure);
  }),
);
const actCommand = Command.make("act", {
  baseDir: baseDirFlag,
  file: Flag.string("file"),
  confirm: Flag.boolean("confirm"),
}).pipe(
  Command.withDescription(
    "Dispatch one confirmed typed action, then read back its target. Never retries.",
  ),
  Command.withHandler(
    Effect.fn(function* (flags) {
      if (!flags.confirm)
        return yield* fail("act requires --confirm after inspecting the action and its target.");
      const action = yield* readAgentActionFile(flags.file);
      yield* runAgent(flags.baseDir, { kind: "act", action });
    }, handleAgentCliFailure),
  ),
);

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription(
    "Inspect and control a running T3 environment through its authenticated semantic API.",
  ),
  Command.withSubcommands([capabilitiesCommand, snapshotCommand, actCommand]),
);
