import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { chromium, type ElementHandle, type Locator, type Page } from "playwright-core";

import * as ServerConfig from "../config.ts";
import { collectSnapshotRefs } from "./ChromeSnapshot.ts";

const PROFILE_DIRECTORY = "browser/chrome-profile";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 4096;
const MAX_ACCESSIBILITY_SNAPSHOT_CHARS = 24_000;
const MAX_DOM_SNAPSHOT_CHARS = 100_000;
const MAX_SNAPSHOT_REFS = 300;
const UNAVAILABLE_MESSAGE = "T3 managed Chrome is unavailable.";
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role], [contenteditable="true"]';

export type ChromeAutomationLifecycle =
  | "stopped"
  | "starting"
  | "connected"
  | "stopping"
  | "failed";

export interface ChromeAutomationStatus {
  readonly lifecycle: ChromeAutomationLifecycle;
  readonly profileDir: string;
  readonly executablePath: string | undefined;
  readonly selectedTabId: string | undefined;
  readonly error: string | undefined;
}

export interface ChromeAutomationTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly selected: boolean;
}

export interface ChromeAutomationRef {
  readonly ref: string;
  readonly selector: string;
  readonly tag: string;
  readonly role: string | null;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChromeAutomationPageSnapshot {
  readonly accessibilityTree: string;
  readonly dom?: string;
  readonly refs: ReadonlyArray<ChromeAutomationRef>;
}

export interface ChromeAutomationScreenshot {
  readonly tabId: string;
  readonly mimeType: "image/png";
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export type ChromeAutomationTarget = { readonly ref: string } | { readonly selector: string };

export interface ChromeAutomationLaunchOptions {
  readonly executablePath: string | undefined;
  readonly channel: "chrome" | undefined;
  readonly userDataDir: string;
  readonly headless: false;
  readonly args: ReadonlyArray<string>;
  readonly onDisconnected: () => void;
}

export interface ChromeAutomationPageAdapter {
  readonly url: () => string;
  readonly documentVersion: () => number;
  readonly title: () => Promise<string>;
  readonly goto: (
    url: string,
    options: {
      readonly waitUntil: "load" | "domcontentloaded" | "commit";
      readonly timeoutMs: number;
    },
  ) => Promise<void>;
  readonly snapshot: (options?: {
    readonly includeDom?: boolean;
  }) => Promise<ChromeAutomationPageSnapshot>;
  readonly screenshotPng: () => Promise<Uint8Array>;
  readonly click: (target: ChromeAutomationTarget) => Promise<void>;
  readonly fill: (target: ChromeAutomationTarget, value: string) => Promise<void>;
  readonly type: (target: ChromeAutomationTarget, value: string) => Promise<void>;
}

export interface ChromeAutomationBrowserAdapter {
  readonly launchPersistentContext: (
    options: ChromeAutomationLaunchOptions,
  ) => Promise<ChromeAutomationBrowser>;
}

export interface ChromeAutomationBrowser {
  readonly pages: () => Promise<ReadonlyArray<ChromeAutomationPageAdapter>>;
  readonly newPage: () => Promise<ChromeAutomationPageAdapter>;
  readonly close: () => Promise<void>;
}

export class ChromeAutomationError extends Error {
  readonly _tag = "ChromeAutomationError" as const;
  readonly operation: string;
  readonly detail: string;
  readonly unavailable: boolean;
  override readonly cause: unknown | undefined;

