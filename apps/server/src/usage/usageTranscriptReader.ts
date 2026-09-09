// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import { createHash } from "node:crypto";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  initialGeminiScanState,
  mightCarryUsage,
  parseAntigravityTokenCache,
  parseClaudeLine,
  parseCodexLine,
  parseGeminiLine,
  parseGeminiValue,
  parseOpenCodeMessageValue,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";
import { parseAiStudioExport, parseChatGptExport } from "./usageImportedChats.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptScanSelection<File extends TranscriptFile = TranscriptFile> {
  readonly files: readonly File[];
  readonly deferredFiles: number;
  readonly deferredBytes: number;
  readonly coldBytes: number;
}

/**
 * Chooses newest transcripts first while bounding uncached I/O for one request.
 * Warm files cost zero and validated append reads cost only their new bytes.
 * This allows repeated reads to progressively
 * fill the cache without making the usage page wait on an unbounded cold scan.
 */
export function selectTranscriptFilesForScan<File extends TranscriptFile>(
  files: readonly File[],
  bytesToRead: (file: File) => number,
  maxColdBytes: number,
): TranscriptScanSelection<File> {
  const selected: File[] = [];
  let deferredFiles = 0;
  let deferredBytes = 0;
  let coldBytes = 0;
  const oversized: File[] = [];
  let selectedColdFile = false;

  const newestFirst = [...files].sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
  );
  for (const file of newestFirst) {
    const readBytes = bytesToRead(file);
    if (readBytes === 0) {
      selected.push(file);
      continue;
    }
    if (readBytes <= maxColdBytes - coldBytes) {
      selected.push(file);
      coldBytes += readBytes;
      if (readBytes === file.size && readBytes > 0) selectedColdFile = true;
      continue;
    }
    oversized.push(file);
    deferredFiles += 1;
    deferredBytes += readBytes;
  }

  // A single giant rollout must make progress eventually, but it should not
  // block the first useful result while smaller cold files can fill the
  // bounded batch. Warm files and append-only active rollouts do not provide
  // that first-load protection, so admit one oversized file alongside them
  // and keep the partial totals visible while it is parsed.
  if (!selectedColdFile && oversized.length > 0) {
    const file = oversized[0]!;
    const readBytes = bytesToRead(file);
    selected.push(file);
    coldBytes += readBytes;
    deferredFiles -= 1;
    deferredBytes -= readBytes;
  }

  return { files: selected, deferredFiles, deferredBytes, coldBytes };
}

/**
 * Lists provider transcript files under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  provider: UsageProviderKind,
): Promise<readonly TranscriptFile[]> {
  if (provider === "opencode") return listOpenCodeDatabase(root, sinceMs);

  const found: TranscriptFile[] = [];
  const directories = [root];
  const transcripts: string[] = [];

  // The provider homes contain thousands of nested directories. Walking one
  // directory at a time made a warm refresh spend tens of seconds on metadata.
  // Breadth-first batches keep I/O bounded while allowing independent folders
  // to resolve together.
  for (let offset = 0; offset < directories.length;) {
    const batch = directories.slice(offset, offset + 64);
    offset += batch.length;
    const listings = await Promise.all(
      batch.map(async (dir) => {
        try {
          return { dir, entries: await NodeFSP.readdir(dir, { withFileTypes: true }) };
        } catch {
          return { dir, entries: [] };
        }
      }),
    );
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        const child = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          directories.push(child);
          continue;
        }
        const isTranscript =
          provider === "aistudio"
            ? true
            : provider === "chatgpt"
              ? entry.name === "conversations.json"
              : provider === "gemini"
                ? (entry.name.startsWith("session-") &&
                    (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) ||
                  entry.name === "tokens_cache.json"
                : entry.name.endsWith(".jsonl");
        if (isTranscript) transcripts.push(child);
      }
    }
  }

  // Bound concurrent metadata reads, including on slower network-backed homes.
  for (let offset = 0; offset < transcripts.length; offset += 128) {
    const batch = await Promise.all(
      transcripts.slice(offset, offset + 128).map(async (child) => {
        try {
          const stats = await NodeFSP.stat(child);
          return stats.mtimeMs >= sinceMs
            ? { path: child, size: stats.size, mtimeMs: stats.mtimeMs }
            : null;
        } catch {
          return null;
        }
      }),
    );
    for (const file of batch) {
      if (file !== null) found.push(file);
    }
  }

  return found;
}

/**
 * Returns OpenCode's SQLite store as one cacheable source.
 *
 * SQLite may leave new commits in the WAL while the main database file stays
 * unchanged. Folding the sidecars into the synthetic size/mtime identity makes
 * a newly appended assistant response invalidate only this source's cache.
 */
async function listOpenCodeDatabase(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const databasePath = NodePath.join(root, "opencode.db");
  let size = 0;
  let mtimeMs = 0;
  let foundDatabase = false;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const stats = await NodeFSP.stat(path);
      size += stats.size;
      mtimeMs = Math.max(mtimeMs, stats.mtimeMs);
      if (path === databasePath) foundDatabase = true;
    } catch {
      // SQLite sidecars are optional and disappear after checkpoints.
    }
  }
  return foundDatabase && mtimeMs >= sinceMs ? [{ path: databasePath, size, mtimeMs }] : [];
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export interface TranscriptReadOptions {
  readonly startByte?: number;
  readonly endByte?: number;
  readonly codexState?: CodexScanState;
}

