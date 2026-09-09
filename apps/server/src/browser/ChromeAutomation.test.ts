import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { Page } from "playwright-core";

import * as ServerConfig from "../config.ts";
import * as ChromeAutomationModule from "./ChromeAutomation.ts";
import {
  ChromeAutomationError,
  type ChromeAutomationBrowser,
  type ChromeAutomationBrowserAdapter,
  type ChromeAutomationLaunchOptions,
  type ChromeAutomationPageAdapter,
  type ChromeAutomationPageSnapshot,
  type ChromeAutomationTarget,
} from "./ChromeAutomation.ts";

interface FakePageFixture {
  readonly page: ChromeAutomationPageAdapter;
  readonly calls: Array<FakeCall>;
  readonly reload: () => void;
}

type FakeCall =
  | { readonly kind: "screenshot" }
  | {
      readonly kind: "goto";
      readonly url: string;
      readonly options: Parameters<ChromeAutomationPageAdapter["goto"]>[1];
    }
  | {
      readonly kind: "click" | "fill" | "type";
      readonly selector: string;
      readonly value?: string;
    };

const emptySnapshot: ChromeAutomationPageSnapshot = {
  accessibilityTree: "- document",
  dom: "<body></body>",
  refs: [],
};

const screenshotPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4EAAAAASUVORK5CYII=",
  "base64",
);

const interactiveSnapshot: ChromeAutomationPageSnapshot = {
  accessibilityTree: "- button Submit",
  dom: '<button id="submit">Submit</button>',
  refs: [
    {
      ref: "ref-1",
      selector: "#submit",
      tag: "button",
      role: "button",
      name: "Submit",
      x: 0,
      y: 0,
      width: 80,
      height: 30,
    },
  ],
};

const makeFakePage = (input: {
  readonly url: string;
  readonly title: string;
  readonly snapshot?: ChromeAutomationPageSnapshot;
  readonly gotoError?: unknown;
  readonly beforeGoto?: () => void;
  readonly beforeAction?: () => void | Promise<void>;
  readonly actionError?: unknown;
  readonly snapshotErrors?: ReadonlyArray<unknown | undefined>;
  readonly beforeSnapshot?: () => void;
  readonly screenshotBytes?: Uint8Array;
  readonly screenshotError?: unknown;
  readonly beforeScreenshot?: () => void;
}): FakePageFixture => {
  let url = input.url;
  let title = input.title;
  let snapshotCount = 0;
  let documentVersion = 0;
  const calls: Array<FakeCall> = [];
  const selectorFor = (target: ChromeAutomationTarget): string => {
    if ("selector" in target) return target.selector;
    const ref = (input.snapshot ?? emptySnapshot).refs.find((entry) => entry.ref === target.ref);
    if (ref === undefined) throw new Error("Unknown fixture ref");
    return ref.selector;
  };
  const page = {
    url: () => url,
    documentVersion: () => documentVersion,
    title: async () => title,
    goto: async (nextUrl: string, options: Parameters<ChromeAutomationPageAdapter["goto"]>[1]) => {
      calls.push({ kind: "goto", url: nextUrl, options });
      input.beforeGoto?.();
      if (input.gotoError !== undefined) throw input.gotoError;
      url = nextUrl;
      documentVersion += 1;
      title = `Title for ${nextUrl}`;
    },
    snapshot: async ({ includeDom } = {}) => {
      input.beforeSnapshot?.();
      const error = input.snapshotErrors?.[snapshotCount++];
      if (error !== undefined) throw error;
      const snapshot = input.snapshot ?? emptySnapshot;
      return includeDom
        ? snapshot
        : { accessibilityTree: snapshot.accessibilityTree, refs: snapshot.refs };
    },
    screenshotPng: async () => {
      calls.push({ kind: "screenshot" });
      input.beforeScreenshot?.();
      if (input.screenshotError !== undefined) throw input.screenshotError;
      return input.screenshotBytes ?? screenshotPng;
    },
    click: async (target: ChromeAutomationTarget) => {
      const selector = selectorFor(target);
      calls.push({ kind: "click", selector });
      await input.beforeAction?.();
      if (input.actionError !== undefined) throw input.actionError;
    },
    fill: async (target: ChromeAutomationTarget, value: string) => {
      const selector = selectorFor(target);
      calls.push({ kind: "fill", selector, value });
      await input.beforeAction?.();
      if (input.actionError !== undefined) throw input.actionError;
    },
    type: async (target: ChromeAutomationTarget, value: string) => {
      const selector = selectorFor(target);
      calls.push({ kind: "type", selector, value });
      await input.beforeAction?.();
      if (input.actionError !== undefined) throw input.actionError;
    },
  } satisfies ChromeAutomationPageAdapter;
  return {
    page,
    calls,
    reload: () => {
      documentVersion += 1;
    },
  };
};

