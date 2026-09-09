/**
 * Durable per-file scan cache.
 *
 * Transcripts are append-only and a file that has not changed can never yield
 * different usage, so parsed records are keyed by `(size, mtime)` and reused.
 * Without this every server restart re-parses the whole window: roughly 3.5s
 * for a 30-day scan here, against ~11ms to reload this cache.
 *
 * Caching *per file* rather than per day is deliberate. It is timezone
 * independent, so changing the reporting zone does not invalidate anything, and
 * it keeps cross-file de-duplication exact: cached entries are de-duplicated
 * within their own file only, and the aggregator still applies the global
 * dedupe pass over the small surviving key set.
 *
 * @module usageScanCache
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import type { CodexScanState, UsageRecord } from "./usageTranscripts.ts";

// v2 changed fork-copy suppression. v3 added root coverage. v4 persists the
// Codex parser cursor. v5 reparses AI Studio files for source dates and branch
// de-duplication. v6 adds stable Codex cross-file keys; old Codex entries are
// cold-rebuilt so migrated shared/private rollouts cannot be double counted.
export const USAGE_SCAN_CACHE_VERSION = 6 as const;

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
  readonly codexState?: CodexScanState;
}

export type ScanCache = Map<string, CachedFile>;

export interface ScanCoverage {
  readonly provider: UsageProviderKind;
  readonly rootPath: string;
  readonly sinceMs: number;
  readonly scannedAtMs: number;
}

export interface TranscriptScanPlanOptions {
  readonly coverage: ScanCoverage | undefined;
  readonly windowStartMs: number;
  readonly nowMs: number;
  readonly lastRecentScanAtMs: number;
  readonly incrementalScanTtlMs: number;
  readonly recentTranscriptWindowMs: number;
  readonly fullScanIntervalMs: number;
}

export interface TranscriptScanPlan {
  readonly hasCurrentCoverage: boolean;
  readonly shouldRefresh: boolean;
  readonly scanStartMs: number;
}

/** Chooses a recent refresh or a complete audit for one provider root. */
export function planTranscriptScan(options: TranscriptScanPlanOptions): TranscriptScanPlan {
  const coverageIncludesWindow =
    options.coverage !== undefined && options.coverage.sinceMs <= options.windowStartMs;
  const hasCurrentCoverage =
    options.coverage !== undefined &&
    coverageIncludesWindow &&
    options.nowMs - options.coverage.scannedAtMs < options.fullScanIntervalMs;
  const shouldRefresh =
    !hasCurrentCoverage ||
    options.nowMs - options.lastRecentScanAtMs >= options.incrementalScanTtlMs;
  const scanStartMs = hasCurrentCoverage
    ? Math.max(options.windowStartMs, options.nowMs - options.recentTranscriptWindowMs)
    : coverageIncludesWindow && options.coverage !== undefined
      ? options.coverage.sinceMs
      : options.windowStartMs;

  return { hasCurrentCoverage, shouldRefresh, scanStartMs };
}

/**
 * Row layout for the serialised form. Positional and interned rather than
 * object-per-record: on a 30-day window that is the difference between a file
 * measured in tens of megabytes and one under six.
 */
type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  serviceTier?: string | null,
  turnId?: string | null,
];

interface SerializedFile {
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  readonly c?: readonly [
    string,
    string,
    string | null,
    boolean,
    boolean,
    number,
    (string | null)?,
    (string | null)?,
  ];
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
  readonly coverage?: readonly [UsageProviderKind, string, number, number][];
}

/** Serialises the cache, interning the repeated model and session strings. */
export function encodeScanCache(
  cache: ScanCache,
  coverage: readonly ScanCoverage[] = [],
): SerializedCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();

  const intern = (table: string[], index: Map<string, number>, value: string): number => {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) {
    files[path] = {
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      ...(entry.codexState === undefined
        ? {}
        : {
            c: [
              entry.codexState.model,
              entry.codexState.sessionId,
              entry.codexState.lastUsageSignature,
              entry.codexState.sawSessionMeta,
              entry.codexState.suppressingForkCopies,
              entry.codexState.forkCopyAnchorMs,
              entry.codexState.serviceTier ?? null,
              entry.codexState.turnId ?? null,
            ] as const,
          }),
      r: entry.records.map((record) => [
        record.timestampMs,
        intern(models, modelIndex, record.model),
        intern(sessions, sessionIndex, record.sessionId),
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationTokens,
        record.totals.outputTokens,
        record.totals.reasoningTokens,
        record.dedupeKey,
        record.reportedCostUsd,
        record.serviceTier ?? null,
        record.turnId ?? null,
      ]),
    };
  }

  return {
    version: USAGE_SCAN_CACHE_VERSION,
    models,
    sessions,
    files,
    coverage: coverage.map((entry) => [
      entry.provider,
      entry.rootPath,
      entry.sinceMs,
      entry.scannedAtMs,
    ]),
  };
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Rebuilds the cache from a parsed document.
 *
 * Anything malformed yields an empty cache rather than an error: a corrupt
 * cache should cost one cold scan, never a broken page.
 */
