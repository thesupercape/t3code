// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DatabaseSync } from "node:sqlite";

import * as CodexDesktopStore from "./CodexDesktopStore.ts";

const threadId = "019e487f-4854-7902-8efb-61feec0364bf";

const makeFixture = (): string => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-desktop-"));
  const state = new DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER, updated_at_ms INTEGER,
      preview TEXT, cwd TEXT, archived INTEGER, rollout_path TEXT, history_mode TEXT
    );
    INSERT INTO threads VALUES ('${threadId}', 'Native fixture', 1, 1000, 'latest', 'A:/Dev', 0, '', 'paginated');
  `);
  state.close();
  const history = new DatabaseSync(NodePath.join(home, "thread_history_1.sqlite"));
  history.exec(`
    CREATE TABLE thread_items (
      thread_id TEXT, item_id TEXT, item_type TEXT, item_json TEXT,
      created_at_ms INTEGER, rollout_ordinal INTEGER
    );
    INSERT INTO thread_items VALUES
      ('${threadId}', 'm1', 'reasoning', '{"type":"reasoning","id":"r1","summary":[]}', 1000, 1),
      ('${threadId}', 'm2', 'userMessage', '{"type":"userMessage","id":"m2","content":[{"type":"text","text":"hello"}]}', 1100, 2),
      ('${threadId}', 'm3', 'agentMessage', '{"type":"agentMessage","id":"m3","text":"world"}', 1200, 3),
      ('${threadId}', 'm4', 'commandExecution', '{"type":"commandExecution","id":"m4","command":"dir","status":"completed"}', 1300, 4),
      ('${threadId}', 'm5', 'functionCallOutput', '{"type":"functionCallOutput","id":"m5","name":"send_message_to_thread","output":"done"}', 1400, 5);
  `);
  history.close();
  return home;
};

const makeLargeLegacyFixture = (): { readonly home: string; readonly threadId: string } => {
  const legacyThreadId = "019e487f-4854-7902-8efb-61feec0364c0";
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-legacy-"));
  const rollout = NodePath.join(home, "sessions", `${legacyThreadId}.jsonl`);
  NodeFS.mkdirSync(NodePath.dirname(rollout), { recursive: true });
  const event = (type: string, text: string) =>
    `${JSON.stringify({ type, payload: type === "event_msg" ? { type: "user_message", message: text } : { type: "message", role: "assistant", content: [{ text }] } })}\n`;
  NodeFS.writeFileSync(
    rollout,
    event("event_msg", "old marker") +
      event("response_item", "x".repeat(160)).repeat(70_000) +
      event("response_item", "new marker"),
  );
  const state = new DatabaseSync(NodePath.join(home, "state_1.sqlite"));
  state.exec(
    `CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,updated_at INTEGER,updated_at_ms INTEGER,preview TEXT,cwd TEXT,archived INTEGER,rollout_path TEXT,history_mode TEXT);`,
  );
  state
    .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)")
    .run(legacyThreadId, "Large legacy", 1, 1000, "new marker", "A:/Dev", 0, rollout, "legacy");
  state.close();
  return { home, threadId: legacyThreadId };
};

const testLayer = (home: string) =>
  CodexDesktopStore.layerWithHomePath(home).pipe(Layer.provide(NodeServices.layer));

it.effect("reads native paginated history without exposing reasoning", () => {
  const home = makeFixture();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    const list = yield* store.listThreads({ limit: 1 });
    expect(list.threads).toHaveLength(1);
    const history = yield* store.readThread(threadId, { limit: 3 });
    expect(history.messages.map((message) => message.text)).toEqual(["world", "dir", "done"]);
    expect(history.messages[2]?.tool?.name).toBe("send_message_to_thread");
    const older = yield* store.readThread(threadId, {
      ...(history.nextCursor === null ? {} : { beforeCursor: history.nextCursor }),
      limit: 1,
    });
    expect(older.messages.map((message) => message.text)).toEqual(["hello"]);
  }).pipe(
    Effect.provide(testLayer(home)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
  );
});

it.effect("pages a large legacy rollout from a bounded byte cursor", () => {
  const fixture = makeLargeLegacyFixture();
  return Effect.gen(function* () {
    const store = yield* CodexDesktopStore.CodexDesktopStore;
    const newest = yield* store.readThread(fixture.threadId, { limit: 1 });
    expect(newest.messages[0]?.text).toBe("new marker");
    expect(newest.nextCursor).toMatch(/^byte:/);
    const older = yield* store.readThread(fixture.threadId, {
      ...(newest.nextCursor === null ? {} : { beforeCursor: newest.nextCursor }),
      limit: 1,
    });
    expect(older.messages[0]?.text).toBe("x".repeat(160));
  }).pipe(
    Effect.provide(testLayer(fixture.home)),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(fixture.home, { recursive: true, force: true })),
    ),
  );
});
