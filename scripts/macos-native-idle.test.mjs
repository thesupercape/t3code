import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { proveNativeIdle, sourceKinds } from "./macos-native-idle.mjs";

const bindings = [{ thread_id: "t3", native_id: "native" }];
const thread = { id: "native", status: { type: "idle" } };
const replies = () => ({
  "thread/list": { result: { data: [thread], nextCursor: null } },
  "thread/loaded/list": { result: { data: [thread.id], nextCursor: null } },
  "thread/read": { result: { thread } },
  "thread/turns/list": { result: { data: [{ id: "last", status: "completed" }] } },
});
const fixtureRpc = (fixture) => async (method, params) =>
  method === "thread/list" && params.archived
    ? { result: { data: [], nextCursor: null } }
    : fixture[method];

NodeTest.test("only read-only native methods and notLoaded turn items", async () => {
  const fixture = replies();
  const methods = [];
  const proof = await proveNativeIdle(async (method, params) => {
    methods.push(method);
    if (method === "thread/list") {
      NodeAssert.equal(params.limit, 100);
      NodeAssert.equal(params.sortKey, "updated_at");
      NodeAssert.deepEqual(params.modelProviders, []);
      NodeAssert.deepEqual(params.sourceKinds, [
        "cli",
        "vscode",
        "appServer",
        "exec",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
        "unknown",
      ]);
    }
    if (method === "thread/read") NodeAssert.equal(params.includeTurns, false);
    if (method === "thread/turns/list") {
      NodeAssert.equal(params.itemsView, "notLoaded");
      NodeAssert.equal(params.limit, 1);
      NodeAssert.equal(params.sortDirection, "desc");
    }
    return fixtureRpc(fixture)(method, params);
  }, bindings);
  NodeAssert.equal(proof.idle, true);
  NodeAssert.equal(proof.bindings_checked, 1);
  NodeAssert.deepEqual(methods, [
    "thread/list",
    "thread/list",
    "thread/loaded/list",
    "thread/read",
    "thread/turns/list",
  ]);
});

NodeTest.test("active Elora native root refuses, including later list pages", async () => {
  let page = 0;
  const proof = await proveNativeIdle(async (method) => {
    NodeAssert.equal(method, "thread/list");
    return ++page === 1
      ? { result: { data: [thread], nextCursor: "second" } }
      : { result: { data: [{ id: "root", status: { type: "active" } }], nextCursor: null } };
  }, bindings);
  NodeAssert.equal(page, 2);
  NodeAssert.equal(proof.busy, true);
});

for (const [name, mutation] of [
  [
    "unknown mapping",
    (r) => {
      r["thread/read"].result.thread = { ...thread, id: "wrong" };
    },
  ],
  [
    "unknown native status",
    (r) => {
      r["thread/list"].result.data = [{ ...thread, status: { type: "mystery" } }];
    },
  ],
  [
    "RPC errors",
    (r) => {
      r["thread/turns/list"] = { error: { code: 1 } };
    },
  ],
  [
    "unknown turn",
    (r) => {
      r["thread/turns/list"].result.data = [{ id: "turn", status: "unknown" }];
    },
  ],
  [
    "empty latest turn",
    (r) => {
      r["thread/turns/list"].result.data = [];
    },
  ],
]) {
  NodeTest.test(name + " holds", async () => {
    const fixture = replies();
    mutation(fixture);
    await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings));
  });
}

NodeTest.test("inProgress turn is busy despite idle native thread", async () => {
  const fixture = replies();
  fixture["thread/turns/list"].result.data[0].status = "inProgress";
  NodeAssert.equal((await proveNativeIdle(fixtureRpc(fixture), bindings)).busy, true);
});

NodeTest.test("repeated pagination cursor holds", async () => {
  await NodeAssert.rejects(
    proveNativeIdle(async () => ({ result: { data: [thread], nextCursor: "repeated" } }), []),
  );
});

NodeTest.test("active child and archived native turns are never omitted", async () => {
  for (const archived of [false, true]) {
    for (const kind of sourceKinds) {
      const observed = [];
      const proof = await proveNativeIdle(async (method, params) => {
        NodeAssert.equal(method, "thread/list");
        observed.push(params.archived);
        NodeAssert.ok(params.sourceKinds.includes(kind));
        return {
          result: {
            data:
              params.archived === archived
                ? [{ id: "child", source: kind, status: { type: "active" } }]
                : [],
            nextCursor: null,
          },
        };
      }, []);
      NodeAssert.equal(proof.busy, true);
      NodeAssert.deepEqual(observed, archived ? [false, true] : [false]);
    }
  }
});