const makeFakeBrowser = (input: {
  readonly pages: ReadonlyArray<FakePageFixture>;
  readonly launchError?: unknown;
  readonly launchErrors?: ReadonlyArray<unknown | undefined>;
  readonly closeErrors?: ReadonlyArray<unknown | undefined>;
}) => {
  const pages = [...input.pages];
  const createdPages: Array<FakePageFixture> = [];
  let closeCount = 0;
  let launchOptions: ChromeAutomationLaunchOptions | undefined;
  const launchOptionsHistory: Array<ChromeAutomationLaunchOptions> = [];
  let launchCount = 0;
  let onDisconnected: (() => void) | undefined;
  const browser: ChromeAutomationBrowser = {
    pages: async () => pages.map(({ page }) => page),
    newPage: async () => {
      const fixture = makeFakePage({ url: "about:blank", title: "New Tab" });
      pages.push(fixture);
      createdPages.push(fixture);
      return fixture.page;
    },
    close: async () => {
      const error = input.closeErrors?.[closeCount];
      closeCount += 1;
      if (error !== undefined) throw error;
    },
  };
  const adapter: ChromeAutomationBrowserAdapter = {
    launchPersistentContext: async (options) => {
      launchOptions = options;
      launchOptionsHistory.push(options);
      const configuredError =
        input.launchErrors === undefined ? input.launchError : input.launchErrors[launchCount];
      launchCount += 1;
      onDisconnected = options.onDisconnected;
      if (configuredError !== undefined) throw configuredError;
      return browser;
    },
  };
  return {
    adapter,
    createdPages,
    get closeCount() {
      return closeCount;
    },
    get launchOptions() {
      return launchOptions;
    },
    get launchOptionsHistory() {
      return launchOptionsHistory;
    },
    get launchCount() {
      return launchCount;
    },
    disconnect: () => onDisconnected?.(),
    removePage: (fixture: FakePageFixture) => {
      const index = pages.indexOf(fixture);
      if (index >= 0) pages.splice(index, 1);
    },
  };
};

const provideTestServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* effect.pipe(
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.succeed("test"),
      }),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-chrome-automation-test-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

it("selects Google Chrome from the Windows ProgramFiles(x86) installation root", () => {
  const programFilesX86Chrome = "D:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  const candidates = ChromeAutomationModule.chromePathCandidates("win32", {
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  });

  assert.equal(candidates[0], programFilesX86Chrome);
  assert.equal(candidates.indexOf(programFilesX86Chrome), 0);
});

it.effect("manages lifecycle and keeps the persistent profile under server state", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({
        adapter: fake.adapter,
        executablePath: "fake-chrome",
      });
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;

      assert.equal((yield* automation.status()).lifecycle, "stopped");
      const started = yield* automation.start();
      assert.equal(started.lifecycle, "connected");
      assert.equal(started.selectedTabId, "tab-1-test");
      assert.equal(fake.createdPages.length, 1);
      assert.ok(fake.launchOptions);
      const expectedProfile = path.join(config.stateDir, "browser", "chrome-profile");
      assert.equal(fake.launchOptions.userDataDir, expectedProfile);
      assert.ok(!fake.launchOptions.args.some((arg) => arg.startsWith("--user-data-dir=")));

      const stopped = yield* automation.stop();
      assert.equal(stopped.lifecycle, "stopped");
      assert.equal((yield* automation.status()).selectedTabId, undefined);
      assert.equal(fake.closeCount, 1);
    }),
  ),
);

