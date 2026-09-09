// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDateInEffect:off
/** HTTP adapter for the native Codex desktop store and coordinator mailbox. */
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CodexDesktopSendMessageRequest,
  type CodexDesktopMessage,
  type CodexDesktopSendMessageResponse,
  type CodexDesktopStatusResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import {
  createCodexDesktopMailboxLayout,
  isCodexDesktopCoordinatorLeaseFresh,
  publishCodexDesktopRequest,
  readCodexDesktopCoordinatorLease,
  readCodexDesktopRequest,
  readCodexDesktopStatus,
  readCodexDesktopResult,
  type CodexDesktopCoordinatorStatus,
  type CodexDesktopCoordinatorResult,
} from "../worker/CodexDesktopMailbox.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexDesktopStore from "./CodexDesktopStore.ts";

const CODEX_PATH = "/api/codex";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const badRequest = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 });

const resultToResponse = (
  requestId: string,
  result: CodexDesktopCoordinatorResult | undefined,
  statusRecord: CodexDesktopCoordinatorStatus | undefined,
  queued = true,
): CodexDesktopSendMessageResponse => {
  if (result === undefined) {
    return { requestId, status: queued ? "queued" : "unknown", message: null, error: null };
  }
  if (result.status === "completed") {
    const message: CodexDesktopMessage | null = result.text
      ? {
          id: result.jobId,
          role: "assistant",
          text: result.text,
          createdAt: result.completedAt,
          tool: null,
        }
      : null;
    return { requestId, status: "sent", message, error: null };
  }
  if (
    result.status === "failed" ||
    result.status === "interrupted" ||
    result.status === "approval_required"
  ) {
    return { requestId, status: "error", message: null, error: result.error ?? result.status };
  }
  if (statusRecord?.status === "started" || statusRecord?.status === "running") {
    return { requestId, status: "sent", message: null, error: null };
  }
  if (result?.status === "claimed")
    return { requestId, status: "queued", message: null, error: null };
  return { requestId, status: "unknown", message: null, error: null };
};

const routeError = (cause: unknown) =>
  cause &&
  typeof cause === "object" &&
  "_tag" in cause &&
  (cause._tag === "EnvironmentAuthInvalidError" ||
    cause._tag === "EnvironmentInternalError" ||
    cause._tag === "EnvironmentScopeRequiredError")
    ? HttpServerRespondable.toResponse(cause as never)
    : Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "Codex desktop history is unavailable." },
          { status: 503 },
        ),
      );

