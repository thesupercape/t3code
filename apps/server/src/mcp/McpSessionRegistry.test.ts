import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { WORKER_PROVIDER_THREAD_PREFIX } from "../worker/WorkerThreadBoundary.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const codexInstanceId = ProviderInstanceId.make("codex");
const lunaSelection: ModelSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.6-luna",
  options: [{ id: "reasoningEffort", value: "medium" }],
};
const desktopSelection: ModelSelection = {
  ...lunaSelection,
  options: [...(lunaSelection.options ?? []), { id: "computerControl", value: "desktop" }],
};
const chromeSelection: ModelSelection = {
  ...lunaSelection,
  options: [{ id: "computerControl", value: "chrome" }],
};
const previewSelection: ModelSelection = {
  ...lunaSelection,
  options: [{ id: "computerControl", value: "preview" }],
};
const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (
  now: () => number,
  httpServer = fakeHttpServer,
  settings: {
    readonly enableAgentBrowserAccess?: boolean;
    readonly enableT3Workers?: boolean;
  } = {},
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpServer.HttpServer, httpServer),
          Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          ServerSettings.layerTest(settings),
          NodeServices.layer,
        ),
      ),
    );

it.effect("grants Worker capability to parent sessions but never Worker sessions", () =>
  Effect.gen(function* () {
    const disabledRegistry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      enableAgentBrowserAccess: true,
    });
    const disabled = yield* disabledRegistry.issue({
      threadId: ThreadId.make("thread-workers-disabled"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "approval-required",
    });
    const disabledToken = disabled.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const disabledScope = yield* disabledRegistry.resolve(disabledToken);
    expect(disabledScope?.capabilities.has("preview")).toBe(true);
    expect(disabledScope?.capabilities.has("workers")).toBe(false);

    const enabledRegistry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      enableAgentBrowserAccess: true,
      enableT3Workers: true,
    });
    const enabled = yield* enabledRegistry.issue({
      threadId: ThreadId.make("thread-workers-enabled"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: lunaSelection,
      runtimeMode: "full-access",
      workingDirectory: "A:/Dev/Worktrees/project",
    });
    const enabledToken = enabled.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const enabledScope = yield* enabledRegistry.resolve(enabledToken);
    expect(enabledScope?.capabilities.has("preview")).toBe(true);
    expect(enabledScope?.capabilities.has("workers")).toBe(true);
    expect(enabledScope?.runtimeMode).toBe("full-access");
    expect(enabledScope?.workingDirectory).toBe("A:/Dev/Worktrees/project");
    expect(enabledScope?.parentModelSelection).toEqual(lunaSelection);

    const worker = yield* enabledRegistry.issue({
      threadId: ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}nested-denied`),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerDriverKind: codexDriver,
      modelSelection: desktopSelection,
      runtimeMode: "full-access",
    });
    const workerToken = worker.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const workerScope = yield* enabledRegistry.resolve(workerToken);
    expect(workerScope?.capabilities.has("preview")).toBe(true);
    expect(workerScope?.capabilities.has("computer")).toBe(true);
    expect(workerScope?.capabilities.has("workers")).toBe(false);
  }),
);

it("derives preview and Worker capabilities independently", () => {
  const parent = ThreadId.make("thread-capability-matrix");
  const worker = ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}capability-matrix`);

  expect(
    Array.from(
      McpSessionRegistry.resolveMcpCapabilities(
        { enableAgentBrowserAccess: false, enableT3Workers: true },
        parent,
      ),
    ),
  ).toEqual(["workers"]);
  expect(
    Array.from(
      McpSessionRegistry.resolveMcpCapabilities(
        { enableAgentBrowserAccess: true, enableT3Workers: false },
        parent,
      ),
    ),
  ).toEqual(["preview"]);
  expect(
    Array.from(
      McpSessionRegistry.resolveMcpCapabilities(
        { enableAgentBrowserAccess: true, enableT3Workers: true },
        worker,
      ),
    ),
  ).toEqual(["preview"]);
});

it("derives computer capability from the canonical Codex mode", () => {
  const threadId = ThreadId.make("thread-computer-capability");
  const settings = { enableAgentBrowserAccess: false, enableT3Workers: false };

  for (const selection of [lunaSelection, desktopSelection, chromeSelection]) {
    expect(
      McpSessionRegistry.resolveMcpCapabilities(
        settings,
        threadId,
        selection,
        codexDriver,
        codexInstanceId,
      ).has("computer"),
    ).toBe(true);
  }
  expect(
    McpSessionRegistry.resolveMcpCapabilities(
      settings,
      threadId,
      previewSelection,
      codexDriver,
      codexInstanceId,
    ).has("computer"),
  ).toBe(false);
  expect(
    McpSessionRegistry.resolveMcpCapabilities(
      settings,
      threadId,
      desktopSelection,
      claudeDriver,
      codexInstanceId,
    ).has("computer"),
  ).toBe(false);
  expect(
    McpSessionRegistry.resolveMcpCapabilities(
      settings,
      threadId,
      {
        ...previewSelection,
        instanceId: ProviderInstanceId.make("different-codex-instance"),
      },
      codexDriver,
      codexInstanceId,
    ).has("computer"),
  ).toBe(true);
});

it("grants Worker computer control without nested Worker authority", () => {
  const worker = ThreadId.make(`${WORKER_PROVIDER_THREAD_PREFIX}computer-control`);
  const settings = { enableAgentBrowserAccess: true, enableT3Workers: true };
  const desktopCapabilities = McpSessionRegistry.resolveMcpCapabilities(
    settings,
    worker,
    desktopSelection,
    codexDriver,
    codexInstanceId,
  );
  const previewCapabilities = McpSessionRegistry.resolveMcpCapabilities(
    settings,
    worker,
    previewSelection,
    codexDriver,
    codexInstanceId,
  );

  expect(desktopCapabilities.has("computer")).toBe(true);
  expect(desktopCapabilities.has("workers")).toBe(false);
  expect(previewCapabilities.has("computer")).toBe(false);
  expect(previewCapabilities.has("preview")).toBe(true);
});

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      runtimeMode: "approval-required",
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      runtimeMode: "auto-accept-edits",
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("binds a live MCP credential to the active parent turn", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-parent-lineage");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const parentTurnId = TurnId.make("turn-parent-lineage");

    yield* registry.touch(threadId, lunaSelection, parentTurnId);

    expect(yield* registry.resolve(token)).toMatchObject({
      parentModelSelection: lunaSelection,
      parentTurnId,
    });
  }),
);

it.effect("refreshes computer authority with the parent model selection", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      enableT3Workers: true,
    });
    const threadId = ThreadId.make("thread-model-refresh");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerDriverKind: codexDriver,
      modelSelection: desktopSelection,
      runtimeMode: "full-access",
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect((yield* registry.resolve(token))?.capabilities.has("computer")).toBe(true);

    yield* registry.touch(threadId, previewSelection);
    const previewScope = yield* registry.resolve(token);
    expect(previewScope?.parentModelSelection).toEqual(previewSelection);
    expect(previewScope?.capabilities.has("computer")).toBe(false);

    yield* registry.touch(threadId, chromeSelection);
    const chromeScope = yield* registry.resolve(token);
    expect(chromeScope?.parentModelSelection).toEqual(chromeSelection);
    expect(chromeScope?.capabilities.has("computer")).toBe(true);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