it.effect("lists, selects, navigates, and reports tabs", () =>
  provideTestServices(
    Effect.gen(function* () {
      const first = makeFakePage({ url: "https://one.test", title: "One" });
      const second = makeFakePage({ url: "https://two.test", title: "Two" });
      const fake = makeFakeBrowser({ pages: [first, second] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      yield* automation.start();
      const tabs = yield* automation.listTabs();
      assert.deepEqual(tabs, [
        { id: "tab-1-test", url: "https://one.test", title: "One", selected: true },
        { id: "tab-2-test", url: "https://two.test", title: "Two", selected: false },
      ]);

      assert.deepEqual(yield* automation.selectTab("tab-2-test"), {
        id: "tab-2-test",
        url: "https://two.test",
        title: "Two",
        selected: true,
      });
      assert.deepEqual(
        yield* automation.navigate("https://two.test/next", {
          waitUntil: "domcontentloaded",
          timeoutMs: 321,
        }),
        {
          id: "tab-2-test",
          url: "https://two.test/next",
          title: "Title for https://two.test/next",
          selected: true,
        },
      );
      assert.deepEqual(second.calls, [
        {
          kind: "goto",
          url: "https://two.test/next",
          options: { waitUntil: "domcontentloaded", timeoutMs: 321 },
        },
      ]);

      yield* automation.navigate("https://two.test/default-wait");
      assert.deepEqual(second.calls.at(-1), {
        kind: "goto",
        url: "https://two.test/default-wait",
        options: { waitUntil: "domcontentloaded", timeoutMs: 15_000 },
      });
    }),
  ),
);

it.effect("stores snapshot refs and supports click, fill, and type", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshot: {
          accessibilityTree: "- form",
          dom: '<button id="submit">Submit</button>',
          refs: [
            {
              ref: "ref-submit",
              selector: "#submit",
              tag: "button",
              role: "button",
              name: "Submit",
              x: 10,
              y: 20,
              width: 80,
              height: 30,
            },
          ],
        },
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();

      const compactSnapshot = yield* automation.snapshot();
      assert.equal(compactSnapshot.dom, undefined);
      const snapshot = yield* automation.snapshot("tab-1-test", { includeDom: true });
      assert.equal(snapshot.dom, '<button id="submit">Submit</button>');
      assert.equal(snapshot.tabId, "tab-1-test");
      assert.equal(snapshot.refs[0]?.selector, "#submit");
      const ref = snapshot.refs[0]!.ref;
      yield* automation.click({ ref });

      const staleRefError = yield* automation.click({ ref }).pipe(Effect.flip);
      assert.instanceOf(staleRefError, ChromeAutomationError);
      assert.equal(staleRefError.operation, "target");

      yield* automation.fill({ selector: "input[name=email]" }, "a@example.com");
      yield* automation.type({ selector: "textarea[name=note]" }, "hello");
      assert.deepEqual(page.calls, [
        { kind: "click", selector: "#submit" },
        { kind: "fill", selector: "input[name=email]", value: "a@example.com" },
        { kind: "type", selector: "textarea[name=note]", value: "hello" },
      ]);
    }),
  ),
);

