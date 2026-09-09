// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics unsafeEffectTypeAssertion:off
/** Read-only access to the native Codex desktop history store. */
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs/promises";

import {
  type CodexDesktopMessage,
  type CodexDesktopThread,
  type CodexDesktopThreadHistoryResponse,
  type CodexDesktopThreadListResponse,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_LEGACY_ROLLOUT_BYTES = 8_000_000;

export class CodexDesktopStoreError extends Schema.TaggedError<CodexDesktopStoreError>()(
  "CodexDesktopStoreError",
  {
    operation: Schema.Literals(["open", "query", "decode", "path"]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Codex desktop history ${this.operation} failed: ${this.detail}`;
  }
}

export interface CodexDesktopStoreShape {
  readonly listThreads: (input?: {
    readonly cursor?: string;
    readonly search?: string;
    readonly limit?: number;
  }) => Effect.Effect<
    CodexDesktopThreadListResponse,
    CodexDesktopStoreError | PlatformError.PlatformError | ServerSettingsError
  >;
  readonly readThread: (
    threadId: string,
    input?: { readonly beforeCursor?: string; readonly limit?: number },
  ) => Effect.Effect<
    CodexDesktopThreadHistoryResponse,
    CodexDesktopStoreError | PlatformError.PlatformError | ServerSettingsError
  >;
}

export class CodexDesktopStore extends Context.Service<CodexDesktopStore, CodexDesktopStoreShape>()(
  "t3/provider/CodexDesktopStore",
) {}

type ThreadRow = {
  id: string;
  title: string | null;
  updated_at: number;
  updated_at_ms: number | null;
  preview: string | null;
  cwd: string | null;
  archived: number;
  rollout_path: string;
  history_mode: string;
};

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);

const toIso = (row: ThreadRow): string => {
  const ms = typeof row.updated_at_ms === "number" ? row.updated_at_ms : row.updated_at * 1000;
  return new Date(ms).toISOString();
};

const toThread = (row: ThreadRow): CodexDesktopThread => ({
  id: row.id,
  title: row.title,
  updatedAt: toIso(row),
  preview: row.preview,
  cwd: row.cwd,
  status: "unknown",
});

const pageValue = (value: string | undefined): number => {
  if (value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const pageSize = (value: number | undefined): number =>
  value === undefined || !Number.isSafeInteger(value)
    ? DEFAULT_PAGE_SIZE
    : Math.min(MAX_PAGE_SIZE, Math.max(1, value));

const rowToThread = (row: Record<string, unknown>): ThreadRow => ({
  id: String(row.id ?? ""),
  title: asText(row.title),
  updated_at: Number(row.updated_at ?? 0),
  updated_at_ms: typeof row.updated_at_ms === "number" ? row.updated_at_ms : null,
  preview: asText(row.preview),
  cwd: asText(row.cwd),
  archived: Number(row.archived ?? 0),
  rollout_path: String(row.rollout_path ?? ""),
  history_mode: String(row.history_mode ?? "legacy"),
});

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
};

const textFromNativeValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  const contentText = textFromContent(value);
  if (contentText.length > 0) return contentText;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const messageFromRecord = (value: unknown, index: number): CodexDesktopMessage | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = payload as Record<string, unknown>;
  const payloadType = data.type;
  let role: "user" | "assistant" | "tool" | undefined;
  let text = "";
  if (row.type === "event_msg" && payloadType === "user_message") {
    role = "user";
    text = textFromContent(data.message ?? data.text);
  } else if (row.type === "response_item" && payloadType === "message") {
    const candidate = data.role;
    role = candidate === "user" || candidate === "assistant" ? candidate : undefined;
    text = textFromContent(data.content);
  } else if (row.type === "response_item" && payloadType === "function_call") {
    role = "tool";
    text = textFromContent(data.name ?? data.arguments);
  }
  if (!role || text.length === 0) return undefined;
  const timestamp = asText(row.timestamp);
  return {
    id: `${index}`,
    role,
    text,
    createdAt: timestamp,
    tool: null,
  };
};

const messageFromNativeItem = (value: unknown, id: string): CodexDesktopMessage | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : "";
  const text =
    type === "userMessage" || type === "agentMessage"
      ? textFromNativeValue(row.text ?? row.content)
      : type === "functionCallOutput"
        ? textFromNativeValue(row.output)
        : type === "mcpToolCall"
          ? textFromNativeValue(row.result ?? row.output ?? row.error ?? row.arguments ?? row.name)
          : typeof row.text === "string"
            ? row.text
            : typeof row.command === "string"
              ? row.command
              : typeof row.aggregatedOutput === "string"
                ? row.aggregatedOutput
                : "";
  const role =
    type === "userMessage"
      ? "user"
      : type === "agentMessage"
        ? "assistant"
        : type === "commandExecution" ||
            type === "functionCallOutput" ||
            type === "mcpToolCall" ||
            type === "fileChange"
          ? "tool"
          : undefined;
  if (!role || text.trim().length === 0) return undefined;
  const createdAt = asText(row.createdAt) ?? asText(row.timestamp);
  const toolName =
    type === "functionCallOutput"
      ? asText(row.name)
      : type === "mcpToolCall"
        ? [asText(row.server), asText(row.tool)]
            .filter((part): part is string => part !== null)
            .join("/")
        : type === "commandExecution"
          ? "command"
          : type === "fileChange"
            ? "file change"
            : null;
  const rawStatus = asText(row.status);
  const tool =
    role === "tool" && toolName !== null
      ? {
          name: toolName,
          status:
            rawStatus === "error" || rawStatus === "failed"
              ? ("error" as const)
              : rawStatus === "running" || rawStatus === "in_progress"
                ? ("running" as const)
                : ("completed" as const),
          detail: null,
        }
      : null;
  return { id, role, text, createdAt, tool };
};

const messageFromItem = (itemJson: string, id: string): CodexDesktopMessage | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(itemJson);
  } catch {
    return undefined;
  }
  const nativeMessage = messageFromNativeItem(value, id);
  if (nativeMessage) return nativeMessage;
  const message = messageFromRecord(value, 0);
  return message ? { ...message, id } : undefined;
};

export const make = (options?: { readonly homePath?: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsService =
      options?.homePath === undefined ? yield* ServerSettings.ServerSettingsService : undefined;

    const desktopHome = Effect.fn("CodexDesktopStore.desktopHome")(function* () {
      if (options?.homePath !== undefined) return options.homePath;
      const settings = yield* settingsService!.getSettings;
      const layout = yield* resolveCodexHomeLayout(settings.providers.codex);
      return layout.sharedHomePath;
    });

    const stateDatabase = Effect.fn("CodexDesktopStore.stateDatabase")(function* (home: string) {
      const names = yield* fileSystem.readDirectory(home).pipe(
        Effect.mapError(
          (cause) =>
            new CodexDesktopStoreError({
              operation: "open",
              detail: `could not inspect '${home}'`,
              cause,
            }),
        ),
      );
      const candidates = names.filter((name) => /^state_\d+\.sqlite$/i.test(name));
      if (candidates.length === 0) {
        return yield* new CodexDesktopStoreError({
          operation: "open",
          detail: `no native Codex state database exists under '${home}'`,
        });
      }
      const withMtime = yield* Effect.forEach(candidates, (name) =>
        fileSystem
          .stat(path.join(home, name))
          .pipe(Effect.map((info) => ({ name, mtime: Number(info.mtime) }))),
      );
      return path.join(
        home,
        [...withMtime].sort((left, right) => right.mtime - left.mtime)[0]!.name,
      );
    });

    const historyDatabase = Effect.fn("CodexDesktopStore.historyDatabase")(function* (
      home: string,
    ) {
      const names = yield* fileSystem.readDirectory(home).pipe(
        Effect.mapError(
          (cause) =>
            new CodexDesktopStoreError({
              operation: "open",
              detail: `could not inspect '${home}' for native history`,
              cause,
            }),
        ),
      );
      const candidates = names.filter((name) => /^thread_history_\d+\.sqlite$/i.test(name));
      if (candidates.length === 0) {
        return yield* new CodexDesktopStoreError({
          operation: "open",
          detail: `no native Codex history database exists under '${home}'`,
        });
      }
      const withMtime = yield* Effect.forEach(candidates, (name) =>
        fileSystem
          .stat(path.join(home, name))
          .pipe(Effect.map((info) => ({ name, mtime: Number(info.mtime) }))),
      );
      return path.join(
        home,
        [...withMtime].sort((left, right) => right.mtime - left.mtime)[0]!.name,
      );
    });

    const withDatabase = <A>(
      databasePath: string,
      operation: string,
      callback: (database: NodeSqlite.DatabaseSync) => A,
    ) =>
      Effect.try({
        try: () => {
          const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
          try {
            return callback(database);
          } finally {
            database.close();
          }
        },
        catch: (cause) =>
          new CodexDesktopStoreError({
            operation: operation === "open" ? "open" : "query",
            detail: `database '${databasePath}'`,
            cause,
          }),
      });

    const readThreadRow = (database: NodeSqlite.DatabaseSync, threadId: string) => {
      if (!UUID_PATTERN.test(threadId)) return undefined;
      const raw = database
        .prepare(
          "SELECT id,title,updated_at,updated_at_ms,preview,cwd,archived,rollout_path,history_mode FROM threads WHERE id = ? LIMIT 1",
        )
        .get(threadId) as Record<string, unknown> | undefined;
      return raw === undefined ? undefined : rowToThread(raw);
    };

    const listThreads = (input?: {
      readonly cursor?: string;
      readonly search?: string;
      readonly limit?: number;
    }) =>
      Effect.gen(function* () {
        const home = yield* desktopHome();
        const databasePath = yield* stateDatabase(home);
        const limit = pageSize(input?.limit);
        const offset = pageValue(input?.cursor);
        const search = input?.search?.trim() ?? "";
        const result = yield* withDatabase(databasePath, "query", (database) => {
          const rows = database
            .prepare(
              `SELECT id,title,updated_at,updated_at_ms,preview,cwd,archived,rollout_path,history_mode
             FROM threads
             WHERE archived = 0 AND (? = '' OR title LIKE ? OR preview LIKE ?)
             ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ? OFFSET ?`,
            )
            .all(search, `%${search}%`, `%${search}%`, limit + 1, offset) as Record<
            string,
            unknown
          >[];
          return rows.map(rowToThread);
        });
        return {
          threads: result.slice(0, limit).map(toThread),
          nextCursor: result.length > limit ? String(offset + limit) : null,
        } satisfies CodexDesktopThreadListResponse;
      });

    const readThread = (
      threadId: string,
      input?: { readonly beforeCursor?: string; readonly limit?: number },
    ) =>
      Effect.gen(function* () {
        const home = yield* desktopHome();
        const databasePath = yield* stateDatabase(home);
        const limit = pageSize(input?.limit);
        const offset = pageValue(input?.beforeCursor);
        let nextCursor: string | null = null;
        const result = yield* withDatabase(databasePath, "query", (database) => {
          const row = readThreadRow(database, threadId);
          if (!row || row.archived !== 0) return null;
          return { row, messages: [], hasMore: false };
        });
        if (result === null) {
          return yield* new CodexDesktopStoreError({
            operation: "query",
            detail: `native Codex thread '${threadId}' was not found`,
          });
        }
        // Legacy JSONL message extraction is kept outside the database callback
        // so the SQLite handle remains open for the shortest possible period.
        let messages: CodexDesktopMessage[] = result.messages as CodexDesktopMessage[];
        let hasMore = result.hasMore;
        if (result.row.history_mode === "paginated") {
          const historyPath = yield* historyDatabase(home);
          const paginated = yield* withDatabase(
            historyPath,
            "query",
            (database) =>
              database
                .prepare(
                  `SELECT item_id,item_json FROM thread_items
               WHERE thread_id = ? AND item_type IN ('userMessage','agentMessage','commandExecution','functionCallOutput','mcpToolCall','fileChange')
               ORDER BY created_at_ms DESC, rollout_ordinal DESC
               LIMIT ? OFFSET ?`,
                )
                .all(threadId, limit + 1, offset) as Record<string, unknown>[],
          );
          messages = paginated
            .map((item) =>
              messageFromItem(String(item.item_json ?? ""), String(item.item_id ?? "")),
            )
            .filter((message): message is CodexDesktopMessage => message !== undefined);
          messages.reverse();
          hasMore = paginated.length > limit;
          if (messages.length > limit) messages = messages.slice(messages.length - limit);
          nextCursor = hasMore ? String(offset + limit) : null;
        } else {
          const storedRollout = result.row.rollout_path;
          const rollout = path.resolve(
            path.isAbsolute(storedRollout) ? storedRollout : path.join(home, storedRollout),
          );
          const homeRoot = path.resolve(home);
          if (rollout !== homeRoot && !rollout.startsWith(`${homeRoot}${path.sep}`)) {
            return yield* new CodexDesktopStoreError({
              operation: "path",
              detail: `rollout path for '${threadId}' escapes the configured Codex home`,
            });
          }
          const info = yield* fileSystem.stat(rollout).pipe(
            Effect.mapError(
              (cause) =>
                new CodexDesktopStoreError({
                  operation: "query",
                  detail: `rollout '${rollout}'`,
                  cause,
                }),
            ),
          );
          const rawAndStart = yield* Effect.tryPromise({
            try: async () => {
              const handle = await NodeFS.open(rollout, "r");
              try {
                const size = Number(info.size);
                const cursor = input?.beforeCursor?.match(/^byte:(\d+)(?::(\d+))?$/);
                const end =
                  cursor === null || cursor === undefined
                    ? size
                    : Math.min(size, Number(cursor[1]));
                const skip = cursor?.[2] === undefined ? 0 : Number(cursor[2]);
                const start = Math.max(0, end - MAX_LEGACY_ROLLOUT_BYTES);
                const buffer = Buffer.alloc(end - start);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
                const text = buffer.subarray(0, bytesRead).toString("utf8");
                return {
                  text: start === 0 ? text : text.slice(text.indexOf("\n") + 1),
                  start,
                  end,
                  skip,
                };
              } finally {
                await handle.close();
              }
            },
            catch: (cause) =>
              new CodexDesktopStoreError({
                operation: "query",
                detail: `bounded rollout '${rollout}'`,
                cause,
              }),
          });
          const raw = rawAndStart.text;
          const parsedMessages = raw
            .split(/\r?\n/)
            .map((line, index) => {
              try {
                return messageFromRecord(JSON.parse(line), index);
              } catch {
                return undefined;
              }
            })
            .filter((message): message is CodexDesktopMessage => message !== undefined);
          const endIndex = Math.max(0, parsedMessages.length - rawAndStart.skip);
          const startIndex = Math.max(0, endIndex - limit);
          messages = parsedMessages.slice(startIndex, endIndex);
          const olderInChunk = startIndex > 0;
          hasMore = olderInChunk || rawAndStart.start > 0;
          nextCursor = olderInChunk
            ? `byte:${rawAndStart.end}:${rawAndStart.skip + limit}`
            : rawAndStart.start > 0
              ? `byte:${rawAndStart.start}:0`
              : null;
        }
        return {
          thread: toThread(result.row),
          messages: messages.slice(0, limit),
          nextCursor,
        } satisfies CodexDesktopThreadHistoryResponse;
      });

    const provideBase = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const provideSettings = <A, E>(
      effect: Effect.Effect<A, E, ServerSettings.ServerSettingsService>,
    ) =>
      settingsService === undefined
        ? (effect as Effect.Effect<A, E, never>)
        : effect.pipe(Effect.provideService(ServerSettings.ServerSettingsService, settingsService));
    return CodexDesktopStore.of({
      listThreads: (input) => provideSettings(provideBase(listThreads(input))),
      readThread: (threadId, input) => provideSettings(provideBase(readThread(threadId, input))),
    });
  });

export const layer = Layer.effect(
  CodexDesktopStore,
  make() as Effect.Effect<
    CodexDesktopStoreShape,
    CodexDesktopStoreError | PlatformError.PlatformError | ServerSettingsError,
    FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
  >,
);

/** Test/fixture layer; production callers use the configured primary desktop home. */
export const layerWithHomePath = (homePath: string) =>
  Layer.effect(
    CodexDesktopStore,
    make({ homePath }) as Effect.Effect<
      CodexDesktopStoreShape,
      CodexDesktopStoreError | PlatformError.PlatformError | ServerSettingsError,
      FileSystem.FileSystem | Path.Path
    >,
  );
