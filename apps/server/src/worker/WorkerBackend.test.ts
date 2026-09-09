// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOs from "node:os";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeCodexDesktopWorkerBackend, type WorkerBackendStartInput } from "./WorkerBackend.ts";
import {
  createCodexDesktopMailboxLayout,
  publishCodexDesktopBinding,
  publishCodexDesktopResult,
  renewCodexDesktopCoordinatorLease,
} from "./CodexDesktopMailbox.ts";

const makeConfig = (root: string) =>
  ({ baseDir: root, stateDir: root }) as ServerConfig.ServerConfig["Service"];

const makeInput = (root: string): WorkerBackendStartInput => ({
  providerThreadId: ThreadId.make("t3-worker-00000000-0000-4000-8000-000000000001"),
  providerInstanceId: ProviderInstanceId.make("codex-test"),
  title: "Desktop test",
  assignment: "Run the desktop assignment.",
  context: {} as WorkerBackendStartInput["context"],
  runtimeMode: "full-access",
  backendPreference: "codex-desktop",
  jobId: "00000000-0000-4000-8000-000000000002",
  requestId: "00000000-0000-4000-8000-000000000002",
  workerId: "00000000-0000-4000-8000-000000000003",
  activationId: "00000000-0000-4000-8000-000000000002",
  cwd: root,
});

describe("Codex Desktop Worker backend", () => {
  it("queues a durable request and binds the native child without using ProviderService", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-desktop-backend-"));
    const layout = createCodexDesktopMailboxLayout(NodePath.join(root, "codex-desktop-bridge"));
    const now = new Date();
    await renewCodexDesktopCoordinatorLease(layout, {
      schemaVersion: 1,
      coordinatorThreadId: "00000000-0000-4000-8000-000000000004",
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    const backend = await Effect.runPromise(
      makeCodexDesktopWorkerBackend().pipe(
        Effect.provide(Layer.succeed(ServerConfig.ServerConfig, makeConfig(root))),
      ),
    );
    const input = makeInput(root);
    const start = Effect.runPromise(backend.start(input));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await publishCodexDesktopBinding(layout, {
      schemaVersion: 1,
      jobId: input.jobId!,
      requestId: input.requestId!,
      operation: "start",
      childThreadId: "00000000-0000-4000-8000-000000000005",
      claimedAt: now.toISOString(),
      boundAt: new Date().toISOString(),
    });
    const activation = await start;
    expect(activation.pending).toBeUndefined();
    expect(activation.providerThreadId).toBe(input.providerThreadId);
    expect(activation.nativeThreadId).toBe("00000000-0000-4000-8000-000000000005");
  });

  it("fails explicitly when the native coordinator lease is absent", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-desktop-backend-"));
    const backend = await Effect.runPromise(
      makeCodexDesktopWorkerBackend().pipe(
        Effect.provide(Layer.succeed(ServerConfig.ServerConfig, makeConfig(root))),
      ),
    );
    const exit = await Effect.runPromiseExit(backend.start(makeInput(root)));
    expect(exit._tag).toBe("Failure");
  });

  it("publishes running then consumes the matching send receipt", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-desktop-backend-"));
    const layout = createCodexDesktopMailboxLayout(NodePath.join(root, "codex-desktop-bridge"));
    const now = new Date();
    await renewCodexDesktopCoordinatorLease(layout, {
      schemaVersion: 1,
      coordinatorThreadId: "00000000-0000-4000-8000-000000000004",
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const backend = await Effect.runPromise(
      makeCodexDesktopWorkerBackend().pipe(
        Effect.provide(Layer.succeed(ServerConfig.ServerConfig, makeConfig(root))),
      ),
    );
    const input = {
      ...makeInput(root),
      message: "Continue the assignment.",
      jobId: "00000000-0000-4000-8000-000000000006",
      requestId: "00000000-0000-4000-8000-000000000006",
      nativeThreadId: "00000000-0000-4000-8000-000000000005",
    };
    const send = Effect.runPromise(backend.send(input));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await publishCodexDesktopResult(layout, {
      schemaVersion: 1,
      jobId: input.jobId,
      requestId: input.requestId,
      operation: "send",
      status: "completed",
      childThreadId: input.nativeThreadId,
      text: "Desktop handoff",
      completedAt: new Date().toISOString(),
    });
    const activation = await send;
    expect(activation.completionStatus).toBe("completed");
    expect(activation.handoff).toBe("Desktop handoff");
  });
});