it.effect("reports launch, navigation, and disconnection failures", () =>
  provideTestServices(
    Effect.gen(function* () {
      const launchFailure = makeFakeBrowser({ pages: [], launchError: new Error("launch failed") });
      const failedAutomation = yield* ChromeAutomationModule.make({
        adapter: launchFailure.adapter,
      });
      const launchError = yield* failedAutomation.start().pipe(Effect.flip);
      assert.instanceOf(launchError, ChromeAutomationError);
      assert.equal(launchError.operation, "start");
      assert.equal(launchError.detail, "T3 managed Chrome is unavailable.");
      assert.equal(launchError.unavailable, true);
      assert.equal((yield* failedAutomation.status()).lifecycle, "failed");

      const page = makeFakePage({
        url: "https://error.test",
        title: "Error",
        gotoError: new Error("navigation failed"),
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();
      const navigationError = yield* automation
        .navigate("https://error.test/next")
        .pipe(Effect.flip);
      assert.equal(navigationError.operation, "navigate");

      fake.disconnect();
      assert.equal((yield* automation.status()).lifecycle, "failed");
      assert.deepEqual(yield* automation.listTabs(), [
        { id: "tab-2-test", url: "https://error.test", title: "Error", selected: true },
      ]);
      assert.equal((yield* automation.status()).lifecycle, "connected");
    }),
  ),
);

it.effect("coalesces concurrent starts into one persistent browser launch", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const starts = yield* Effect.all([automation.start(), automation.start()], {
        concurrency: "unbounded",
      });

      assert.equal(fake.launchCount, 1);
      assert.equal(starts[0]?.lifecycle, "connected");
      assert.equal(starts[1]?.lifecycle, "connected");
    }),
  ),
);

it.effect("does not replay navigation after a disconnect with an uncertain result", () =>
  provideTestServices(
    Effect.gen(function* () {
      let fake!: ReturnType<typeof makeFakeBrowser>;
      let disconnected = false;
      const page = makeFakePage({
        url: "https://disconnect.test",
        title: "Disconnect",
        beforeGoto: () => {
          if (!disconnected) {
            disconnected = true;
            fake.disconnect();
          }
        },
      });
      fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const error = yield* automation.navigate("https://disconnect.test/next").pipe(Effect.flip);

      assert.include(error.detail, "outcome is unknown");
      assert.equal(page.calls.length, 1);
      assert.equal(fake.launchCount, 1);
      assert.equal((yield* automation.status()).lifecycle, "failed");
    }),
  ),
);

it.effect("retries a read-only snapshot transport failure exactly once", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://retry.test",
        title: "Retry",
        snapshotErrors: [new Error("Target page, context or browser has been closed"), undefined],
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const snapshot = yield* automation.snapshot();

      assert.equal(snapshot.tabId, "tab-2-test");
      assert.equal(fake.launchCount, 2);
    }),
  ),
);

it.effect("returns one unavailable error when recovery cannot relaunch Chrome", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://failed-recovery.test",
        title: "Failed recovery",
        snapshotErrors: [new Error("Target page, context or browser has been closed")],
      });
      const fake = makeFakeBrowser({
        pages: [page],
        launchErrors: [
          undefined,
          new Error("relaunch failed"),
          new Error("must not relaunch again"),
        ],
      });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      const error = yield* automation.snapshot().pipe(Effect.flip);

      assert.equal(error.operation, "snapshot");
      assert.equal(error.detail, "T3 managed Chrome is unavailable.");
      assert.equal(error.unavailable, true);
      assert.equal(fake.launchCount, 2);
    }),
  ),
);

it.effect("does not reopen Chrome as part of explicit close", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });

      yield* automation.start();
      assert.equal((yield* automation.stop()).lifecycle, "stopped");
      assert.equal(fake.launchCount, 1);

      const tabs = yield* automation.listTabs();
      assert.equal(fake.launchCount, 2);
      assert.equal(tabs[0]?.selected, true);
    }),
  ),
);

it.effect("reuses the same persistent profile across automation instances", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const first = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* first.start();
      yield* first.stop();

      const second = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* second.start();

      assert.equal(fake.launchOptionsHistory.length, 2);
      assert.equal(
        fake.launchOptionsHistory[0]?.userDataDir,
        fake.launchOptionsHistory[1]?.userDataDir,
      );
      assert.equal(
        fake.launchOptionsHistory[0]?.args.find((arg) => arg.startsWith("--user-data-dir=")),
        fake.launchOptionsHistory[1]?.args.find((arg) => arg.startsWith("--user-data-dir=")),
      );
    }),
  ),
);