export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  if (
    root.version !== 2 &&
    root.version !== 3 &&
    root.version !== 4 &&
    root.version !== 5 &&
    root.version !== USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  // The intern tables must be all strings: a numeric entry would pass the
  // undefined guard below, land in a record's model, and crash the aggregate
  // at normalizeModelName. A corrupt table rejects the whole cache.
  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (
      entry.p !== "claude" &&
      entry.p !== "codex" &&
      entry.p !== "gemini" &&
      entry.p !== "opencode" &&
      entry.p !== "chatgpt" &&
      entry.p !== "aistudio"
    ) {
      continue;
    }
    if (!isRecordArray(entry.r)) continue;

    const provider: UsageProviderKind = entry.p;
    if (root.version < USAGE_SCAN_CACHE_VERSION && provider === "codex") continue;
    const records: UsageRecord[] = [];
    // Any corrupt row disqualifies the whole entry. Keeping the survivors
    // under the original (size, mtime) would read as a valid warm hit and the
    // file would never be re-parsed, silently losing the dropped rows' usage.
    let corrupt = false;
    for (const row of entry.r) {
      if (!isRecordArray(row) || row.length < 10) {
        corrupt = true;
        break;
      }
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        serviceTier,
        turnId,
      ] = row as SerializedRecord;

      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning)
      ) {
        corrupt = true;
        break;
      }

      records.push({
        provider,
        timestampMs,
        model,
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        ...(typeof serviceTier === "string"
          ? { serviceTier, serviceTierSource: "transcript" as const }
          : {}),
        ...(typeof turnId === "string" ? { turnId } : {}),
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }

    if (corrupt) continue;
    let codexState: CodexScanState | undefined;
    if (root.version >= 4 && entry.c !== undefined) {
      const [
        model,
        sessionId,
        lastUsageSignature,
        sawSessionMeta,
        suppressingForkCopies,
        anchor,
        serviceTier,
        turnId,
      ] = entry.c;
      if (
        typeof model !== "string" ||
        typeof sessionId !== "string" ||
        (lastUsageSignature !== null && typeof lastUsageSignature !== "string") ||
        typeof sawSessionMeta !== "boolean" ||
        typeof suppressingForkCopies !== "boolean" ||
        typeof anchor !== "number" ||
        !Number.isFinite(anchor)
      ) {
        continue;
      }
      codexState = {
        model,
        sessionId,
        lastUsageSignature,
        sawSessionMeta,
        suppressingForkCopies,
        forkCopyAnchorMs: anchor,
        ...(typeof serviceTier === "string" ? { serviceTier } : {}),
        ...(typeof turnId === "string" ? { turnId } : {}),
      };
    }
    cache.set(path, {
      size: entry.s,
      mtimeMs: entry.m,
      provider,
      records,
      ...(codexState === undefined ? {} : { codexState }),
    });
  }

  return cache;
}

/** Reads provider-root coverage. v2 caches remain valid but start uncovered. */
export function decodeScanCoverage(document: unknown): readonly ScanCoverage[] {
  if (typeof document !== "object" || document === null) return [];
  const root = document as Partial<SerializedCache>;
  if (
    (root.version !== 3 && root.version !== 4 && root.version !== USAGE_SCAN_CACHE_VERSION) ||
    !Array.isArray(root.coverage)
  ) {
    return [];
  }

  const coverage: ScanCoverage[] = [];
  for (const row of root.coverage) {
    if (!Array.isArray(row) || row.length !== 4) continue;
    const [provider, rootPath, sinceMs, scannedAtMs] = row;
    if (root.version < USAGE_SCAN_CACHE_VERSION && provider === "aistudio") continue;
    if (
      (provider !== "claude" &&
        provider !== "codex" &&
        provider !== "gemini" &&
        provider !== "opencode" &&
        provider !== "chatgpt" &&
        provider !== "aistudio") ||
      typeof rootPath !== "string" ||
      typeof sinceMs !== "number" ||
      !Number.isFinite(sinceMs) ||
      typeof scannedAtMs !== "number" ||
      !Number.isFinite(scannedAtMs)
    ) {
      continue;
    }
    coverage.push({ provider, rootPath, sinceMs, scannedAtMs });
  }
  return coverage;
}

export interface PruneOptions {
  /** Files the walk just saw. Only meaningful inside the walked window. */
  readonly livePaths: ReadonlySet<string>;
  /**
   * Roots the walk actually completed. Absence from `livePaths` only proves a
   * file is gone when its root was walked: a provider whose directory failed to
   * resolve this pass must not have its warm entries purged.
   */
  readonly walkedRoots: readonly string[];
  /** Start of the walked window; entries older than this were not looked for. */
  readonly windowStartMs: number;
  /** Entries older than this are dropped regardless. */
  readonly retentionCutoffMs: number;
}

/**
 * Drops aged-out entries, and entries for files that have disappeared.
 *
 * The walk only covers the requested window, so absence from `livePaths` only
 * proves deletion for entries *inside* that window. Pruning everything the walk
 * missed would evict the 30-day entries every time someone looked at 7 days.
 *
 * Replaces an earlier record cap that cleared the whole cache once exceeded,
 * which meant a large enough window never warmed up at all.
 */
export function pruneScanCache(cache: ScanCache, options: PruneOptions): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const underWalkedRoot = options.walkedRoots.some(
      (root) =>
        path === root ||
        path.startsWith(root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`),
    );
    const deleted =
      underWalkedRoot && entry.mtimeMs >= options.windowStartMs && !options.livePaths.has(path);
    if (agedOut || deleted) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/** Within-file de-duplication, applied before an entry is cached. */
export function dedupeWithinFile(records: readonly UsageRecord[]): readonly UsageRecord[] {
  const seen = new Set<string>();
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