NodeTest.test("inconsistent list/read state holds", async () => {
  const fixture = replies();
  fixture["thread/read"].result.thread = { ...thread, status: { type: "notLoaded" } };
  await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings));
});

NodeTest.test("duplicate inactive IDs across lists/pages are deduplicated", async () => {
  const fixture = replies();
  let calls = 0;
  const proof = await proveNativeIdle(async (method, params) => {
    if (method === "thread/list" || method === "thread/loaded/list") {
      const data = method === "thread/list" ? [thread, thread] : [thread.id, thread.id];
      return { result: { data, nextCursor: params.cursor === null ? "second" : null } };
    }
    if (method === "thread/read") calls++;
    return fixture[method];
  }, bindings);
  NodeAssert.equal(proof.idle, true);
  NodeAssert.equal(proof.threads_checked, 1);
  NodeAssert.equal(calls, 1);
});

NodeTest.test("conflicting duplicate inactive statuses hold", async () => {
  const fixture = replies();
  fixture["thread/list"].result.data.push({ ...thread, status: { type: "notLoaded" } });
  await NodeAssert.rejects(proveNativeIdle(fixtureRpc(fixture), bindings), /status-inconsistent/);
});

const unionRpc = ({ listed = [thread], loaded = [thread.id], metadata = [thread] } = {}) => {
  const fixture = replies();
  return async (method, params) => {
    if (method === "thread/list")
      return { result: { data: params.archived ? [] : listed, nextCursor: null } };
    if (method === "thread/loaded/list") return { result: { data: loaded, nextCursor: null } };
    if (method === "thread/read") {
      NodeAssert.equal(params.includeTurns, false);
      return { result: { thread: metadata.find((value) => value.id === params.threadId) } };
    }
    return fixture[method];
  };
};

NodeTest.test("hidden loaded active children hold while both roots are idle", async () => {
  const roots = [thread, { ...thread, id: "other-root" }];
  for (const id of ["hidden-child", "hidden-root"]) {
    const proof = await proveNativeIdle(
      unionRpc({
        listed: roots,
        loaded: [...roots.map((root) => root.id), id],
        metadata: [...roots, { id, status: { type: "active" } }],
      }),
      bindings,
    );
    NodeAssert.deepEqual(proof, { idle: false, busy: true });
  }
});

NodeTest.test("loaded metadata active overrides a stale idle list row", async () => {
  NodeAssert.equal(
    (
      await proveNativeIdle(
        unionRpc({
          metadata: [{ ...thread, status: { type: "active" } }],
        }),
        bindings,
      )
    ).busy,
    true,
  );
});

NodeTest.test(
  "loaded-only idle sessions join the fingerprint without assuming turn history",
  async () => {
    const hidden = { id: "hidden", status: { type: "idle" } };
    const proof = await proveNativeIdle(
      unionRpc({
        loaded: [thread.id, hidden.id],
        metadata: [thread, hidden],
      }),
      bindings,
    );
    NodeAssert.equal(proof.idle, true);
    NodeAssert.equal(proof.threads_checked, 2);
    NodeAssert.equal(proof.bindings_checked, 1);
    const baseline = await proveNativeIdle(unionRpc(), bindings);
    NodeAssert.notEqual(proof.fingerprint, baseline.fingerprint);
  },
);

NodeTest.test("a mapped loaded-only thread still requires its latest ended turn", async () => {
  const rpc = unionRpc({ listed: [] });
  NodeAssert.equal((await proveNativeIdle(rpc, bindings)).idle, true);
  await NodeAssert.rejects(
    proveNativeIdle(
      async (method, params) =>
        method === "thread/turns/list" ? { result: { data: [] } } : rpc(method, params),
      bindings,
    ),
    /latest-turn-unavailable/,
  );
});

NodeTest.test("unlisted and unloaded mapping holds even if metadata could be read", async () => {
  await NodeAssert.rejects(
    proveNativeIdle(unionRpc({ listed: [], loaded: [] }), bindings),
    /mapping-not-in-inventory/,
  );
});