it.effect("keeps explicit action targets independent of global tab selection", () =>
  provideTestServices(
    Effect.gen(function* () {
      const first = makeFakePage({
        url: "https://one.test",
        title: "One",
        snapshot: interactiveSnapshot,
      });
      const second = makeFakePage({
        url: "https://two.test",
        title: "Two",
        snapshot: interactiveSnapshot,
      });
      const fake = makeFakeBrowser({ pages: [first, second] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      const firstSnapshot = yield* automation.snapshot("tab-1-test");
      yield* automation.selectTab("tab-2-test");
      yield* automation.click({ ref: firstSnapshot.refs[0]!.ref }, "tab-1-test");
      yield* automation.fill({ selector: "input" }, "first", "tab-1-test");
      yield* automation.type({ selector: "textarea" }, "message", "tab-1-test");
      yield* automation.navigate("https://one.test/next", { tabId: "tab-1-test" });
      assert.deepEqual(
        first.calls.map((call) => call.kind),
        ["click", "fill", "type", "goto"],
      );
      assert.equal(second.calls.length, 0);
      assert.equal((yield* automation.status()).selectedTabId, "tab-2-test");
    }),
  ),
);

it.effect("rejects stale refs after a newer snapshot or another tab's snapshot", () =>
  provideTestServices(
    Effect.gen(function* () {
      const first = makeFakePage({
        url: "https://one.test",
        title: "One",
        snapshot: interactiveSnapshot,
      });
      const second = makeFakePage({
        url: "https://two.test",
        title: "Two",
        snapshot: interactiveSnapshot,
      });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [first, second] }).adapter,
      });
      const firstSnapshot = yield* automation.snapshot("tab-1-test");
      const newSnapshot = yield* automation.snapshot("tab-1-test");
      const otherSnapshot = yield* automation.snapshot("tab-2-test");
      const stale = firstSnapshot.refs[0]!.ref;
      assert.notEqual(stale, newSnapshot.refs[0]!.ref);
      assert.notEqual(newSnapshot.refs[0]!.ref, otherSnapshot.refs[0]!.ref);
      assert.equal(
        (yield* automation.click({ ref: stale }, "tab-1-test").pipe(Effect.flip)).operation,
        "target",
      );
      assert.equal(
        (yield* automation.click({ ref: newSnapshot.refs[0]!.ref }, "tab-2-test").pipe(Effect.flip))
          .operation,
        "target",
      );
      assert.equal(first.calls.length + second.calls.length, 0);
    }),
  ),
);

it.effect("invalidates refs on same-URL page reloads", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshot: interactiveSnapshot,
      });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [page] }).adapter,
      });
      const snapshot = yield* automation.snapshot("tab-1-test");
      page.reload();
      const error = yield* automation
        .click({ ref: snapshot.refs[0]!.ref }, "tab-1-test")
        .pipe(Effect.flip);
      assert.equal(error.operation, "target");
      assert.equal(page.calls.length, 0);
    }),
  ),
);