export const codexDesktopRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        `${CODEX_PATH}/status`,
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
          const config = yield* ServerConfig.ServerConfig;
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const settings = yield* settingsService.getSettings;
          const layout = createCodexDesktopMailboxLayout(
            NodePath.join(config.baseDir, "codex-desktop-bridge"),
          );
          const lease = yield* Effect.promise(() => readCodexDesktopCoordinatorLease(layout));
          const status: CodexDesktopStatusResponse = isCodexDesktopCoordinatorLeaseFresh(lease)
            ? { status: "ready", hostId: lease?.hostId ?? null, error: null }
            : {
                status:
                  lease === undefined && settings.providers.codex.enabled
                    ? "starting"
                    : "unavailable",
                hostId: lease?.hostId ?? null,
                error:
                  settings.providers.codex.enabled && lease === undefined
                    ? null
                    : "Codex desktop coordinator is unavailable.",
              };
          return HttpServerResponse.jsonUnsafe(status);
        }).pipe(Effect.catch(routeError)),
      ),
      HttpRouter.add(
        "GET",
        `${CODEX_PATH}/threads`,
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.originalUrl, "http://127.0.0.1");
          return HttpServerResponse.jsonUnsafe(
            yield* store.listThreads({
              ...(url.searchParams.get("cursor") === null
                ? {}
                : { cursor: url.searchParams.get("cursor")! }),
              ...(url.searchParams.get("search") === null
                ? {}
                : { search: url.searchParams.get("search")! }),
            }),
          );
        }).pipe(Effect.catch(routeError)),
      ),
      HttpRouter.add(
        "GET",
        `${CODEX_PATH}/threads/:id`,
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.originalUrl, "http://127.0.0.1");
          const match = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)$/);
          const threadId = match?.[1];
          if (!threadId || !UUID_PATTERN.test(threadId))
            return badRequest("Invalid Codex thread ID.");
          yield* store.readThread(threadId, { limit: 1 });
          return HttpServerResponse.jsonUnsafe(
            yield* store.readThread(
              threadId,
              url.searchParams.get("beforeCursor") === null
                ? {}
                : { beforeCursor: url.searchParams.get("beforeCursor")! },
            ),
          );
        }).pipe(Effect.catch(routeError)),
      ),
      HttpRouter.add(
        "POST",
        `${CODEX_PATH}/threads/:id/messages`,
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.originalUrl, "http://127.0.0.1");
          const match = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/messages$/);
          const threadId = match?.[1];
          if (!threadId || !UUID_PATTERN.test(threadId))
            return badRequest("Invalid Codex thread ID.");
          const bodyJson = yield* Effect.result(request.json);
          if (Result.isFailure(bodyJson)) return badRequest("Invalid Codex message request.");
          const decoded = yield* Effect.result(
            Schema.decodeUnknownEffect(CodexDesktopSendMessageRequest)(bodyJson.success),
          );
          if (Result.isFailure(decoded)) return badRequest("Invalid Codex message request.");
          const body = decoded.success;
          if (!UUID_PATTERN.test(body.requestId)) return badRequest("requestId must be a UUID.");
          const config = yield* ServerConfig.ServerConfig;
          const mailbox = createCodexDesktopMailboxLayout(
            NodePath.join(config.baseDir, "codex-desktop-bridge"),
          );
          const existing = yield* Effect.promise(() =>
            readCodexDesktopRequest(mailbox, body.requestId),
          );
          if (
            existing !== undefined &&
            (existing.operation !== "send" ||
              existing.threadId !== threadId ||
              existing.message !== body.text)
          ) {
            return badRequest("requestId is already bound to a different Codex message.");
          }
          yield* Effect.promise(() =>
            publishCodexDesktopRequest(mailbox, {
              schemaVersion: 1,
              jobId: body.requestId,
              requestId: body.requestId,
              operation: "send",
              threadId,
              message: body.text,
              permissionMode: "fullAccess",
              requestedAt: existing?.requestedAt ?? new Date().toISOString(),
            }),
          );
          const result = yield* Effect.promise(() =>
            readCodexDesktopResult(mailbox, body.requestId),
          );
          const lease = yield* Effect.promise(() => readCodexDesktopCoordinatorLease(mailbox));
          return HttpServerResponse.jsonUnsafe(
            resultToResponse(
              body.requestId,
              result,
              yield* Effect.promise(() => readCodexDesktopStatus(mailbox, body.requestId)),
              isCodexDesktopCoordinatorLeaseFresh(lease),
            ),
          );
        }).pipe(Effect.catch(routeError)),
      ),
      HttpRouter.add(
        "GET",
        `${CODEX_PATH}/requests/:requestId`,
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.originalUrl, "http://127.0.0.1");
          const match = url.pathname.match(/^\/api\/codex\/requests\/([^/]+)$/);
          const requestId = match?.[1];
          if (!requestId || !UUID_PATTERN.test(requestId))
            return badRequest("Invalid Codex request ID.");
          const config = yield* ServerConfig.ServerConfig;
          const mailbox = createCodexDesktopMailboxLayout(
            NodePath.join(config.baseDir, "codex-desktop-bridge"),
          );
          const requestRecord = yield* Effect.promise(() =>
            readCodexDesktopRequest(mailbox, requestId),
          );
          const resultRecord = yield* Effect.promise(() =>
            readCodexDesktopResult(mailbox, requestId),
          );
          if (requestRecord === undefined && resultRecord === undefined) {
            return HttpServerResponse.jsonUnsafe(
              { error: "Codex request was not found." },
              { status: 404 },
            );
          }
          const lease = yield* Effect.promise(() => readCodexDesktopCoordinatorLease(mailbox));
          const statusRecord = yield* Effect.promise(() =>
            readCodexDesktopStatus(mailbox, requestId),
          );
          return HttpServerResponse.jsonUnsafe(
            resultToResponse(
              requestId,
              resultRecord,
              statusRecord,
              isCodexDesktopCoordinatorLeaseFresh(lease),
            ),
          );
        }).pipe(Effect.catch(routeError)),
      ),
    );
  }),
);

export const codexDesktopStoreLayer = CodexDesktopStore.layer;
