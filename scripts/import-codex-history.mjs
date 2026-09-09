import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";

const PROJECTORS = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
];

function readArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function stableId(namespace, value) {
  const hex = NodeCrypto.createHash("sha256")
    .update(`${namespace}\0${value}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function iso(value, fallback) {
  const date = new Date(value ?? fallback);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function listSessionFiles(codexHome) {
  const byId = new Map();
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = NodePath.join(codexHome, directoryName);
    if (!NodeFS.existsSync(root)) continue;
    for (const entry of NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const match = entry.name.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
      );
      if (!match) continue;
      byId.set(match[1].toLowerCase(), NodePath.join(entry.parentPath, entry.name));
    }
  }
  return byId;
}

function readIndex(codexHome) {
  const rows = [];
  const seen = new Set();
  const text = NodeFS.readFileSync(NodePath.join(codexHome, "session_index.jsonl"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row.id !== "string" || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({
      id: row.id.toLowerCase(),
      title:
        typeof row.thread_name === "string" && row.thread_name.trim()
          ? row.thread_name.trim()
          : "Imported Codex chat",
      updatedAt: iso(row.updated_at, new Date(0).toISOString()),
    });
  }
  return rows;
}

async function readSession(file, indexRow) {
  let cwd = null;
  let createdAt = null;
  let currentTurnId = null;
  let lastModel = null;
  const messages = [];
  const turns = new Map();
  const input = NodeReadline.createInterface({
    input: NodeFS.createReadStream(file),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;

  for await (const line of input) {
    lineNumber += 1;
    if (!line.includes('"session_meta"') && !line.includes('"event_msg"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === "session_meta") {
      cwd = typeof record.payload?.cwd === "string" ? record.payload.cwd : cwd;
      createdAt = iso(record.payload?.timestamp ?? record.timestamp, indexRow.updatedAt);
      continue;
    }
    if (record.type !== "event_msg") continue;

    if (record.payload?.type === "task_started") {
      currentTurnId =
        typeof record.payload.turn_id === "string" ? record.payload.turn_id : currentTurnId;
      if (typeof record.payload.model === "string") lastModel = record.payload.model;
      continue;
    }
    const isUser = record.payload?.type === "user_message";
    const isAssistant = record.payload?.type === "agent_message";
    if (!isUser && !isAssistant) continue;
    const text = typeof record.payload.message === "string" ? record.payload.message : "";
    if (!text.trim()) continue;
    const timestamp = iso(record.timestamp, indexRow.updatedAt);
    const ordinal = messages.length + 1;
    const message = {
      messageId: stableId("codex-message", `${indexRow.id}:${lineNumber}:${ordinal}`),
      role: isUser ? "user" : "assistant",
      text,
      turnId: currentTurnId,
      timestamp,
    };
    messages.push(message);
    if (currentTurnId) {
      const turn = turns.get(currentTurnId) ?? {
        turnId: currentTurnId,
        requestedAt: timestamp,
        completedAt: timestamp,
        pendingMessageId: null,
        assistantMessageId: null,
      };
      turn.completedAt = timestamp;
      if (isUser && turn.pendingMessageId === null) turn.pendingMessageId = message.messageId;
      if (isAssistant) turn.assistantMessageId = message.messageId;
      turns.set(currentTurnId, turn);
    }
  }

  return {
    cwd: cwd ?? "A:\\Dev",
    createdAt: createdAt ?? indexRow.updatedAt,
    updatedAt: indexRow.updatedAt,
    model: lastModel,
    messages,
    turns: [...turns.values()],
  };
}

function makeStatements(db) {
  return {
    insertEvent: db.prepare(`
      INSERT OR IGNORE INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, '{}')
    `),
    upsertProject: db.prepare(`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, default_thread_env_mode,
        favicon_path, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL, '[]', ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        title=excluded.title, workspace_root=excluded.workspace_root, updated_at=excluded.updated_at
    `),
    upsertThread: db.prepare(`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
        settled_override, settled_at, snoozed_until, snoozed_at, pinned_at, pin_order_key,
        title_regeneration_request_id, title_regeneration_started_at, latest_user_message_at,
        pending_approval_count, pending_user_input_count, has_actionable_proposed_plan, deleted_at
      ) VALUES (?, ?, ?, ?, 'full-access', 'default', NULL, NULL, ?, ?, ?, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, 0, NULL)
      ON CONFLICT(thread_id) DO UPDATE SET
        project_id=excluded.project_id, title=excluded.title, model_selection_json=excluded.model_selection_json,
        latest_turn_id=excluded.latest_turn_id, updated_at=excluded.updated_at,
        latest_user_message_at=excluded.latest_user_message_at
    `),
    upsertMessage: db.prepare(`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, attachments_json
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)
      ON CONFLICT(message_id) DO UPDATE SET
        turn_id=excluded.turn_id, role=excluded.role, text=excluded.text,
        is_streaming=0, updated_at=excluded.updated_at
    `),
    upsertTurn: db.prepare(`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
        started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json, source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, NULL, NULL, NULL, '[]', NULL, NULL)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET
        pending_message_id=excluded.pending_message_id, assistant_message_id=excluded.assistant_message_id,
        state='completed', requested_at=excluded.requested_at, started_at=excluded.started_at,
        completed_at=excluded.completed_at
    `),
    upsertSession: db.prepare(`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_session_id, provider_thread_id, active_turn_id,
        last_error, updated_at, runtime_mode, provider_instance_id
      ) VALUES (?, 'stopped', 'codex', NULL, ?, NULL, NULL, ?, 'full-access', 'codex')
      ON CONFLICT(thread_id) DO UPDATE SET
        status='stopped', provider_name='codex', provider_thread_id=excluded.provider_thread_id,
        active_turn_id=NULL, last_error=NULL, updated_at=excluded.updated_at,
        runtime_mode='full-access', provider_instance_id='codex'
    `),
    upsertRuntime: db.prepare(`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES (?, 'codex', 'codex', 'codex', 'full-access', 'stopped', ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        provider_name='codex', provider_instance_id='codex', adapter_key='codex',
        runtime_mode='full-access', status='stopped', last_seen_at=excluded.last_seen_at,
        resume_cursor_json=excluded.resume_cursor_json, runtime_payload_json=excluded.runtime_payload_json
    `),
    upsertProjectionState: db.prepare(`
      INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(projector) DO UPDATE SET
        last_applied_sequence=excluded.last_applied_sequence, updated_at=excluded.updated_at
    `),
  };
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const args = readArguments(process.argv.slice(2));
if (!args["codex-home"] || !args.db) {
  throw new Error(
    "Usage: node import-codex-history.mjs --codex-home <path> --db <state.sqlite> [--limit N]",
  );
}
const limit = args.limit ? Number.parseInt(args.limit, 10) : Number.POSITIVE_INFINITY;
const fallbackModel = args.model || "gpt-5.6-luna";
const sessionFiles = listSessionFiles(args["codex-home"]);
const indexRows = readIndex(args["codex-home"]).slice(0, limit);
const db = new NodeSqlite.DatabaseSync(args.db);
db.exec(
  "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000;",
);
const sql = makeStatements(db);
const projects = new Map();
let importedThreads = 0;
let importedMessages = 0;
let missingSessions = 0;

for (const [position, indexRow] of indexRows.entries()) {
  const file = sessionFiles.get(indexRow.id);
  if (!file) {
    missingSessions += 1;
    continue;
  }
  const session = await readSession(file, indexRow);
  const workspaceRoot = session.cwd;
  const projectKey = workspaceRoot.toLowerCase();
  const projectId = stableId("codex-project", projectKey);
  const projectTitle = NodePath.basename(workspaceRoot.replace(/[\\/]+$/, "")) || workspaceRoot;
  const modelSelection = { instanceId: "codex", model: session.model ?? fallbackModel };
  const latestTurnId = session.turns.at(-1)?.turnId ?? null;
  const latestUserMessageAt =
    session.messages.findLast((message) => message.role === "user")?.timestamp ?? null;
  const project = projects.get(projectKey) ?? {
    projectId,
    title: projectTitle,
    workspaceRoot,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  if (session.createdAt < project.createdAt) project.createdAt = session.createdAt;
  if (session.updatedAt > project.updatedAt) project.updatedAt = session.updatedAt;
  projects.set(projectKey, project);

  transaction(db, () => {
    sql.insertEvent.run(
      `codex-import-thread-${indexRow.id}`,
      "thread",
      indexRow.id,
      1,
      "thread.created",
      session.createdAt,
      "server",
      JSON.stringify({
        threadId: indexRow.id,
        projectId,
        title: indexRow.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }),
    );
    sql.upsertThread.run(
      indexRow.id,
      projectId,
      indexRow.title,
      JSON.stringify(modelSelection),
      latestTurnId,
      session.createdAt,
      session.updatedAt,
      latestUserMessageAt,
    );
    for (const [messageIndex, message] of session.messages.entries()) {
      const streamVersion = messageIndex + 2;
      sql.insertEvent.run(
        `codex-import-message-${message.messageId}`,
        "thread",
        indexRow.id,
        streamVersion,
        "thread.message-sent",
        message.timestamp,
        "provider",
        JSON.stringify({
          threadId: indexRow.id,
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          turnId: message.turnId,
          streaming: false,
          createdAt: message.timestamp,
          updatedAt: message.timestamp,
        }),
      );
      sql.upsertMessage.run(
        message.messageId,
        indexRow.id,
        message.turnId,
        message.role,
        message.text,
        message.timestamp,
        message.timestamp,
      );
    }
    for (const turn of session.turns) {
      sql.upsertTurn.run(
        indexRow.id,
        turn.turnId,
        turn.pendingMessageId,
        turn.assistantMessageId,
        turn.requestedAt,
        turn.requestedAt,
        turn.completedAt,
      );
    }
    sql.upsertSession.run(indexRow.id, indexRow.id, session.updatedAt);
    sql.upsertRuntime.run(
      indexRow.id,
      session.updatedAt,
      JSON.stringify({ threadId: indexRow.id }),
      JSON.stringify({ cwd: workspaceRoot }),
    );
  });
  importedThreads += 1;
  importedMessages += session.messages.length;
  if ((position + 1) % 100 === 0) {
    console.log(`Imported ${position + 1}/${indexRows.length} indexed chats...`);
  }
}

transaction(db, () => {
  for (const project of projects.values()) {
    sql.insertEvent.run(
      `codex-import-project-${project.projectId}`,
      "project",
      project.projectId,
      1,
      "project.created",
      project.createdAt,
      "server",
      JSON.stringify({
        ...project,
        defaultModelSelection: null,
        scripts: [],
      }),
    );
    sql.upsertProject.run(
      project.projectId,
      project.title,
      project.workspaceRoot,
      project.createdAt,
      project.updatedAt,
    );
  }
  const maxSequence = db
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM orchestration_events")
    .get().value;
  const now = new Date().toISOString();
  for (const projector of PROJECTORS) sql.upsertProjectionState.run(projector, maxSequence, now);
});
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
db.close();

console.log(
  JSON.stringify(
    {
      indexedChats: indexRows.length,
      importedThreads,
      importedMessages,
      projects: projects.size,
      missingSessions,
    },
    null,
    2,
  ),
);