it.effect("does not redirect actions to a surviving tab when the selected tab closes", () =>
  provideTestServices(
    Effect.gen(function* () {
      const first = makeFakePage({ url: "https://one.test", title: "One" });
      const second = makeFakePage({ url: "https://two.test", title: "Two" });
      const fake = makeFakeBrowser({ pages: [first, second] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();
      fake.removePage(first);
      const tabs = yield* automation.listTabs();
      assert.equal(tabs.length, 1);
      assert.equal(tabs[0]?.selected, false);
      assert.equal(
        (yield* automation.click({ selector: "button" }).pipe(Effect.flip)).operation,
        "tab",
      );
      assert.equal(
        (yield* automation.click({ selector: "button" }, "tab-1-test").pipe(Effect.flip)).operation,
        "tab",
      );
      assert.equal(second.calls.length, 0);
      assert.equal(fake.launchCount, 1);
      assert.equal((yield* automation.screenshot("tab-1-test").pipe(Effect.flip)).operation, "tab");
      assert.equal(second.calls.length, 0);
    }),
  ),
);

it.effect.each(["click", "fill", "type"] as const)(
  "does not replay %s after losing its acknowledgement",
  (operation) =>
    provideTestServices(
      Effect.gen(function* () {
        const page = makeFakePage({
          url: "https://form.test",
          title: "Form",
          actionError: new Error("Connection closed"),
        });
        const fake = makeFakeBrowser({ pages: [page] });
        const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
        yield* automation.start();
        const request =
          operation === "click"
            ? automation.click({ selector: "button" }, "tab-1-test")
            : automation[operation]({ selector: "input" }, "hello", "tab-1-test");
        const error = yield* request.pipe(Effect.flip);
        assert.include(error.detail, "outcome is unknown");
        assert.equal(page.calls.length, 1);
        assert.equal(fake.launchCount, 1);
        const nextError = yield* automation
          .click({ selector: "button" }, "tab-1-test")
          .pipe(Effect.flip);
        assert.include(nextError.detail, "List tabs");
        assert.equal(page.calls.length, 1);
        yield* automation.listTabs();
        assert.equal(fake.closeCount, 1);
        assert.equal(fake.launchCount, 2);
        const staleTabError = yield* automation
          .click({ selector: "button" }, "tab-1-test")
          .pipe(Effect.flip);
        assert.equal(staleTabError.operation, "tab");
        assert.equal(page.calls.length, 1);
      }),
    ),
);

it.effect("ignores late disconnect notifications from replaced contexts", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();
      const oldConnection = fake.launchOptions!;
      fake.disconnect();
      yield* automation.listTabs();
      oldConnection.onDisconnected();
      assert.equal((yield* automation.status()).lifecycle, "connected");
      assert.equal(fake.launchCount, 2);
    }),
  ),
);

it.effect("cleans up a browser whose launch completes after cancellation", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({ pages: [] });
      const launching = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const automation = yield* ChromeAutomationModule.make({
            adapter: {
              launchPersistentContext: async (options) => {
                const browser = await fake.adapter.launchPersistentContext(options);
                launching.resolve();
                await release.promise;
                return browser;
              },
            },
          });
          const starting = yield* Effect.forkChild(automation.start());
          yield* Effect.promise(() => launching.promise);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(starting), {
            startImmediately: true,
          });
          release.resolve();
          yield* Fiber.join(interrupting);
        }),
      );
      assert.equal(fake.closeCount, 1);
    }),
  ),
);

it.effect("holds the action lock until cancelled browser input has settled", () =>
  provideTestServices(
    Effect.gen(function* () {
      const acting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        beforeAction: async () => {
          if (!first) return;
          first = false;
          acting.resolve();
          await release.promise;
        },
      });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [page] }).adapter,
      });
      const clicking = yield* Effect.forkChild(automation.click({ selector: "button" }));
      yield* Effect.promise(() => acting.promise);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(clicking), {
        startImmediately: true,
      });
      const filling = yield* Effect.forkChild(automation.fill({ selector: "input" }, "hello"), {
        startImmediately: true,
      });
      assert.equal(page.calls.length, 1);
      release.resolve();
      yield* Fiber.join(interrupting);
      yield* Fiber.join(filling);
      assert.deepEqual(
        page.calls.map((call) => call.kind),
        ["click", "fill"],
      );
    }),
  ),
);

it.effect.each([0, -1, Infinity, NaN, 120_001])(
  "rejects unbounded navigation timeout %s",
  (timeoutMs) =>
    provideTestServices(
      Effect.gen(function* () {
        const page = makeFakePage({ url: "https://form.test", title: "Form" });
        const automation = yield* ChromeAutomationModule.make({
          adapter: makeFakeBrowser({ pages: [page] }).adapter,
        });
        const error = yield* automation
          .navigate("https://form.test/next", { timeoutMs })
          .pipe(Effect.flip);
        assert.include(error.detail, "timeoutMs must be between");
        assert.equal(page.calls.length, 0);
      }),
    ),
);

