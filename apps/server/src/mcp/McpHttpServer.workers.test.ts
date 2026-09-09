import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as WorkerService from "../worker/WorkerService.ts";
import * as ChromeAutomation from "../browser/ChromeAutomation.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ServerConfig from "../config.ts";

const workerService = WorkerService.WorkerService.of({
  start: () => Effect.die("unused start"),
  list: () => Effect.die("unused list"),
  get: () => Effect.die("unused get"),
  send: () => Effect.die("unused send"),
  wait: () => Effect.die("unused wait"),
  observe: () => Effect.die("unused observe"),
  interrupt: () => Effect.die("unused interrupt"),
  close: () => Effect.die("unused close"),
  respondToApproval: () => Effect.die("unused approval"),
  reconcileParentAfterRewind: () => Effect.die("unused reconciliation"),
  handleProviderEvent: () => Effect.void,
  recover: Effect.void,
  stream: Stream.empty,
});

const makeCatalogLayer = (enableT3Workers: boolean) =>
  McpHttpServer.makeToolkitRegistrationLive(enableT3Workers).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(
      Layer.succeed(
        ExternalLauncher.ExternalLauncher,
        ExternalLauncher.ExternalLauncher.of({
          resolveAvailableEditors: () => Effect.succeed([]),
          resolveFileManagerRevealKind: () => Effect.succeed(undefined),
          launchBrowser: () => Effect.void,
          launchEditor: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ChromeAutomation.ChromeAutomation,
        ChromeAutomation.ChromeAutomation.of({
          start: () => Effect.die("unused start"),
          stop: () => Effect.die("unused stop"),
          status: () => Effect.die("unused status"),
          listTabs: () => Effect.die("unused tabs"),
          selectTab: () => Effect.die("unused select"),
          navigate: () => Effect.die("unused navigate"),
          snapshot: () => Effect.die("unused snapshot"),
          screenshot: () => Effect.die("unused screenshot"),
          click: () => Effect.die("unused click"),
          fill: () => Effect.die("unused fill"),
          type: () => Effect.die("unused type"),
        }),
      ),
    ),
    Layer.provide(Layer.succeed(WorkerService.WorkerService, workerService)),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-catalog-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const workerToolNames = [
  "worker_start",
  "worker_list",
  "worker_wait",
  "worker_status",
  "worker_observe",
  "worker_send",
  "worker_interrupt",
  "worker_close",
  "worker_approval_respond",
] as const;

const computerToolNames = new Set([
  "computer_start",
  "computer_status",
  "computer_tabs",
  "computer_select_tab",
  "computer_navigate",
  "computer_snapshot",
  "computer_click",
  "computer_fill",
  "computer_type",
  "computer_close",
  "computer_open_url",
]);

const makeInvocation = (capabilities: ReadonlySet<"computer" | "preview" | "workers">) => ({
  environmentId: EnvironmentId.make("environment-mcp-catalog-test"),
  threadId: ThreadId.make("thread-mcp-catalog-test"),
  providerSessionId: "provider-session-mcp-catalog-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const visibleToolNames = (server: {
  readonly tools: ReadonlyArray<{
    readonly annotations: Context.Context<never>;
    readonly tool: { readonly name: string };
  }>;
}) =>
  server.tools
    .filter(({ annotations }) => {
      const enabledWhen = Context.getOption(annotations, McpSchema.EnabledWhen);
      return (
        enabledWhen._tag === "None" ||
        enabledWhen.value({
          type: "initialize",
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-catalog-test", version: "1.0.0" },
        })
      );
    })
    .map(({ tool }) => tool.name);

it.effect("omits Worker tools when startup registration is disabled", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const names = visibleToolNames(server);
    expect(names.some((name) => name.startsWith("worker_"))).toBe(false);
    expect(names).toContain("preview_status");
    expect(names.some((name) => computerToolNames.has(name))).toBe(false);
  }).pipe(Effect.provide(makeCatalogLayer(false))),
);

it.effect("advertises computer tools only to an authorized invocation", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const unauthorizedNames = yield* Effect.sync(() => visibleToolNames(server));
    const authorizedNames = yield* Effect.sync(() => visibleToolNames(server)).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        makeInvocation(new Set(["computer"])),
      ),
    );

    expect(unauthorizedNames.some((name) => computerToolNames.has(name))).toBe(false);
    expect(authorizedNames).toEqual(expect.arrayContaining([...computerToolNames]));
  }).pipe(
    Effect.provide(makeCatalogLayer(false)),
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      makeInvocation(new Set(["preview"])),
    ),
  ),
);

it.effect("advertises exactly nine Worker tools when startup registration is enabled", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const names = server.tools
      .map(({ tool }) => tool.name)
      .filter((name) => name.startsWith("worker_"));
    expect(names).toEqual(workerToolNames);
    expect(server.tools.map(({ tool }) => tool.name)).toContain("preview_status");
  }).pipe(Effect.provide(makeCatalogLayer(true))),
);
