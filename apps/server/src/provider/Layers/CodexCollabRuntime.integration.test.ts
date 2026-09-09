/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";
const encodeScript = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: CHILD_A,
        turnId: `${CHILD_A}-turn-1`,
        itemId: "child-answer",
        delta: "Child ",
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: CHILD_A,
        turnId: `${CHILD_A}-turn-1`,
        itemId: "child-answer",
        delta: "answer",
      },
    },
    {
      method: "future/notification",
      params: { threadId: CHILD_A, future: { retained: [1, 2, 3] } },
    },
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

const scriptPath = NodePath.join(NodeOS.tmpdir(), `t3-collab-script-${process.pid}.json`);
const peerPath = Effect.map(HostProcessPlatform, (platform) =>
  NodePath.join(
    import.meta.dirname,
    `../testFixtures/codexCollabMockPeer.${platform === "win32" ? "cmd" : "sh"}`,
  ),
);

describe("CodexSessionRuntime collab integration", () => {
  it.effect("records standard, fast, inherited fast and restored standard by native turn", () =>
    Effect.gen(function* () {
      const turnIds = ["standard-1", "fast-1", "fast-2", "standard-2"];
      const observedTiers: Array<{ sessionId: string; turnId: string; serviceTier: string }> = [];
      NodeFS.writeFileSync(
        scriptPath,
        encodeScript({ rootThreadId: ROOT, turnIds, notifications: [] }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("automatic-speed-tracking"),
        serviceTier: "default",
        onTurnServiceTier: (observation) =>
          Effect.sync(() => {
            observedTiers.push(observation);
          }),
        binaryPath: yield* peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "approval-required",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      yield* runtime.start();
      for (const serviceTier of [undefined, "fast", undefined, "default"]) {
        const completed = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "turn/completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.sendTurn({ input: "Check speed", serviceTier });
        yield* Fiber.join(completed);
      }
      assert.deepEqual(
        observedTiers,
        ["default", "priority", "priority", "default"].map((serviceTier, index) => ({
          sessionId: ROOT,
          turnId: turnIds[index],
          serviceTier,
        })),
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "correlates null-reason file approvals only with the matching provider thread, turn, and item",
    () =>
      Effect.gen(function* () {
        const requests = [
          { threadId: CHILD_A, turnId: "approval-turn", itemId: "patch-item" },
          { threadId: ROOT, turnId: "another-turn", itemId: "patch-item" },
          { threadId: ROOT, turnId: "approval-turn", itemId: "another-item" },
          { threadId: ROOT, turnId: "approval-turn", itemId: "patch-item" },
        ];
        NodeFS.writeFileSync(
          scriptPath,
          encodeScript({
            rootThreadId: ROOT,
            holdTurnOpen: true,
            notifications: [
              {
                method: "item/started",
                params: {
                  threadId: ROOT,
                  turnId: "approval-turn",
                  startedAtMs: 1,
                  item: {
                    type: "fileChange",
                    id: "patch-item",
                    status: "inProgress",
                    changes: [
                      {
                        path: "A:\\project\\arithmetic.mjs",
                        kind: { type: "add" },
                        diff: "export const add = (a, b) => a + b;",
                      },
                      {
                        path: "A:\\project\\old.mjs",
                        kind: { type: "update", move_path: "A:\\project\\new.mjs" },
                        diff: "-old\n+new",
                      },
                    ],
                  },
                },
              },
              ...requests.map((request, index) => ({
                id: `approval-${index}`,
                method: "item/fileChange/requestApproval",
                params: { ...request, reason: null, grantRoot: null, startedAtMs: 2 },
              })),
            ],
          }),
          "utf8",
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("approval-context-test"),
          binaryPath: yield* peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "approval-required",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const events = yield* runtime.events.pipe(
          Stream.filter((event) => event.kind === "request"),
          Stream.tap((event) =>
            event.requestId ? runtime.respondToRequest(event.requestId, "decline") : Effect.void,
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "propose changes" });
        const approvals = Array.from(yield* Fiber.join(events));
        const matching = approvals.find((event) => {
          const payload = event.payload as { threadId: string; turnId: string; itemId: string };
          return (
            payload.threadId === ROOT &&
            payload.turnId === "approval-turn" &&
            payload.itemId === "patch-item"
          );
        });
        assert.include(matching?.message ?? "", "ADD A:\\project\\arithmetic.mjs");
        assert.include(matching?.message ?? "", "export const add = (a, b) => a + b;");
        assert.include(
          matching?.message ?? "",
          "UPDATE A:\\project\\old.mjs -> A:\\project\\new.mjs",
        );
        assert.include(matching?.message ?? "", "-old\n+new");
        assert.deepEqual(matching?.payload, {
          ...requests[3],
          reason: null,
          grantRoot: null,
          startedAtMs: 2,
        });
        for (const approval of approvals.filter((event) => event !== matching)) {
          assert.notInclude(approval.message ?? "", "arithmetic.mjs");
          assert.include(approval.message ?? "", "unavailable");
        }
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "steers the existing turn without applying turn overrides or starting a replacement",
    () =>
      Effect.gen(function* () {
        const turnId = "existing-provider-turn";
        const observedTiers: Array<{ sessionId: string; turnId: string; serviceTier: string }> = [];
        NodeFS.writeFileSync(
          scriptPath,
          encodeScript({
            rootThreadId: ROOT,
            holdTurnOpen: true,
            expectedActiveTurnId: turnId,
            turnIds: [turnId],
            notifications: [],
          }),
          "utf8",
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("steer-thread"),
          onTurnServiceTier: (observation) =>
            Effect.sync(() => {
              observedTiers.push(observation);
            }),
          binaryPath: yield* peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "full-access",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const wire = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.method === "codex/rawNotification" &&
              (event.payload as { method?: string }).method === "probe/steer",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "start work", serviceTier: "priority" });
        const result = yield* runtime.sendTurn({
          expectedTurnId: TurnId.make(turnId),
          input: "focus on tests",
          model: "ignored-model",
          serviceTier: "default",
          interactionMode: "plan",
          computerControlMode: "desktop",
        });
        assert.equal(result.turnId, turnId);
        assert.deepEqual(observedTiers, [{ sessionId: ROOT, turnId, serviceTier: "priority" }]);
        assert.deepEqual(result.resumeCursor, { threadId: ROOT });
        const captured = Array.from(yield* Fiber.join(wire))[0]?.payload as { params?: unknown };
        assert.deepEqual(captured.params, {
          threadId: ROOT,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "focus on tests" }],
        });
        const error = yield* runtime
          .sendTurn({ expectedTurnId: TurnId.make("stale-turn"), input: "must fail" })
          .pipe(Effect.flip);
        assert.include(error.message, "active turn mismatch");
        assert.equal((yield* runtime.getSession).activeTurnId, turnId);
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const mode of ["preview", "chrome", "desktop"] as const) {
    it.effect(`requires explicit permissions and MCP decisions in ${mode} mode`, () =>
      Effect.gen(function* () {
        const permissions = { network: { enabled: true } };
        const script = {
          rootThreadId: ROOT,
          holdTurnOpen: true,
          notifications: [
            {
              id: "permission-request",
              method: "item/permissions/requestApproval",
              params: {
                cwd: NodeOS.tmpdir(),
                itemId: "permission-item",
                permissions,
                startedAtMs: 1,
                threadId: ROOT,
                turnId: "turn-approval",
              },
            },
            {
              id: "mcp-request",
              method: "mcpServer/elicitation/request",
              params: {
                _meta: { codex_approval_kind: "mcp_tool_call" },
                mode: "form",
                message: "Allow this tool?",
                requestedSchema: { type: "object", properties: {} },
                serverName: "sample-tool",
                threadId: ROOT,
                turnId: "turn-approval",
              },
            },
          ],
        };
        NodeFS.writeFileSync(scriptPath, encodeScript(script), "utf8");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make(`thread-approval-${mode}`),
          binaryPath: yield* peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "full-access",
          computerControlMode: mode,
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const approvals: Array<string> = [];
        const replies: Array<unknown> = [];
        const events = yield* runtime.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event.kind === "request" && event.requestId) {
                approvals.push(event.method);
                yield* runtime.respondToRequest(
                  event.requestId,
                  event.method === "item/permissions/requestApproval" ? "decline" : "accept",
                );
              }
              const raw = event.payload as { method?: string; params?: unknown } | undefined;
              if (event.method === "codex/rawNotification" && raw?.method === "probe/response")
                replies.push(raw.params);
            }),
          ),
          Stream.takeUntil(() => replies.length === 2),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "request approvals" });
        yield* Fiber.join(events);
        assert.sameMembers(approvals, [
          "item/permissions/requestApproval",
          "mcpServer/elicitation/request",
        ]);
        assert.deepInclude(replies, {
          id: "permission-request",
          result: { permissions: {}, scope: "turn" },
        });
        assert.deepInclude(replies, { id: "mcp-request", result: { action: "accept" } });
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: yield* peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");
      const original = events.find(
        (event) =>
          event.method === "codex/rawNotification" &&
          (event.payload as { method?: string }).method === "future/notification",
      );
      assert.deepEqual(original?.payload, {
        jsonrpc: "2.0",
        method: "future/notification",
        params: { threadId: CHILD_A, future: { retained: [1, 2, 3] } },
      });
      const childDelta = events.find(
        (event) =>
          event.method === "collabAgent/notification" &&
          (event.payload as { wire?: { method: string } }).wire?.method ===
            "item/agentMessage/delta",
      );
      assert.isDefined(childDelta, "child deltas remain available as agent events");
      assert.isTrue(
        events.some(
          (event) =>
            event.method === "collabAgent/notification" &&
            (event.payload as { summary?: string }).summary === "Child answer",
        ),
        "child display text accumulates deltas",
      );

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const memoryThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: MEMORY,
            sessionId: MEMORY,
            source: "unknown",
            threadSource: "memory_consolidation",
          },
        },
      };
      const memoryTurnStarted = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: MEMORY,
          turn: { ...turnStartedA.params.turn, id: "memory-consolidation-turn" },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [
          turnStartedA,
          registrationA,
          memoryThreadStarted,
          memoryTurnStarted,
          registrationB,
          turnStartedB,
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: yield* peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(
        interruptedThreads.has(MEMORY),
        "memory consolidation must be interrupted without appearing in chat",
      );
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: yield* peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