it.effect("retains the browser handle when close fails so cleanup can be retried", () =>
  provideTestServices(
    Effect.gen(function* () {
      const fake = makeFakeBrowser({
        pages: [],
        closeErrors: [new Error("close failed"), undefined],
      });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      yield* automation.start();
      yield* automation.stop().pipe(Effect.flip);
      assert.equal((yield* automation.status()).lifecycle, "failed");
      yield* automation.stop();
      assert.equal(fake.closeCount, 2);
      assert.equal((yield* automation.status()).lifecycle, "stopped");
    }),
  ),
);

it.effect("reports failed status when a read-only retry also loses its transport", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshotErrors: [new Error("Connection closed"), new Error("Connection closed")],
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      const error = yield* automation.snapshot().pipe(Effect.flip);
      assert.equal(error.unavailable, true);
      assert.equal(fake.launchCount, 2);
      assert.equal((yield* automation.status()).lifecycle, "failed");
    }),
  ),
);

it.effect("rejects a snapshot that spans a main-document navigation", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshot: interactiveSnapshot,
        beforeSnapshot: () => page.reload(),
      });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [page] }).adapter,
      });
      const error = yield* automation.snapshot().pipe(Effect.flip);
      assert.include(error.detail, "navigated during the snapshot");
      assert.equal(page.calls.length, 0);
    }),
  ),
);

it.effect("discards previous refs when snapshot collection fails", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshot: interactiveSnapshot,
        snapshotErrors: [undefined, new Error("snapshot failed")],
      });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [page] }).adapter,
      });
      const oldSnapshot = yield* automation.snapshot();
      yield* automation.snapshot().pipe(Effect.flip);
      const error = yield* automation.click({ ref: oldSnapshot.refs[0]!.ref }).pipe(Effect.flip);
      assert.equal(error.operation, "target");
      assert.equal(page.calls.length, 0);
    }),
  ),
);

it.effect("does not reuse tab identities across server service lifetimes", () =>
  provideTestServices(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      let instance = 0;
      const cryptoWithFreshIds = {
        ...crypto,
        randomUUIDv4: Effect.sync(() => `instance-${++instance}`),
      };
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        snapshot: interactiveSnapshot,
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const first = yield* ChromeAutomationModule.make({ adapter: fake.adapter }).pipe(
        Effect.provideService(Crypto.Crypto, cryptoWithFreshIds),
      );
      const firstSnapshot = yield* first.snapshot();
      yield* first.stop();
      const second = yield* ChromeAutomationModule.make({ adapter: fake.adapter }).pipe(
        Effect.provideService(Crypto.Crypto, cryptoWithFreshIds),
      );
      const secondSnapshot = yield* second.snapshot();
      assert.notEqual(firstSnapshot.tabId, secondSnapshot.tabId);
      assert.notEqual(firstSnapshot.refs[0]?.ref, secondSnapshot.refs[0]?.ref);
      const error = yield* second
        .click({ selector: "button" }, firstSnapshot.tabId)
        .pipe(Effect.flip);
      assert.equal(error.operation, "tab");
      assert.equal(page.calls.length, 0);
    }),
  ),
);

it.effect("returns a PNG for the explicit screenshot tab without changing global selection", () =>
  provideTestServices(
    Effect.gen(function* () {
      const first = makeFakePage({
        url: "https://one.test",
        title: "One",
        snapshot: interactiveSnapshot,
      });
      const second = makeFakePage({ url: "https://two.test", title: "Two" });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [first, second] }).adapter,
      });
      yield* automation.start();
      yield* automation.selectTab("tab-2-test");
      const snapshot = yield* automation.snapshot("tab-1-test");
      assert.deepEqual(yield* automation.screenshot("tab-1-test"), {
        tabId: "tab-1-test",
        mimeType: "image/png",
        data: screenshotPng.toString("base64"),
        width: 1,
        height: 1,
      });
      yield* automation.click({ ref: snapshot.refs[0]!.ref }, "tab-1-test");
      assert.deepEqual(first.calls, [
        { kind: "screenshot" },
        { kind: "click", selector: "#submit" },
      ]);
      assert.equal(second.calls.length, 0);
      assert.equal((yield* automation.status()).selectedTabId, "tab-2-test");
    }),
  ),
);

