// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { ServerConfig } from "../../config.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexAdapter } from "./CodexAdapter.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const coordinators = ["alpha", "bravo"].map((name) => ({
  threadId: ThreadId.make(`coordinator-${name}`),
  providerThreadId: `provider-${name}`,
  observedTurnId: `provider-${name}-observed`,
  actualTurnId: `provider-${name}-actual`,
  children: [1, 2, 3].map((index) => `provider-${name}-child-${index}`),
}));
const settings = Schema.decodeSync(CodexSettings)({});
const encodeScript = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInterrupt = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      turnId: Schema.String,
    }),
  ),
);

function turn(id: string, status = "inProgress") {
  return { ...fixture.responses.turnStart.turn, id, status };
}

function delta(threadId: string, turnId: string, text: string) {
  return {
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: `${threadId}-message`, delta: text },
  };
}

/** Each peer sees the same daemon broadcast, including the other parent's fleet. */
function broadcast() {
  const notifications: Array<{ method: string; params: unknown }> = [];
  for (const parent of coordinators) {
    notifications.push({
      method: "turn/started",
      params: { threadId: parent.providerThreadId, turn: turn(parent.observedTurnId) },
    });
  }
  // Early traffic must not acquire ownership merely because it arrives first.
  for (const parent of coordinators) {
    for (const child of parent.children) {
      notifications.push(delta(child, `${child}-early-turn`, `UNREGISTERED:${child}`));
    }
  }
  for (let index = 0; index < 3; index++) {
    for (const parent of coordinators) {
      const child = parent.children[index]!;
      const agentPath = `/root/${child}`;
      // Exercise both native registration paths, with opposite ordering.
      const started = {
        method: "thread/started",
        params: {
          thread: {
            ...fixture.responses.threadStart.thread,
            id: child,
            parentThreadId: parent.providerThreadId,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: parent.providerThreadId,
                  depth: 1,
                  agent_path: agentPath,
                  agent_nickname: child,
                  agent_role: "reviewer",
                },
              },
            },
          },
        },
      };
      const activity = {
        method: "item/completed",
        params: {
          threadId: parent.providerThreadId,
          turnId: parent.observedTurnId,
          item: {
            type: "subAgentActivity",
            id: `${child}-spawn`,
            kind: "started",
            agentThreadId: child,
            agentPath,
          },
        },
      };
      notifications.push(...(index % 2 ? [activity, started] : [started, activity]));
      notifications.push(
        {
          method: "turn/started",
          params: { threadId: child, turn: turn(`${child}-turn`) },
        },
        delta(child, `${child}-turn`, `RESULT:${child}`),
        {
          method: "thread/settings/updated",
          params: {
            threadId: child,
            threadSettings: {
              model: "gpt-5.6-sol",
              effort: "high",
              modelProvider: "openai",
              cwd: "/tmp",
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandboxPolicy: { type: "dangerFullAccess" },
              collaborationMode: {
                mode: "default",
                settings: {
                  model: "gpt-5.6-sol",
                  reasoning_effort: "high",
                  developer_instructions: null,
                },
              },
            },
          },
        },
        {
          method: "turn/diff/updated",
          params: { threadId: child, turnId: `${child}-turn`, diff: `DIFF:${child}` },
        },
        {
          method: "error",
          params: {
            threadId: child,
            turnId: `${child}-turn`,
            error: { message: `CHILD-ERROR:${child}`, codexErrorInfo: null },
            willRetry: true,
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: child,
            turn: {
              ...turn(`${child}-turn`, "completed"),
              items: [{ type: "agentMessage", id: `${child}-answer`, text: `RESULT:${child}` }],
            },
          },
        },
      );
    }
  }
  notifications.push(
    { method: "turn/started", params: { threadId: "foreign-chat", turn: turn("foreign-turn") } },
    delta("foreign-chat", "foreign-turn", "FOREIGN-CONTENT"),
    {
      method: "error",
      params: {
        threadId: "foreign-chat",
        turnId: "foreign-turn",
        error: { message: "FOREIGN-ERROR", codexErrorInfo: null },
        willRetry: false,
      },
    },
    {
      method: "turn/completed",
      params: { threadId: "foreign-chat", turn: turn("foreign-turn", "completed") },
    },
  );
  for (const parent of coordinators) {
    const child = parent.children[2]!;
    notifications.push({
      method: "turn/started",
      params: { threadId: child, turn: turn(`${child}-resumed-turn`) },
    });
    notifications.push(
      delta(parent.providerThreadId, parent.observedTurnId, `DRAIN:${parent.threadId}`),
    );
  }
  return notifications;
}

const directoryLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () => Effect.die("Unexpected provider lookup"),
  getBinding: () => Effect.succeed(Option.none()),
  recordImportedTranscript: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

