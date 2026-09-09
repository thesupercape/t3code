import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Page } from "playwright-core";

import * as ServerConfig from "../config.ts";
import * as ChromeAutomation from "./ChromeAutomation.ts";
import { collectSnapshotRefs, type SnapshotElement } from "./ChromeSnapshot.ts";

interface TestElement extends SnapshotElement {
  readonly identity: string;
  parentElement: TestElement | null;
  previousElementSibling: TestElement | null;
  isConnected: boolean;
}

const element = (identity: string, tagName: string, host?: TestElement): TestElement => ({
  identity,
  tagName,
  parentElement: null,
  previousElementSibling: null,
  isConnected: true,
  textContent: identity,
  getAttribute: (name) => (name === "id" ? "duplicate-id" : null),
  getRootNode: () => (host === undefined ? {} : { host }),
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 30 }),
});

const makePage = (shadow = false) => {
  const body = element("body", "BODY");
  const host = element("host", "CUSTOM-FORM");
  host.parentElement = body;
  let nodes: ReadonlyArray<TestElement> = [];
  const calls: Array<{ kind: string; identity: string; value?: string }> = [];
  const disposed: Array<string> = [];
  const setNodes = (next: ReadonlyArray<TestElement>) => {
    for (const node of nodes) node.isConnected = next.includes(node);
    nodes = next;
    next.forEach((node, index) => {
      node.parentElement = shadow ? null : body;
      node.previousElementSibling = next[index - 1] ?? null;
      node.isConnected = true;
    });
  };
  const actions = (resolve: () => TestElement) => ({
    click: async () => {
      const node = resolve();
      if (!node.isConnected) throw new Error("Element is not attached to the DOM");
      calls.push({ kind: "click", identity: node.identity });
    },
    fill: async (value: string) => {
      const node = resolve();
      if (!node.isConnected) throw new Error("Element is not attached to the DOM");
      calls.push({ kind: "fill", identity: node.identity, value });
    },
    type: async (value: string) => {
      const node = resolve();
      if (!node.isConnected) throw new Error("Element is not attached to the DOM");
      calls.push({ kind: "type", identity: node.identity, value });
    },
  });
  const events = new Map<string, (frame?: unknown) => void>();
  const mainFrame = {};
  const page = {
    on: (event: string, callback: (frame?: unknown) => void) => {
      events.set(event, callback);
    },
    mainFrame: () => mainFrame,
    url: () => "https://identity.test",
    title: async () => "Identity",
    evaluate: async (
      callback: (elements: ReadonlyArray<unknown>) => unknown,
      handles: ReadonlyArray<{ node: TestElement }>,
    ) => callback(handles.map((handle) => handle.node)),
    locator: (selector: string) => {
      const dynamicActions = actions(() => {
        const match = collectSnapshotRefs(nodes).findIndex((entry) => entry.selector === selector);
        if (match < 0) throw new Error(`Selector did not match: ${selector}`);
        return nodes[match]!;
      });
      return {
        ...dynamicActions,
        pressSequentially: dynamicActions.type,
        ariaSnapshot: async () => "- document",
        evaluate: async () => "<body></body>",
        evaluateAll: async (callback: (elements: ReadonlyArray<unknown>) => unknown) =>
          callback(nodes),
        elementHandles: async () =>
          nodes.map((node) => ({
            node,
            ...actions(() => node),
            evaluate: async (callback: (node: TestElement) => unknown) => callback(node),
            dispose: async () => {
              disposed.push(node.identity);
            },
          })),
      };
    },
  } as unknown as Page;
  const adapter = ChromeAutomation.makePlaywrightPageAdapter(page);
  return {
    node: (identity: string) => element(identity, "INPUT", shadow ? host : undefined),
    setNodes,
    calls,
    disposed,
    navigate: () => events.get("framenavigated")?.(mainFrame),
    browser: {
      launchPersistentContext: async () => ({
        pages: async () => [adapter],
        newPage: async () => adapter,
        close: async () => {
          events.get("close")?.();
        },
      }),
    } satisfies ChromeAutomation.ChromeAutomationBrowserAdapter,
  };
};

