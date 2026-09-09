import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { resolveAgentTarget, withAgentSession, executeAgentRequest } from "./agent.ts";
import { agentCommandSchema, decodeAgentAction, encodeAgentOutput } from "./agentProtocol.ts";

const now = "2026-08-31T04:00:00.000Z";
const runtime = {
  version: 1,
  pid: 123,
  port: 8282,
  origin: "http://127.0.0.1:8282",
  startedAt: now,
};
const descriptor = {
  environmentId: "env-a",
  label: "Scratch",
  platform: { os: "windows", arch: "x64" },
  serverVersion: "0.0.33",
  capabilities: { repositoryIdentity: true, threadPinning: true, threadSettlement: true },
};
const shell = { snapshotSequence: 12, projects: [], threads: [], updatedAt: now };
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fs = FileSystem.layerNoop({
  readFileString: (path) =>
    Effect.succeed(path.endsWith("environment-id") ? "env-a" : json(runtime)),
});

function fakeAuth() {
  const issued: Array<Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["issueSession"]>[0]> =
    [];
  const revoked: string[] = [];
  const auth = {
    issueSession: (
      input: Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["issueSession"]>[0],
    ) => {
      issued.push(input);
      return Effect.succeed({
        sessionId: AuthSessionId.make("session-a"),
        token: "private-test-token",
        method: "bearer-access-token" as const,
        scopes: input?.scopes ?? [],
        subject: "test",
        client: { deviceType: "bot" as const },
        expiresAt: DateTime.makeUnsafe(now),
      });
    },
    revokeSession: (id: AuthSessionId) =>
      Effect.sync(() => {
        revoked.push(id);
        return true;
      }),
  } satisfies Pick<EnvironmentAuth.EnvironmentAuth["Service"], "issueSession" | "revokeSession">;
  return { auth, issued, revoked };
}

const testLayer = Layer.mergeAll(fs, Path.layer, FetchHttpClient.layer);
const mockFetch = (
  handler: (url: string | Request | URL, options?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => {} });

