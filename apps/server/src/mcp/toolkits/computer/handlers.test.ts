import {
  ComputerChromeAutomationError,
  ComputerControlUnavailableError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ChromeAutomation from "../../../browser/ChromeAutomation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import { computerHandlers } from "./handlers.ts";

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  capabilities,
  issuedAt: 1,
});

const launcher = (
  launchBrowser: (
    target: string,
    options?: ExternalLauncher.LaunchBrowserOptions,
  ) => Effect.Effect<void>,
) =>
  ExternalLauncher.ExternalLauncher.of({
    resolveAvailableEditors: () => Effect.succeed([]),
    resolveFileManagerRevealKind: () => Effect.succeed(undefined),
    launchBrowser,
    launchEditor: () => Effect.die("unused launchEditor"),
  });

const chromeStatus: ChromeAutomation.ChromeAutomationStatus = {
  lifecycle: "connected",
  profileDir: "A:/t3/browser/chrome-profile",
  executablePath: "chrome.exe",
  selectedTabId: "tab-1",
  error: undefined,
};

const chromeTab: ChromeAutomation.ChromeAutomationTab = {
  id: "tab-1",
  url: "https://example.test",
  title: "Example",
  selected: true,
};

const chromeSnapshot: ChromeAutomation.ChromeAutomationPageSnapshot & { readonly tabId: string } = {
  tabId: "tab-1",
  accessibilityTree: "- document",
  dom: "<body>Example</body>",
  refs: [],
};

const chromeService = (calls: Array<string>) =>
  ChromeAutomation.ChromeAutomation.of({
    start: () => Effect.sync(() => (calls.push("start"), chromeStatus)),
    stop: () => Effect.sync(() => (calls.push("stop"), { ...chromeStatus, lifecycle: "stopped" })),
    status: () => Effect.succeed(chromeStatus),
    listTabs: () => Effect.sync(() => (calls.push("tabs"), [chromeTab])),
    selectTab: (tabId) => Effect.sync(() => (calls.push(`select:${tabId}`), chromeTab)),
    navigate: (url, options) =>
      Effect.sync(() => (calls.push(`navigate:${options?.tabId}:${url}`), chromeTab)),
    snapshot: (tabId, options) =>
      Effect.sync(
        () => (calls.push(`snapshot:${tabId}:${options?.includeDom === true}`), chromeSnapshot),
      ),
    screenshot: (tabId) =>
      Effect.sync(() => {
        calls.push(`screenshot:${tabId}`);
        return { tabId, mimeType: "image/png" as const, data: "AA==", width: 1, height: 1 };
      }),
    click: (target, tabId) =>
      Effect.sync(() =>
        calls.push(`click:${tabId}:${"ref" in target ? target.ref : target.selector}`),
      ),
    fill: (target, value, tabId) =>
      Effect.sync(() =>
        calls.push(`fill:${tabId}:${"ref" in target ? target.ref : target.selector}:${value}`),
      ),
    type: (target, value, tabId) =>
      Effect.sync(() =>
        calls.push(`type:${tabId}:${"ref" in target ? target.ref : target.selector}:${value}`),
      ),
  });

it.effect(
  "opens the exact URL through the host launcher when full computer control is active",
  () =>
    Effect.gen(function* () {
      const opened: Array<{
        readonly target: string;
        readonly options: ExternalLauncher.LaunchBrowserOptions | undefined;
      }> = [];
      const url =
        "https://example.com/sso/saml?SAMLRequest=long-auth-state&RelayState=https%3A%2F%2Fexample.com%2Fdashboard";
      const result = yield* computerHandlers.computer_open_url({ url }).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["computer"])),
        ),
        Effect.provideService(
          ExternalLauncher.ExternalLauncher,
          launcher((target, options) => Effect.sync(() => opened.push({ target, options }))),
        ),
      );

      expect(opened).toEqual([{ target: url, options: { application: "chrome" } }]);
      expect(result).toEqual({ opened: true });
    }),
);

it.effect("fails closed before launching when the provider turn lacks computer authority", () =>
  Effect.gen(function* () {
    let launched = false;
    const error = yield* computerHandlers.computer_open_url({ url: "https://example.com" }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(new Set())),
      Effect.provideService(
        ExternalLauncher.ExternalLauncher,
        launcher(() => Effect.sync(() => (launched = true))),
      ),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(ComputerControlUnavailableError);
    expect(launched).toBe(false);
  }),
);

it.effect("routes managed Chrome operations through the authenticated service", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const service = chromeService(calls);
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["computer"])),
        ),
        Effect.provideService(ChromeAutomation.ChromeAutomation, service),
      );

    expect(yield* provide(computerHandlers.computer_start())).toMatchObject({
      lifecycle: "connected",
      profileDir: "A:/t3/browser/chrome-profile",
    });
    expect(yield* provide(computerHandlers.computer_status())).toMatchObject({
      selectedTabId: "tab-1",
    });
    expect(yield* provide(computerHandlers.computer_tabs())).toEqual([chromeTab]);
    expect(yield* provide(computerHandlers.computer_select_tab({ tabId: "tab-1" }))).toEqual(
      chromeTab,
    );
    expect(
      yield* provide(
        computerHandlers.computer_navigate({
          tabId: "tab-2",
          url: "https://example.test/next",
          waitUntil: "domcontentloaded",
          timeoutMs: 100,
        }),
      ),
    ).toEqual(chromeTab);
    expect(
      yield* provide(computerHandlers.computer_snapshot({ tabId: "tab-2", includeDom: true })),
    ).toEqual(chromeSnapshot);
    expect(yield* provide(computerHandlers.computer_screenshot({ tabId: "tab-2" }))).toMatchObject({
      tabId: "tab-2",
      mimeType: "image/png",
      data: "AA==",
    });
    expect(
      yield* provide(computerHandlers.computer_click({ tabId: "tab-2", target: { ref: "ref-1" } })),
    ).toEqual({
      completed: true,
    });
    expect(
      yield* provide(
        computerHandlers.computer_fill({
          tabId: "tab-2",
          target: { selector: "#email" },
          value: "a@example.test",
        }),
      ),
    ).toEqual({ completed: true });
    expect(
      yield* provide(
        computerHandlers.computer_type({
          tabId: "tab-2",
          target: { selector: "#note" },
          value: "hello",
        }),
      ),
    ).toEqual({ completed: true });
    expect(yield* provide(computerHandlers.computer_close())).toMatchObject({
      lifecycle: "stopped",
    });
    expect(calls).toEqual([
      "start",
      "tabs",
      "select:tab-1",
      "navigate:tab-2:https://example.test/next",
      "snapshot:tab-2:true",
      "screenshot:tab-2",
      "click:tab-2:ref-1",
      "fill:tab-2:#email:a@example.test",
      "type:tab-2:#note:hello",
      "stop",
    ]);
  }),
);

it.effect("maps managed Chrome failures without exposing service causes", () =>
  Effect.gen(function* () {
    const service = chromeService([]);
    const error = yield* computerHandlers.computer_tabs().pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(new Set(["computer"])),
      ),
      Effect.provideService(
        ChromeAutomation.ChromeAutomation,
        ChromeAutomation.ChromeAutomation.of({
          ...service,
          listTabs: () =>
            Effect.fail(new ChromeAutomation.ChromeAutomationError("tabs", "secret cause")),
        }),
      ),
      Effect.flip,
    );

    expect(error).toEqual(
      new ComputerChromeAutomationError({ operation: "tabs", message: "secret cause" }),
    );
  }),
);