const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-chrome-identity-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.effect("keeps compact refs bound to their original handles after filtering and truncation", () =>
  provideServices(
    Effect.gen(function* () {
      const fixture = makePage();
      const hidden = {
        ...fixture.node("hidden"),
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      };
      const visible = Array.from({ length: 301 }, (_, index) => fixture.node(`visible-${index}`));
      fixture.setNodes([hidden, ...visible]);
      const automation = yield* ChromeAutomation.make({ adapter: fixture.browser });
      const snapshot = yield* automation.snapshot();
      assert.equal(snapshot.dom, undefined);
      assert.equal(snapshot.refs.length, 300);
      assert.deepEqual(fixture.disposed, ["hidden", "visible-300"]);
      yield* automation.click({ ref: snapshot.refs[299]!.ref }, snapshot.tabId);
      assert.deepEqual(fixture.calls, [{ kind: "click", identity: "visible-299" }]);
      const expanded = yield* automation.snapshot(snapshot.tabId, { includeDom: true });
      assert.equal(expanded.dom, "<body></body>");
    }),
  ),
);

it.effect.each([false, true])(
  "keeps refs bound after sibling insertion and reorder, shadow=%s",
  (shadow) =>
    provideServices(
      Effect.gen(function* () {
        const fixture = makePage(shadow);
        const first = fixture.node("first");
        const target = fixture.node("target");
        fixture.setNodes([first, target]);
        const automation = yield* ChromeAutomation.make({ adapter: fixture.browser });
        const snapshot = yield* automation.snapshot();
        fixture.setNodes([target, fixture.node("inserted"), first]);
        yield* automation.click({ ref: snapshot.refs[1]!.ref }, snapshot.tabId);
        assert.deepEqual(fixture.calls, [{ kind: "click", identity: "target" }]);
      }),
    ),
);

it.effect.each(
  (["click", "fill", "type"] as const).flatMap((operation) =>
    [false, true].map((shadow) => ({ operation, shadow })),
  ),
)(
  "rejects detached elements instead of acting on a replacement: $operation, shadow=$shadow",
  ({ operation, shadow }) =>
    provideServices(
      Effect.gen(function* () {
        const fixture = makePage(shadow);
        const original = fixture.node("original");
        fixture.setNodes([original]);
        const automation = yield* ChromeAutomation.make({ adapter: fixture.browser });
        const snapshot = yield* automation.snapshot();
        fixture.setNodes([fixture.node("replacement")]);
        const target = { ref: snapshot.refs[0]!.ref };
        const action =
          operation === "click"
            ? automation.click(target, snapshot.tabId)
            : automation[operation](target, "value", snapshot.tabId);
        const error = yield* action.pipe(Effect.flip);
        assert.include(error.detail, "detached");
        assert.equal(fixture.calls.length, 0);
      }),
    ),
);

it.effect("keeps explicit CSS selectors dynamic", () =>
  provideServices(
    Effect.gen(function* () {
      const fixture = makePage();
      fixture.setNodes([fixture.node("original")]);
      const automation = yield* ChromeAutomation.make({ adapter: fixture.browser });
      const snapshot = yield* automation.snapshot();
      fixture.setNodes([fixture.node("replacement")]);
      yield* automation.click({ selector: snapshot.refs[0]!.selector }, snapshot.tabId);
      assert.deepEqual(fixture.calls, [{ kind: "click", identity: "replacement" }]);
    }),
  ),
);

it.effect(
  "releases captured handles after snapshot replacement, input, navigation, and close",
  () =>
    provideServices(
      Effect.gen(function* () {
        const fixture = makePage();
        fixture.setNodes([fixture.node("original")]);
        const automation = yield* ChromeAutomation.make({ adapter: fixture.browser });
        yield* automation.snapshot();
        const snapshot = yield* automation.snapshot();
        assert.deepEqual(fixture.disposed, ["original"]);
        yield* automation.type({ ref: snapshot.refs[0]!.ref }, "hello", snapshot.tabId);
        assert.deepEqual(fixture.calls, [{ kind: "type", identity: "original", value: "hello" }]);
        assert.deepEqual(fixture.disposed, ["original", "original"]);
        yield* automation.snapshot();
        fixture.navigate();
        assert.deepEqual(fixture.disposed, ["original", "original", "original"]);
        yield* automation.snapshot();
        yield* automation.stop();
        assert.deepEqual(fixture.disposed, ["original", "original", "original", "original"]);
      }),
    ),
);

it.effect("releases handles when a captured element detaches before metadata collection", () =>
  provideServices(
    Effect.gen(function* () {
      const fixture = makePage();
      const node = fixture.node("original");
      fixture.setNodes([node]);
      node.isConnected = false;
      const automation = yield* ChromeAutomation.make({ adapter: fixture.browser });
      const error = yield* automation.snapshot().pipe(Effect.flip);
      assert.include(error.detail, "detached");
      assert.deepEqual(fixture.disposed, ["original"]);
      assert.equal(fixture.calls.length, 0);
    }),
  ),
);