describe("agent authentication", () => {
  it.effect("checks the descriptor without transmitting a token", () =>
    Effect.gen(function* () {
      const requests: Array<RequestInit | undefined> = [];
      const result = yield* resolveAgentTarget("/sandbox").pipe(
        Effect.provide(testLayer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          mockFetch(async (_url, options) => {
            requests.push(options);
            return Response.json(descriptor);
          }),
        ),
      );
      expect(result.environmentId).toBe("env-a");
      expect(new Headers(requests[0]?.headers).get("authorization")).toBeNull();
    }),
  );
  it.effect("rejects a wrong environment before acquiring any auth session", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        resolveAgentTarget("/sandbox").pipe(
          Effect.provide(testLayer),
          Effect.provideService(
            FetchHttpClient.Fetch,
            mockFetch(async () => Response.json({ ...descriptor, environmentId: "wrong" })),
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("issues minimum short-lived scopes and revokes on failed use", () =>
    Effect.gen(function* () {
      const state = fakeAuth();
      const result = yield* Effect.result(
        withAgentSession(state.auth, false, () => Effect.fail("failed read")),
      );
      expect(result._tag).toBe("Failure");
      expect(state.issued[0]?.scopes).toEqual([AuthOrchestrationReadScope]);
      expect(Duration.toMillis(state.issued[0]!.ttl!)).toBe(120000);
      expect(state.revoked).toEqual(["session-a"]);
      yield* withAgentSession(state.auth, true, () => Effect.void);
      expect(state.issued[1]?.scopes).toEqual([
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
      ]);
    }),
  );
});

describe("agent HTTP action receipt", () => {
  it.effect("rejects oversized receipt identity before HTTP dispatch", () =>
    Effect.gen(function* () {
      const state = fakeAuth();
      let dispatches = 0;
      const action = decodeAgentAction(
        json({
          environmentId: "env-a",
          runtime: { pid: 123, startedAt: now },
          command: {
            type: "project.create",
            commandId: "x".repeat(200 * 1024),
            projectId: "project-a",
            title: "Scratch",
            workspaceRoot: "/scratch",
            createdAt: now,
          },
        }),
      );
      expect(() =>
        encodeAgentOutput({
          status: "accepted",
          commandId: action.command.commandId,
          sequence: 13,
        }),
      ).toThrow();
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const target = yield* resolveAgentTarget("/sandbox");
          return yield* executeAgentRequest(target, { kind: "act", action }, state.auth);
        }).pipe(
          Effect.provide(testLayer),
          Effect.provideService(
            FetchHttpClient.Fetch,
            mockFetch(async (url) => {
              if (String(url).endsWith("/dispatch")) {
                dispatches++;
                return Response.json({ sequence: 13 });
              }
              return Response.json(String(url).includes("/.well-known/") ? descriptor : shell);
            }),
          ),
        ),
      );
      expect(dispatches).toBe(0);
      expect(result._tag).toBe("Failure");
      expect(state.revoked).toEqual(["session-a"]);
    }),
  );
  it.effect("reports an explicit auth refusal as rejected, not a provider failure", () =>
    Effect.gen(function* () {
      const state = fakeAuth();
      const action = decodeAgentAction(
        json({
          environmentId: "env-a",
          runtime: { pid: 123, startedAt: now },
          command: {
            type: "project.create",
            commandId: "command-denied",
            projectId: "project-a",
            title: "Scratch",
            workspaceRoot: "/scratch",
            createdAt: now,
          },
        }),
      );
      const result = yield* Effect.gen(function* () {
        const target = yield* resolveAgentTarget("/sandbox");
        return yield* executeAgentRequest(target, { kind: "act", action }, state.auth);
      }).pipe(
        Effect.provide(testLayer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          mockFetch(async (url) => {
            if (String(url).endsWith("/dispatch"))
              return Response.json(
                new EnvironmentAuthInvalidError({
                  code: "auth_invalid",
                  reason: "invalid_credential",
                  traceId: "trace-a",
                }),
                { status: 401 },
              );
            return Response.json(String(url).includes("/.well-known/") ? descriptor : shell);
          }),
        ),
      );
      expect(result).toMatchObject({
        status: "rejected",
        commandId: "command-denied",
        rejection: { code: "auth_invalid", traceId: "trace-a" },
      });
      expect(state.revoked).toEqual(["session-a"]);
    }),
  );
  it.effect("does not retry an uncertain dispatch and still revokes the session", () =>
    Effect.gen(function* () {
      const state = fakeAuth();
      let dispatchCount = 0;
      const request = decodeAgentAction(
        json({
          environmentId: "env-a",
          runtime: { pid: 123, startedAt: now },
          command: {
            type: "project.create",
            commandId: "command-a",
            projectId: "project-a",
            title: "Scratch",
            workspaceRoot: "/scratch",
            createdAt: now,
          },
        }),
      );
      const program = Effect.gen(function* () {
        const target = yield* resolveAgentTarget("/sandbox");
        return yield* executeAgentRequest(target, { kind: "act", action: request }, state.auth);
      });
      const result = yield* program.pipe(
        Effect.provide(testLayer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          mockFetch(async (url) => {
            if (String(url).endsWith("/dispatch")) {
              dispatchCount++;
              throw new Error("private-test-token transport failure");
            }
            return Response.json(String(url).includes("/.well-known/") ? descriptor : shell);
          }),
        ),
      );
      expect(result).toMatchObject({
        status: "unknown",
        commandId: "command-a",
        target: { projectId: "project-a" },
      });
      expect(json(result)).not.toContain("private-test-token");
      expect(dispatchCount).toBe(1);
      expect(state.revoked).toEqual(["session-a"]);
    }),
  );
  it("generates schema discovery from existing command definitions", () => {
    expect(json(agentCommandSchema("thread.create"))).toContain("runtimeMode");
    expect(json(agentCommandSchema("thread.turn.steer"))).toContain("expectedTurnId");
    expect(() => agentCommandSchema("thread.delete")).toThrow();
  });
  it.effect("keeps accepted receipts when readback fails without retrying", () =>
    Effect.gen(function* () {
      const state = fakeAuth();
      let dispatches = 0;
      const action = decodeAgentAction(
        json({
          environmentId: "env-a",
          runtime: { pid: 123, startedAt: now },
          command: {
            type: "project.create",
            commandId: "command-accepted",
            projectId: "project-a",
            title: "Scratch",
            workspaceRoot: "/scratch",
            createdAt: now,
          },
        }),
      );
      const result = yield* Effect.gen(function* () {
        const target = yield* resolveAgentTarget("/sandbox");
        return yield* executeAgentRequest(target, { kind: "act", action }, state.auth);
      }).pipe(
        Effect.provide(testLayer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          mockFetch(async (url) => {
            if (String(url).includes("/.well-known/")) return Response.json(descriptor);
            if (String(url).endsWith("/dispatch")) {
              dispatches++;
              return Response.json({ sequence: 13 });
            }
            if (dispatches > 0) throw new Error("readback unavailable");
            return Response.json(shell);
          }),
        ),
      );
      expect(result).toMatchObject({
        status: "accepted",
        commandId: "command-accepted",
        sequence: 13,
        providerCompletion: "not-confirmed",
        projectionObserved: false,
        readbackError: "Receipt accepted; subsequent readback failed.",
      });
      expect(dispatches).toBe(1);
      expect(state.revoked).toEqual(["session-a"]);
    }),
  );
});