it.effect("rejects screenshot capture spanning navigation", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        beforeScreenshot: () => page.reload(),
      });
      const automation = yield* ChromeAutomationModule.make({
        adapter: makeFakeBrowser({ pages: [page] }).adapter,
      });
      const error = yield* automation.screenshot("tab-1-test").pipe(Effect.flip);
      assert.include(error.detail, "navigated during capture");
    }),
  ),
);

it.effect("does not redirect screenshots after transport recovery replaces tab identities", () =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        screenshotError: new Error("Connection closed"),
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      const error = yield* automation.screenshot("tab-1-test").pipe(Effect.flip);
      assert.equal(error.operation, "tab");
      assert.equal(fake.launchCount, 2);
      assert.deepEqual(page.calls, [{ kind: "screenshot" }]);
    }),
  ),
);

it.effect.each([
  { label: "oversized PNG", bytes: new Uint8Array(5 * 1024 * 1024 + 1), message: "5 MiB limit" },
  { label: "invalid PNG", bytes: new Uint8Array([1, 2, 3]), message: "valid PNG" },
  {
    label: "oversized dimensions",
    bytes: (() => {
      const bytes = Buffer.from(screenshotPng);
      bytes.writeUInt32BE(4097, 16);
      return bytes;
    })(),
    message: "dimensions must be between",
  },
  {
    label: "zero dimensions",
    bytes: (() => {
      const bytes = Buffer.from(screenshotPng);
      bytes.writeUInt32BE(0, 20);
      return bytes;
    })(),
    message: "dimensions must be between",
  },
])("rejects $label screenshot output", ({ bytes, message }) =>
  provideTestServices(
    Effect.gen(function* () {
      const page = makeFakePage({
        url: "https://form.test",
        title: "Form",
        screenshotBytes: bytes,
      });
      const fake = makeFakeBrowser({ pages: [page] });
      const automation = yield* ChromeAutomationModule.make({ adapter: fake.adapter });
      const error = yield* automation.screenshot("tab-1-test").pipe(Effect.flip);
      assert.include(error.detail, message);
      assert.equal(fake.launchCount, 1);
    }),
  ),
);

it.each([
  null,
  { width: 4097, height: 720 },
  { width: 1280, height: 4097 },
  { width: 0, height: 720 },
])("rejects an unbounded or oversized viewport before capture: %j", async (viewport) => {
  let captureCount = 0;
  const page = {
    on: () => undefined,
    viewportSize: () => viewport,
    screenshot: async () => {
      captureCount += 1;
      return screenshotPng;
    },
  } as unknown as Page;
  await NodeAssert.rejects(
    ChromeAutomationModule.makePlaywrightPageAdapter(page).screenshotPng(),
    /viewport dimensions/,
  );
  assert.equal(captureCount, 0);
});

it("captures only the CSS-scaled viewport with a bounded timeout", async () => {
  const options: Array<Parameters<Page["screenshot"]>[0]> = [];
  const page = {
    on: () => undefined,
    viewportSize: () => ({ width: 1280, height: 720 }),
    screenshot: async (input: Parameters<Page["screenshot"]>[0]) => {
      options.push(input);
      return screenshotPng;
    },
  } as unknown as Page;
  assert.deepEqual(
    await ChromeAutomationModule.makePlaywrightPageAdapter(page).screenshotPng(),
    screenshotPng,
  );
  assert.deepEqual(options, [{ type: "png", fullPage: false, scale: "css", timeout: 15_000 }]);
});
import * as NodeAssert from "node:assert/strict";