it.effect("isolates two concurrent fleets and steers each provider's actual parent turn", () =>
  Effect.gen(function* () {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-concurrent-steer-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(scratch, { recursive: true, force: true })),
    );
    const platform = yield* HostProcessPlatform;
    const peer = NodePath.join(
      import.meta.dirname,
      `../testFixtures/codexCollabMockPeer.${platform === "win32" ? "cmd" : "sh"}`,
    );
    for (const parent of coordinators) {
      NodeFS.writeFileSync(
        NodePath.join(scratch, `${parent.threadId}.json`),
        encodeScript({
          rootThreadId: parent.providerThreadId,
          turnIds: [parent.observedTurnId],
          holdTurnOpen: true,
          expectedActiveTurnId: parent.actualTurnId,
          // The provider advances after the initial turn was observed. A
          // later steer must resolve this transition, not trust that cache.
          threadReadResponses: [
            {
              thread: {
                id: parent.providerThreadId,
                turns: [{ id: parent.observedTurnId, status: "inProgress" }],
              },
            },
          ],
          notifications: broadcast(),
        }),
      );
    }
    const probes = yield* Deferred.make<void>();
    const wireProbes: Array<ProviderEvent> = [];
    const crypto = yield* Crypto.Crypto;
    const adapter = yield* makeCodexAdapter(settings, {
      makeRuntime: (options) =>
        makeCodexSessionRuntime({
          ...options,
          binaryPath: peer,
          appServerTransport: "stdio",
          homePath: NodePath.join(scratch, options.threadId),
          environment: {
            ...process.env,
            T3_CODEX_COLLAB_SCRIPT: NodePath.join(scratch, `${options.threadId}.json`),
          },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((runtime) => ({
            ...runtime,
            events: runtime.events.pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (event.method !== "codex/rawNotification") return;
                  const payload = event.payload as { method?: string };
                  if (payload.method !== "probe/steer") return;
                  wireProbes.push(event);
                  if (wireProbes.length === coordinators.length)
                    yield* Deferred.succeed(probes, undefined);
                }),
              ),
            ),
          })),
        ),
    });
    const drained = yield* Deferred.make<void>();
    const seenDrains = new Set<ThreadId>();
    const events: Array<ProviderRuntimeEvent> = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "content.delta" && event.payload.delta === `DRAIN:${event.threadId}`) {
            seenDrains.add(event.threadId);
            if (seenDrains.size === coordinators.length)
              yield* Deferred.succeed(drained, undefined);
          }
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.forEach(
      coordinators,
      (parent) =>
        adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: parent.threadId,
          runtimeMode: "full-access",
          cwd: scratch,
        }),
      { concurrency: "unbounded" },
    );
    yield* Effect.forEach(
      coordinators,
      (parent) =>
        adapter.sendTurn({
          threadId: parent.threadId,
          input: "Start three fresh reviewers",
          attachments: [],
        }),
      { concurrency: "unbounded" },
    );
    yield* Deferred.await(drained);

    const sessions = yield* adapter.listSessions();
    for (const parent of coordinators) {
      const session = sessions.find((candidate) => candidate.threadId === parent.threadId);
      assert.equal(session?.activeTurnId, parent.observedTurnId);
      assert.equal(session?.status, "running");
      assert.equal(session?.lastError, undefined);
      assert.deepEqual(session?.resumeCursor, { threadId: parent.providerThreadId });
      const own = events.filter((event) => event.threadId === parent.threadId);
      assert.deepEqual(
        [...new Set(own.flatMap((event) => (event.turnId ? [event.turnId] : [])))],
        [parent.observedTurnId],
      );
      const taskEvents = own.filter((event) => event.type.startsWith("task."));
      assert.isAbove(taskEvents.length, 3);
      assert.deepEqual(
        [...new Set(taskEvents.map((event) => event.turnId))],
        [parent.observedTurnId],
      );
      const activities = new Map(
        own.flatMap((event) => runtimeEventToActivities(event)).map((row) => [row.id, row]),
      );
      const fleet = foldSubagentActivities([...activities.values()]);
      assert.deepEqual(fleet.map((agent) => agent.id).sort(), [...parent.children].sort());
      for (const agent of fleet) {
        assert.equal(agent.parentAgentId, parent.providerThreadId);
        assert.include(agent.progress ?? "", `RESULT:${agent.id}`);
        assert.equal(agent.status, agent.id === parent.children[2] ? "running" : "idle");
        assert.equal(agent.model, "gpt-5.6-sol");
        assert.equal(agent.effort, "high");
      }
      // Only parent-addressed content can reach the normal parent timeline.
      assert.deepEqual(
        own.filter((event) => event.type === "content.delta").map((event) => event.payload.delta),
        [`DRAIN:${parent.threadId}`],
      );
      assert.isFalse(
        own.some((event) => event.type === "runtime.error" || event.type === "turn.completed"),
      );
    }

    const results = yield* Effect.forEach(
      coordinators,
      (parent) =>
        adapter.sendTurn({
          threadId: parent.threadId,
          expectedTurnId: TurnId.make(`${parent.children[0]}-turn`),
          input: `STEER:${parent.threadId}`,
          attachments: [],
        }),
      { concurrency: "unbounded" },
    );
    // Both caller and session metadata are stale. The provider read is the authority.
    assert.deepEqual(
      results.map((result) => result.turnId),
      coordinators.map((parent) => parent.actualTurnId),
    );
    assert.deepEqual(
      results.map((result) => result.resumeCursor),
      coordinators.map((parent) => ({ threadId: parent.providerThreadId })),
    );
    yield* Deferred.await(probes);
    for (const parent of coordinators) {
      const probe = wireProbes.find((event) => event.threadId === parent.threadId);
      assert.isDefined(probe);
      assert.deepEqual((probe!.payload as { params?: unknown }).params, {
        threadId: parent.providerThreadId,
        expectedTurnId: parent.actualTurnId,
        input: [{ type: "text", text: `STEER:${parent.threadId}` }],
      });
    }
    const parent = coordinators[0]!;
    yield* adapter.interruptTurn(parent.threadId, TurnId.make(parent.actualTurnId));
    const interrupted = NodeFS.readFileSync(
      NodePath.join(scratch, `${parent.threadId}.json.interrupts`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => decodeInterrupt(line));
    assert.deepEqual(interrupted, [
      { threadId: parent.children[2], turnId: `${parent.children[2]}-resumed-turn` },
      { threadId: parent.providerThreadId, turnId: parent.actualTurnId },
    ]);
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(scratch, `${coordinators[1]!.threadId}.json.interrupts`)),
    );
    yield* adapter.stopAll();
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(NodeOS.tmpdir(), NodeOS.tmpdir()),
        ServerSettingsService.layerTest(),
        directoryLayer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