export interface TranscriptReadResult {
  readonly records: readonly UsageRecord[];
  readonly codexState?: CodexScanState;
}

/** Whether an append cursor follows a complete JSONL record. */
export async function transcriptCursorIsLineBoundary(
  filePath: string,
  offset: number,
): Promise<boolean> {
  if (offset === 0) return true;
  let file: NodeFSP.FileHandle | null = null;
  try {
    file = await NodeFSP.open(filePath, "r");
    const byte = Buffer.allocUnsafe(1);
    const read = await file.read(byte, 0, 1, offset - 1);
    return read.bytesRead === 1 && byte[0] === 0x0a;
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  options: TranscriptReadOptions = {},
): Promise<TranscriptReadResult | null> {
  if (provider === "aistudio" || provider === "chatgpt") {
    const records = await readImportedChatRecords(filePath, provider);
    return records === null ? null : { records };
  }
  if (provider === "gemini") {
    const records = await readGeminiTranscriptRecords(filePath);
    return records === null ? null : { records };
  }
  if (provider === "opencode") {
    const records = await readOpenCodeDatabaseRecords(filePath);
    return records === null ? null : { records };
  }

  const records: UsageRecord[] = [];
  const codexState = options.codexState ? { ...options.codexState } : initialCodexScanState();

  try {
    const start = options.startByte ?? 0;
    const end = options.endByte;
    if (end !== undefined && end < start) {
      return provider === "codex" ? { records, codexState } : { records };
    }
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, {
        encoding: "utf8",
        ...(start === 0 ? {} : { start }),
        ...(end === undefined ? {} : { end }),
      }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return provider === "codex" ? { records, codexState } : { records };
}

/** Reads one already-local product export; raw chat text never leaves the server. */
async function readImportedChatRecords(
  filePath: string,
  provider: "aistudio" | "chatgpt",
): Promise<readonly UsageRecord[] | null> {
  try {
    const raw = await NodeFSP.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const stats = await NodeFSP.stat(filePath);
    if (provider === "chatgpt") {
      return parseChatGptExport(parsed, { importedAtMs: stats.mtimeMs });
    }
    const conversationId = createHash("sha256").update(raw).digest("hex");
    return parseAiStudioExport(parsed, { conversationId, importedAtMs: stats.mtimeMs });
  } catch {
    return null;
  }
}

interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

/** Reads usage-only assistant metadata without touching prompts or credentials. */
async function readOpenCodeDatabaseRecords(
  filePath: string,
): Promise<readonly UsageRecord[] | null> {
  let database: NodeSqlite.DatabaseSync | null = null;
  try {
    database = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT id, session_id, time_created, data FROM message WHERE json_extract(data, '$.role') = 'assistant'",
      )
      .all() as unknown as readonly OpenCodeMessageRow[];
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.session_id !== "string" ||
        typeof row.time_created !== "number" ||
        typeof row.data !== "string"
      ) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data) as unknown;
      } catch {
        continue;
      }
      const record = parseOpenCodeMessageValue(parsed, {
        id: row.id,
        sessionId: row.session_id,
        timestampMs: row.time_created,
      });
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

async function readGeminiTranscriptRecords(
  filePath: string,
): Promise<readonly UsageRecord[] | null> {
  const state = initialGeminiScanState();
  const byMessage = new Map<string, UsageRecord>();
  const withoutIdentity: UsageRecord[] = [];
  const keep = (record: UsageRecord | null) => {
    if (record === null) return;
    if (record.dedupeKey === null) withoutIdentity.push(record);
    else byMessage.set(record.dedupeKey, record);
  };

  try {
    if (NodePath.basename(filePath) === "tokens_cache.json") {
      const parsed = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as unknown;
      const stats = await NodeFSP.stat(filePath);
      keep(
        parseAntigravityTokenCache(parsed, {
          timestampMs: stats.mtimeMs,
          sessionId: NodePath.basename(
            NodePath.dirname(NodePath.dirname(NodePath.dirname(filePath))),
          ),
        }),
      );
      return [...byMessage.values(), ...withoutIdentity];
    }

    if (filePath.endsWith(".json")) {
      const parsed = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as unknown;
      keep(parseGeminiValue(parsed, state));
      if (typeof parsed === "object" && parsed !== null) {
        const messages = (parsed as Record<string, unknown>)["messages"];
        if (Array.isArray(messages)) {
          for (const message of messages) keep(parseGeminiValue(message, state));
        }
      }
      return [...byMessage.values(), ...withoutIdentity];
    }

    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!mightCarryUsage(line, "gemini") && !line.includes('"sessionId"')) continue;
      // JSONL session files write metadata and messages as standalone records.
      // `$set` patch records repeat message arrays and must not be counted too.
      if (line.includes('"$set"')) continue;
      keep(parseGeminiLine(line, state));
    }
    return [...byMessage.values(), ...withoutIdentity];
  } catch {
    return null;
  }
}