NodeTest.test("every loaded page is included, including a later hidden active child", async () => {
  const rpc = unionRpc({ metadata: [thread, { id: "hidden", status: { type: "active" } }] });
  const cursors = [];
  const proof = await proveNativeIdle(async (method, params) => {
    if (method === "thread/loaded/list") {
      cursors.push(params.cursor);
      NodeAssert.equal(params.limit, 100);
      return params.cursor === null
        ? { result: { data: [thread.id], nextCursor: "second" } }
        : { result: { data: ["hidden"], nextCursor: null } };
    }
    return rpc(method, params);
  }, bindings);
  NodeAssert.deepEqual(cursors, [null, "second"]);
  NodeAssert.equal(proof.busy, true);
});

for (const [name, result] of [
  ["unsupported", { error: { code: -32601 } }],
  ["missing", {}],
  ["malformed data", { result: { data: {} } }],
  ["missing identity", { result: { data: [null] } }],
  ["empty identity", { result: { data: [""] } }],
  ["whitespace identity", { result: { data: [" "] } }],
  ["object identity", { result: { data: [{ id: "hidden" }] } }],
  ["malformed cursor", { result: { data: [], nextCursor: 1 } }],
  ["empty cursor", { result: { data: [], nextCursor: "" } }],
  ["repeated cursor", { result: { data: [], nextCursor: "repeat" } }],
]) {
  NodeTest.test("loaded list " + name + " holds", async () => {
    const rpc = unionRpc();
    await NodeAssert.rejects(
      proveNativeIdle(
        async (method, params) => (method === "thread/loaded/list" ? result : rpc(method, params)),
        bindings,
      ),
    );
  });
}

NodeTest.test("loaded list transport failure holds", async () => {
  const rpc = unionRpc();
  await NodeAssert.rejects(
    proveNativeIdle(async (method, params) => {
      if (method === "thread/loaded/list") throw Error("transport failure");
      return rpc(method, params);
    }, bindings),
    /transport failure/,
  );
});

for (const [name, reply] of [
  ["missing", {}],
  ["missing thread", { result: {} }],
  ["mismatched", { result: { thread: { id: "wrong", status: { type: "idle" } } } }],
  ["unknown status", { result: { thread: { id: "hidden", status: { type: "mystery" } } } }],
  ["missing status", { result: { thread: { id: "hidden" } } }],
  ["RPC error", { error: { code: 1 } }],
]) {
  NodeTest.test("loaded-only metadata " + name + " holds", async () => {
    const rpc = unionRpc({ loaded: [thread.id, "hidden"] });
    await NodeAssert.rejects(
      proveNativeIdle(
        async (method, params) =>
          method === "thread/read" && params.threadId === "hidden" ? reply : rpc(method, params),
        bindings,
      ),
    );
  });
}

NodeTest.test(
  "union fingerprints are stable across ordering and change before a capture/gate",
  async () => {
    const hidden = { id: "hidden", status: { type: "idle" } };
    const capture = () =>
      proveNativeIdle(
        unionRpc({
          listed: [thread, hidden],
          loaded: [thread.id, hidden.id],
          metadata: [thread, hidden],
        }),
        bindings,
      );
    const first = await capture();
    const second = await capture();
    NodeAssert.deepEqual(first, second);
    NodeAssert.deepEqual(
      first,
      await proveNativeIdle(
        unionRpc({
          listed: [hidden, thread],
          loaded: [hidden.id, thread.id],
          metadata: [hidden, thread],
        }),
        bindings,
      ),
    );
    for (const changed of [
      { listed: [thread], loaded: [thread.id, hidden.id], metadata: [thread, hidden] },
      { listed: [thread, hidden], loaded: [thread.id], metadata: [thread, hidden] },
      { listed: [thread], loaded: [thread.id], metadata: [thread] },
      { listed: [thread, { ...hidden, status: { type: "notLoaded" } }], loaded: [thread.id] },
    ]) {
      const gate = await proveNativeIdle(unionRpc(changed), bindings);
      NodeAssert.notEqual(first.fingerprint, gate.fingerprint);
      NodeAssert.notDeepEqual(first, gate);
    }
    const busyGate = await proveNativeIdle(
      unionRpc({
        listed: [thread, hidden],
        loaded: [thread.id, hidden.id],
        metadata: [thread, { ...hidden, status: { type: "active" } }],
      }),
      bindings,
    );
    NodeAssert.equal(busyGate.busy, true);
  },
);