  constructor(operation: string, detail: string, cause?: unknown, unavailable = false) {
    super(`${operation}: ${detail}`);
    this.name = "ChromeAutomationError";
    this.operation = operation;
    this.detail = detail;
    this.unavailable = unavailable;
    this.cause = cause;
  }
}

export class ChromeAutomation extends Context.Service<
  ChromeAutomation,
  {
    readonly start: () => Effect.Effect<ChromeAutomationStatus, ChromeAutomationError>;
    readonly stop: () => Effect.Effect<ChromeAutomationStatus, ChromeAutomationError>;
    readonly status: () => Effect.Effect<ChromeAutomationStatus>;
    readonly listTabs: () => Effect.Effect<
      ReadonlyArray<ChromeAutomationTab>,
      ChromeAutomationError
    >;
    readonly selectTab: (
      tabId: string,
    ) => Effect.Effect<ChromeAutomationTab, ChromeAutomationError>;
    readonly navigate: (
      url: string,
      options?: {
        readonly tabId?: string;
        readonly waitUntil?: "load" | "domcontentloaded" | "commit";
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<ChromeAutomationTab, ChromeAutomationError>;
    readonly snapshot: (
      tabId?: string,
      options?: { readonly includeDom?: boolean },
    ) => Effect.Effect<
      ChromeAutomationPageSnapshot & { readonly tabId: string },
      ChromeAutomationError
    >;
    readonly screenshot: (
      tabId: string,
    ) => Effect.Effect<ChromeAutomationScreenshot, ChromeAutomationError>;
    readonly click: (
      target: ChromeAutomationTarget,
      tabId?: string,
    ) => Effect.Effect<void, ChromeAutomationError>;
    readonly fill: (
      target: ChromeAutomationTarget,
      value: string,
      tabId?: string,
    ) => Effect.Effect<void, ChromeAutomationError>;
    readonly type: (
      target: ChromeAutomationTarget,
      value: string,
      tabId?: string,
    ) => Effect.Effect<void, ChromeAutomationError>;
  }
>()("t3/browser/ChromeAutomation") {}

export interface ChromeAutomationOptions {
  /** Injected in tests or by a future alternate browser host. */
  readonly adapter?: ChromeAutomationBrowserAdapter;
  /** Overrides executable discovery, primarily for managed installations/tests. */
  readonly executablePath?: string;
}

export interface ChromeAutomationLaunchTarget {
  readonly executablePath: string | undefined;
  /** Playwright resolves this channel to an installed Google Chrome executable. */
  readonly channel: "chrome" | undefined;
}

interface ManagedTab {
  readonly id: string;
  readonly page: ChromeAutomationPageAdapter;
  refs: ReadonlyMap<string, string>;
  snapshotDocumentVersion: number | undefined;
}

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const failure = (operation: string, cause: unknown): ChromeAutomationError =>
  new ChromeAutomationError(operation, errorDetail(cause), cause);

const unavailableFailure = (operation: string, cause: unknown): ChromeAutomationError =>
  new ChromeAutomationError(operation, UNAVAILABLE_MESSAGE, cause, true);

const isRecoverableTransportFailure = (cause: ChromeAutomationError): boolean => {
  const detail = errorDetail(cause.cause ?? cause.detail).toLowerCase();
  return [
    "target page, context or browser has been closed",
    "target page, context or browser has been disconnected",
    "browser has been closed",
    "context has been closed",
    "page has been closed",
    "target closed",
    "session closed",
    "connection closed",
    "connection reset",
    "econnreset",
    "epipe",
    "transport closed",
    "browser disconnected",
  ].some((marker) => detail.includes(marker));
};

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n[truncated by T3 Chrome automation]`;

const isSupportedScreenshotSize = (width: number, height: number): boolean =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_SCREENSHOT_DIMENSION &&
  height <= MAX_SCREENSHOT_DIMENSION;

const resolvePageTarget = (
  target: ChromeAutomationTarget,
  refs: ReadonlyMap<string, string>,
): ChromeAutomationTarget => {
  if ("selector" in target) {
    if (target.selector.trim().length === 0) {
      throw new ChromeAutomationError("target", "A selector cannot be empty.");
    }
    return target;
  }
  const pageRef = refs.get(target.ref);
  if (pageRef === undefined) {
    throw new ChromeAutomationError(
      "target",
      `Snapshot ref ${JSON.stringify(target.ref)} is not available. Take a fresh snapshot.`,
    );
  }
  return { ref: pageRef };
};

export const profileArguments = (): ReadonlyArray<string> => [
  "--no-first-run",
  "--no-default-browser-check",
];

const trimPathCandidate = (candidate: string): string => {
  const trimmed = candidate.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const appendUniquePathCandidate = (
  candidates: Array<string>,
  seen: Set<string>,
  platform: NodeJS.Platform,
  candidate: string | undefined,
): void => {
  if (candidate === undefined) return;
  const trimmed = trimPathCandidate(candidate);
  if (trimmed.length === 0) return;
  const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(trimmed);
};

const joinWindowsPath = (root: string, relativePath: string): string =>
  `${trimPathCandidate(root).replace(/[\\/]+$/, "")}\\${relativePath}`;

export const chromePathCandidates = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  const candidates: Array<string> = [];
  const seen = new Set<string>();
  appendUniquePathCandidate(candidates, seen, platform, env.CHROME_PATH);
  appendUniquePathCandidate(candidates, seen, platform, env.CHROMIUM_PATH);

  if (platform === "win32") {
    const systemDrive =
      trimPathCandidate(env.SystemDrive ?? "") ||
      trimPathCandidate(env.SystemRoot ?? "").slice(0, 2) ||
      "C:";
    const roots = [
      // Windows names this variable `ProgramFiles(x86)`. Keep the old
      // spelling as a compatibility fallback for embedders that normalize
      // environment keys before constructing the server environment.
      env["ProgramFiles(x86)"],
      env.ProgramFilesX86,
      env.ProgramFiles,
      env.ProgramW6432,
      `${systemDrive}\\Program Files (x86)`,
      `${systemDrive}\\Program Files`,
      env.LOCALAPPDATA,
      env.USERPROFILE === undefined ? undefined : `${env.USERPROFILE}\\AppData\\Local`,
    ];
    const relativePaths = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Google\\Chrome Beta\\Application\\chrome.exe",
      "Google\\Chrome Dev\\Application\\chrome.exe",
      "Google\\Chrome SxS\\Application\\chrome.exe",
      "Google\\Chrome for Testing\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
    ];
    for (const root of roots) {
      if (root === undefined || trimPathCandidate(root).length === 0) continue;
      for (const relativePath of relativePaths) {
        appendUniquePathCandidate(candidates, seen, platform, joinWindowsPath(root, relativePath));
      }
    }
    // A portable or administrator-managed installation may be exposed only
    // through PATH. These are checked after explicit standard locations.
    for (const command of ["chrome.exe", "chrome", "chromium.exe", "chromium"]) {
      appendUniquePathCandidate(candidates, seen, platform, command);
    }
    return candidates;
  }

  if (platform === "darwin") {
    for (const candidate of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      env.HOME === undefined
        ? undefined
        : `${env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      env.HOME === undefined
        ? undefined
        : `${env.HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    ]) {
      appendUniquePathCandidate(candidates, seen, platform, candidate);
    }
    return candidates;
  }

  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    appendUniquePathCandidate(candidates, seen, platform, command);
  }
  return candidates;
};

/** Read-only executable discovery; absence does not imply that a Playwright channel is installed. */
export const findInstalledChrome = Effect.fn("ChromeAutomation.findInstalledChrome")(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  for (const candidate of chromePathCandidates(platform, env)) {
    const resolved = yield* resolveCommandPath(candidate, { env }).pipe(Effect.option);
    if (resolved._tag === "Some") return resolved.value;
  }
  return undefined;
});

export const resolveInstalledChrome = Effect.fn("ChromeAutomation.resolveInstalledChrome")(
  function* () {
    const executablePath = yield* findInstalledChrome();
    if (executablePath !== undefined) {
      return { executablePath, channel: undefined } satisfies ChromeAutomationLaunchTarget;
    }
    yield* Effect.logInfo(
      "managed Chrome path discovery found no explicit executable; trying Playwright channel",
    );
    return {
      executablePath: undefined,
      channel: "chrome",
    } satisfies ChromeAutomationLaunchTarget;
  },
);

export const makePlaywrightPageAdapter = (page: Page): ChromeAutomationPageAdapter => {
  let documentVersion = 0;
  let snapshotHandles = new Map<string, ElementHandle>();
  const releaseHandles = async (handles: Iterable<ElementHandle>) => {
    await Promise.all(Array.from(handles, (handle) => handle.dispose().catch(() => undefined)));
  };
  const clearSnapshotHandles = async () => {
    const previous = snapshotHandles;
    snapshotHandles = new Map();
    await releaseHandles(previous.values());
  };
  const withTarget = async (
    target: ChromeAutomationTarget,
    use: (element: Locator | ElementHandle) => Promise<void>,
  ) => {
    try {
      if ("selector" in target) {
        await use(page.locator(target.selector));
        return;
      }
      const handle = snapshotHandles.get(target.ref);
      if (handle === undefined) {
        throw new ChromeAutomationError(
          "target",
          "Snapshot ref is no longer available. Take a fresh snapshot.",
        );
      }
      if (!(await handle.evaluate((element) => element.isConnected))) {
        throw new ChromeAutomationError(
          "target",
          "Snapshot element is detached. Take a fresh snapshot.",
        );
      }
      await use(handle);
    } finally {
      await clearSnapshotHandles();
    }
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      documentVersion += 1;
      void clearSnapshotHandles();
    }
  });
  page.on("close", () => {
    void clearSnapshotHandles();
  });
  return {
    url: () => page.url(),
    documentVersion: () => documentVersion,
    title: () => page.title(),
    goto: async (url, options) => {
      await clearSnapshotHandles();
      await page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
    },
    snapshot: async (options = {}) => {
      await clearSnapshotHandles();
      const capturedDocumentVersion = documentVersion;
      const handles = await page.locator(INTERACTIVE_SELECTOR).elementHandles();
      try {
        const [accessibilityTree, dom, allRefs]: [
          string,
          string | undefined,
          ReadonlyArray<ChromeAutomationRef>,
        ] = await Promise.all([
          page.locator("body").ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS }),
          options.includeDom === true
            ? page.locator("body").evaluate((element) => element.outerHTML, undefined, {
                timeout: DEFAULT_TIMEOUT_MS,
              })
            : Promise.resolve(undefined),
          page.evaluate(collectSnapshotRefs, handles),
        ] as const);
        const refs = allRefs
          .filter((ref) => ref.width > 0 && ref.height > 0)
          .slice(0, MAX_SNAPSHOT_REFS);
        const retainedRefs = new Set(refs.map((ref) => ref.ref));
        const retainedHandles = new Map<string, ElementHandle>();
        const discardedHandles: ElementHandle[] = [];
        for (const [index, ref] of allRefs.entries()) {
          if (retainedRefs.has(ref.ref)) retainedHandles.set(ref.ref, handles[index]!);
          else discardedHandles.push(handles[index]!);
        }
        await releaseHandles(discardedHandles);
        if (documentVersion !== capturedDocumentVersion) {
          throw new ChromeAutomationError(
            "snapshot",
            "The page navigated during the snapshot. Take a fresh snapshot.",
          );
        }
        snapshotHandles = retainedHandles;
        return { accessibilityTree, ...(dom === undefined ? {} : { dom }), refs };
      } catch (cause) {
        await releaseHandles(handles);
        throw cause;
      }
    },
    screenshotPng: async () => {
      const viewport = page.viewportSize();
      if (viewport === null || !isSupportedScreenshotSize(viewport.width, viewport.height)) {
        throw new ChromeAutomationError(
          "screenshot",
          `Chrome viewport dimensions must be between 1 and ${MAX_SCREENSHOT_DIMENSION} pixels.`,
        );
      }
      return page.screenshot({
        type: "png",
        fullPage: false,
        scale: "css",
        timeout: DEFAULT_TIMEOUT_MS,
      });
    },
    click: (target) =>
      withTarget(target, (element) => element.click({ timeout: DEFAULT_TIMEOUT_MS })),
    fill: (target, value) =>
      withTarget(target, (element) => element.fill(value, { timeout: DEFAULT_TIMEOUT_MS })),
    type: (target, value) =>
      withTarget(target, (element) =>
        "pressSequentially" in element
          ? element.pressSequentially(value, { timeout: DEFAULT_TIMEOUT_MS })
          : element.type(value, { timeout: DEFAULT_TIMEOUT_MS }),
      ),
  };
};

const makePlaywrightAdapter = (): ChromeAutomationBrowserAdapter => ({
  launchPersistentContext: async (options) => {
    const context = await chromium.launchPersistentContext(options.userDataDir, {
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      headless: options.headless,
      timeout: DEFAULT_TIMEOUT_MS,
      args: [...options.args],
    });
    context.on("close", options.onDisconnected);
    const pages = new WeakMap<Page, ChromeAutomationPageAdapter>();
    const adaptPage = (page: Page): ChromeAutomationPageAdapter => {
      const existing = pages.get(page);
      if (existing !== undefined) return existing;
      const adapted = makePlaywrightPageAdapter(page);
      pages.set(page, adapted);
      return adapted;
    };
    return {
      pages: async () => (await context.pages()).map(adaptPage),
      newPage: async () => adaptPage(await context.newPage()),
      close: () => context.close(),
    };
  },
});

export const make = Effect.fn("ChromeAutomation.make")(function* (
  options: ChromeAutomationOptions = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);
  const crypto = yield* Crypto.Crypto;
  const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const profileDir = path.join(config.stateDir, PROFILE_DIRECTORY);
  const adapter = options.adapter ?? makePlaywrightAdapter();
  const shouldDiscoverExecutable =
    options.adapter === undefined && options.executablePath === undefined;
  let executablePath =
    options.executablePath ?? (shouldDiscoverExecutable ? undefined : "injected");
  let launchChannel: ChromeAutomationLaunchTarget["channel"] = undefined;

  let browser: ChromeAutomationBrowser | undefined;
  let selectedTabId: string | undefined;
  let tabSequence = 0;
  let snapshotSequence = 0;
  let tabs = new Map<string, ManagedTab>();
  let status: ChromeAutomationStatus = {
    lifecycle: "stopped",
    profileDir,
    executablePath,
    selectedTabId: undefined,
    error: undefined,
  };
  let expectedDisconnect = false;
  let connectionSequence = 0;
  let activeConnection = 0;
  let preferredTabUrl: string | undefined;

  const provideExecutableDiscoveryServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const rememberSelectedTab = () => {
    if (selectedTabId === undefined) return;
    const selected = tabs.get(selectedTabId);
    if (selected === undefined) return;
    try {
      preferredTabUrl = selected.page.url();
    } catch {
      // The page may already be gone; the next connection will choose its first tab.
    }
  };

  const setFailed = (retainedBrowser?: ChromeAutomationBrowser) => {
    browser = retainedBrowser;
    tabs = new Map();
    selectedTabId = undefined;
    status = {
      ...status,
      lifecycle: "failed",
      selectedTabId: undefined,
      error: UNAVAILABLE_MESSAGE,
    };
  };

  const invalidateConnection = () => {
    rememberSelectedTab();
    const currentBrowser = browser;
    browser = undefined;
    tabs = new Map();
    selectedTabId = undefined;
    activeConnection = ++connectionSequence;
    status = {
      ...status,
      lifecycle: "failed",
      selectedTabId: undefined,
      error: UNAVAILABLE_MESSAGE,
    };
    return currentBrowser;
  };

  const failStart = (cause: unknown) =>
    Effect.gen(function* () {
      yield* Effect.logError("managed Chrome failed to start", {
        profileDir,
        executablePath: status.executablePath,
        channel: launchChannel,
        detail: errorDetail(cause),
        cause,
      });
      const currentBrowser = browser;
      expectedDisconnect = true;
      let retainedBrowser: ChromeAutomationBrowser | undefined;
      if (currentBrowser !== undefined) {
        const closed = yield* Effect.tryPromise({
          try: () => currentBrowser.close(),
          catch: (closeCause) => failure("cleanup", closeCause),
        }).pipe(Effect.result);
        if (closed._tag === "Failure") retainedBrowser = currentBrowser;
      }
      setFailed(retainedBrowser);
    });

  const onDisconnected = (connection: number) => {
    if (
      connection === activeConnection &&
      !expectedDisconnect &&
      status.lifecycle !== "stopped" &&
      status.lifecycle !== "stopping"
    ) {
      invalidateConnection();
    }
  };

  const refreshTabs = Effect.fn("ChromeAutomation.refreshTabs")(function* () {
    if (browser === undefined) {
      return yield* Effect.fail(new ChromeAutomationError("tabs", "Chrome is not connected."));
    }
    const pages = yield* Effect.tryPromise({
      try: () => browser!.pages(),
      catch: (cause) => failure("tabs", cause),
    });
    const nextTabs = new Map<string, ManagedTab>();
    for (const page of pages) {
      const existing = Array.from(tabs.values()).find((tab) => tab.page === page);
      const tab =
        existing ??
        ({
          id: `tab-${++tabSequence}-${sessionId}`,
          page,
          refs: new Map<string, string>(),
          snapshotDocumentVersion: undefined,
        } satisfies ManagedTab);
      nextTabs.set(tab.id, tab);
    }
    tabs = nextTabs;
    if (selectedTabId === undefined && preferredTabUrl !== undefined) {
      for (const tab of tabs.values()) {
        const currentUrl = yield* Effect.try({
          try: () => tab.page.url(),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (currentUrl === preferredTabUrl) {
          selectedTabId = tab.id;
          break;
        }
      }
    }
    if (selectedTabId === undefined && tabs.size > 0) selectedTabId = tabs.keys().next().value;
    status = { ...status, selectedTabId };
    return tabs;
  });

  const selectedTab = Effect.fn("ChromeAutomation.selectedTab")(function* (tabId?: string) {
    yield* refreshTabs();
    const targetTabId = tabId ?? selectedTabId;
    if (targetTabId === undefined) {
      return yield* Effect.fail(new ChromeAutomationError("tab", "Chrome has no open tabs."));
    }
    const tab = tabs.get(targetTabId);
    if (tab === undefined) {
      return yield* Effect.fail(
        new ChromeAutomationError(
          "tab",
          `Tab ${targetTabId} no longer exists. List tabs and select a target.`,
        ),
      );
    }
    if (tab.snapshotDocumentVersion !== tab.page.documentVersion()) tab.refs = new Map();
    return tab;
  });

  const tabInfo = Effect.fn("ChromeAutomation.tabInfo")(function* (tab: ManagedTab) {
    const [url, title] = yield* Effect.tryPromise({
      try: () => Promise.all([Promise.resolve(tab.page.url()), tab.page.title()]),
      catch: (cause) => failure("tab", cause),
    });
    return {
      id: tab.id,
      url,
      title,
      selected: tab.id === selectedTabId,
    } satisfies ChromeAutomationTab;
  });

  const startConnected = Effect.gen(function* () {
    if (status.lifecycle === "connected" && browser !== undefined) return status;
    if (browser !== undefined) {
      const staleBrowser = browser;
      expectedDisconnect = true;
      activeConnection = ++connectionSequence;
      yield* Effect.tryPromise({
        try: () => staleBrowser.close(),
        catch: (cause) => failure("cleanup", cause),
      });
      browser = undefined;
    }
    status = { ...status, lifecycle: "starting", error: undefined };
    expectedDisconnect = false;
    launchChannel = undefined;
    const connection = ++connectionSequence;
    const launchTarget = shouldDiscoverExecutable
      ? yield* provideExecutableDiscoveryServices(resolveInstalledChrome())
      : ({
          executablePath: executablePath!,
          channel: undefined,
        } satisfies ChromeAutomationLaunchTarget);
    executablePath = launchTarget.executablePath;
    launchChannel = launchTarget.channel;
    status = { ...status, executablePath: launchTarget.executablePath };
    activeConnection = connection;
    const launched = yield* Effect.tryPromise({
      try: () =>
        adapter.launchPersistentContext({
          executablePath: launchTarget.executablePath,
          channel: launchTarget.channel,
          userDataDir: profileDir,
          headless: false,
          args: profileArguments(),
          onDisconnected: () => onDisconnected(connection),
        }),
      catch: (cause) => failure("start", cause),
    });
    if (activeConnection !== connection || status.lifecycle === "failed") {
      expectedDisconnect = true;
      yield* Effect.tryPromise({
        try: () => launched.close(),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      return yield* Effect.fail(new ChromeAutomationError("start", "Chrome disconnected."));
    }
    browser = launched;
    tabs = new Map();
    selectedTabId = undefined;
    yield* refreshTabs();
    if (tabs.size === 0) {
      const page = yield* Effect.tryPromise({
        try: () => browser!.newPage(),
        catch: (cause) => failure("start", cause),
      });
      const id = `tab-${++tabSequence}-${sessionId}`;
      tabs.set(id, { id, page, refs: new Map(), snapshotDocumentVersion: undefined });
      selectedTabId = id;
    }
    status = { ...status, lifecycle: "connected", selectedTabId, error: undefined };
    preferredTabUrl = undefined;
    return status;
  });

  const startOnce = startConnected.pipe(
    Effect.tapError(failStart),
    Effect.mapError((cause) => unavailableFailure("start", cause)),
    Effect.uninterruptible,
  );

  const start = mutex.withPermit(startOnce);

  const ensureConnected = Effect.fn("ChromeAutomation.ensureConnected")(function* () {
    if (status.lifecycle === "connected" && browser !== undefined) return;
    yield* startOnce;
  });

  const recoverOnce = Effect.fn("ChromeAutomation.recoverOnce")(function* (operation: string) {
    const currentBrowser = invalidateConnection();
    expectedDisconnect = true;
    if (currentBrowser !== undefined) {
      yield* Effect.tryPromise({
        try: () => currentBrowser.close(),
        catch: (cause) => unavailableFailure(operation, cause),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            browser = currentBrowser;
          }),
        ),
      );
    }
    yield* startOnce.pipe(
      Effect.mapError(() =>
        unavailableFailure(operation, "Recovery failed for " + operation + "."),
      ),
    );
  });

  const action = <A>(
    operation: string,
    use: () => Effect.Effect<A, ChromeAutomationError>,
    replaySafe = false,
  ): Effect.Effect<A, ChromeAutomationError> =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (!replaySafe && status.lifecycle === "failed") {
          return yield* Effect.fail(
            new ChromeAutomationError(
              operation,
              "Chrome disconnected. List tabs and inspect the target before retrying an action.",
            ),
          );
        }
        yield* ensureConnected();
        const first = yield* Effect.result(use());
        if (first._tag === "Success" && status.lifecycle !== "failed") return first.success;
        if (
          first._tag === "Failure" &&
          !isRecoverableTransportFailure(first.failure) &&
          status.lifecycle !== "failed"
        ) {
          return yield* Effect.fail(first.failure);
        }

        if (!replaySafe) {
          status = { ...status, lifecycle: "failed", error: UNAVAILABLE_MESSAGE };
          for (const tab of tabs.values()) tab.refs = new Map();
          return yield* Effect.fail(
            new ChromeAutomationError(
              operation,
              "Chrome disconnected during the action. Its outcome is unknown and it was not replayed. List tabs and inspect the target before retrying.",
              first._tag === "Failure" ? first.failure : undefined,
            ),
          );
        }
        yield* recoverOnce(operation);
        const second = yield* Effect.result(use());
        if (second._tag === "Success" && status.lifecycle !== "failed") return second.success;
        if (second._tag === "Success") {
          return yield* Effect.fail(unavailableFailure(operation, "Chrome disconnected."));
        }
        if (isRecoverableTransportFailure(second.failure) || status.lifecycle === "failed") {
          setFailed(browser);
          return yield* Effect.fail(unavailableFailure(operation, second.failure));
        }
        return yield* Effect.fail(second.failure);
      }).pipe(Effect.uninterruptible),
    );

  const stop = mutex.withPermit(
    Effect.gen(function* () {
      if (browser === undefined) {
        preferredTabUrl = undefined;
        status = { ...status, lifecycle: "stopped", selectedTabId: undefined, error: undefined };
        return status;
      }
      status = { ...status, lifecycle: "stopping" };
      expectedDisconnect = true;
      activeConnection = ++connectionSequence;
      const currentBrowser = browser;
      yield* Effect.tryPromise({
        try: () => currentBrowser.close(),
        catch: (cause) => failure("stop", cause),
      });
      browser = undefined;
      tabs = new Map();
      selectedTabId = undefined;
      preferredTabUrl = undefined;
      status = { ...status, lifecycle: "stopped", selectedTabId: undefined, error: undefined };
      return status;
    }).pipe(Effect.tapError(() => Effect.sync(() => setFailed(browser)))),
  );

  yield* Effect.addFinalizer(() => Effect.ignore(stop));

  const service: ChromeAutomation["Service"] = {
    start: () => start,
    stop: () => stop,
    status: () => Effect.succeed({ ...status, selectedTabId }),
    listTabs: () =>
      action(
        "tabs",
        () =>
          Effect.gen(function* () {
            const managed = yield* refreshTabs();
            return yield* Effect.forEach(managed.values(), tabInfo);
          }),
        true,
      ),
    selectTab: (tabId) =>
      action(
        "selectTab",
        () =>
          Effect.gen(function* () {
            yield* refreshTabs();
            const tab = tabs.get(tabId);
            if (tab === undefined) {
              return yield* Effect.fail(
                new ChromeAutomationError("selectTab", `Unknown tab ${tabId}.`),
              );
            }
            selectedTabId = tabId;
            status = { ...status, selectedTabId };
            return yield* tabInfo(tab);
          }),
        true,
      ),
    navigate: (url, options = {}) =>
      action("navigate", () =>
        Effect.gen(function* () {
          if (
            options.timeoutMs !== undefined &&
            (!Number.isFinite(options.timeoutMs) ||
              options.timeoutMs < 1 ||
              options.timeoutMs > MAX_TIMEOUT_MS)
          ) {
            return yield* Effect.fail(
              new ChromeAutomationError(
                "navigate",
                `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`,
              ),
            );
          }
          const tab = yield* selectedTab(options.tabId);
          tab.refs = new Map();
          yield* Effect.tryPromise({
            try: () =>
              tab.page.goto(url, {
                waitUntil: options.waitUntil ?? "domcontentloaded",
                timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              }),
            catch: (cause) => failure("navigate", cause),
          });
          return yield* tabInfo(tab);
        }),
      ),
    snapshot: (tabId, options = {}) =>
      action(
        "snapshot",
        () =>
          Effect.gen(function* () {
            const tab = yield* selectedTab(tabId);
            tab.refs = new Map();
            const documentVersion = tab.page.documentVersion();
            const snapshot = yield* Effect.tryPromise({
              try: () => tab.page.snapshot({ includeDom: options.includeDom === true }),
              catch: (cause) => failure("snapshot", cause),
            });
            if (documentVersion !== tab.page.documentVersion()) {
              return yield* Effect.fail(
                new ChromeAutomationError(
                  "snapshot",
                  "The page navigated during the snapshot. Take a fresh snapshot.",
                ),
              );
            }
            const snapshotId = ++snapshotSequence;
            const refs = snapshot.refs.map((ref, index) => ({
              ...ref,
              ref: `${tab.id}-snapshot-${snapshotId}-ref-${index + 1}`,
            }));
            tab.refs = new Map(refs.map((ref, index) => [ref.ref, snapshot.refs[index]!.ref]));
            tab.snapshotDocumentVersion = documentVersion;
            return {
              ...snapshot,
              refs,
              accessibilityTree: truncate(
                snapshot.accessibilityTree,
                MAX_ACCESSIBILITY_SNAPSHOT_CHARS,
              ),
              ...(snapshot.dom === undefined
                ? {}
                : { dom: truncate(snapshot.dom, MAX_DOM_SNAPSHOT_CHARS) }),
              tabId: tab.id,
            };
          }),
        true,
      ),
    screenshot: (tabId) =>
      action(
        "screenshot",
        () =>
          Effect.gen(function* () {
            const tab = yield* selectedTab(tabId);
            const documentVersion = tab.page.documentVersion();
            const bytes = yield* Effect.tryPromise({
              try: () => tab.page.screenshotPng(),
              catch: (cause) => failure("screenshot", cause),
            });
            if (documentVersion !== tab.page.documentVersion()) {
              return yield* Effect.fail(
                new ChromeAutomationError(
                  "screenshot",
                  "The page navigated during capture. Take a fresh screenshot.",
                ),
              );
            }
            if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
              return yield* Effect.fail(
                new ChromeAutomationError(
                  "screenshot",
                  "The PNG screenshot exceeds the 5 MiB limit. Reduce the Chrome viewport size.",
                ),
              );
            }
            const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (
              png.length < 24 ||
              png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
              png.toString("ascii", 12, 16) !== "IHDR"
            ) {
              return yield* Effect.fail(
                new ChromeAutomationError(
                  "screenshot",
                  "Chrome did not return a valid PNG screenshot.",
                ),
              );
            }
            const width = png.readUInt32BE(16);
            const height = png.readUInt32BE(20);
            if (!isSupportedScreenshotSize(width, height)) {
              return yield* Effect.fail(
                new ChromeAutomationError(
                  "screenshot",
                  `Screenshot dimensions must be between 1 and ${MAX_SCREENSHOT_DIMENSION} pixels.`,
                ),
              );
            }
            return {
              tabId: tab.id,
              mimeType: "image/png" as const,
              data: png.toString("base64"),
              width,
              height,
            };
          }),
        true,
      ),
    click: (target, tabId) =>
      action("click", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab(tabId);
          const pageTarget = yield* Effect.try({
            try: () => resolvePageTarget(target, tab.refs),
            catch: (cause) =>
              cause instanceof ChromeAutomationError ? cause : failure("target", cause),
          });
          tab.refs = new Map();
          yield* Effect.tryPromise({
            try: () => tab.page.click(pageTarget),
            catch: (cause) => failure("click", cause),
          });
        }),
      ),
    fill: (target, value, tabId) =>
      action("fill", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab(tabId);
          const pageTarget = yield* Effect.try({
            try: () => resolvePageTarget(target, tab.refs),
            catch: (cause) =>
              cause instanceof ChromeAutomationError ? cause : failure("target", cause),
          });
          tab.refs = new Map();
          yield* Effect.tryPromise({
            try: () => tab.page.fill(pageTarget, value),
            catch: (cause) => failure("fill", cause),
          });
        }),
      ),
    type: (target, value, tabId) =>
      action("type", () =>
        Effect.gen(function* () {
          const tab = yield* selectedTab(tabId);
          const pageTarget = yield* Effect.try({
            try: () => resolvePageTarget(target, tab.refs),
            catch: (cause) =>
              cause instanceof ChromeAutomationError ? cause : failure("target", cause),
          });
          tab.refs = new Map();
          yield* Effect.tryPromise({
            try: () => tab.page.type(pageTarget, value),
            catch: (cause) => failure("type", cause),
          });
        }),
      ),
  };

  return ChromeAutomation.of(service);
});

export const layer = Layer.effect(ChromeAutomation, make());
export const layerWithOptions = (options: ChromeAutomationOptions) =>
  Layer.effect(ChromeAutomation, make(options));
