/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  CodexSettings,
  type CodexSettings as CodexSettingsValue,
  type UsageProviderKind,
  type UsageQuotaCost,
  type ServerSettings as ServerSettingsValue,
  type UsagePricing,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexBinaryPath } from "../provider/CodexAppServerTransport.ts";
import {
  codexIsolatedHomePath,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { codexLaunchArgv, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import { readCodexQuotaSample } from "./CodexQuotaCollector.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import { UsageSummaryCache, usageSummaryCacheKey } from "./usageSummaryCache.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
  selectTranscriptFilesForScan,
  transcriptCursorIsLineBoundary,
  type TranscriptFile,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  decodeScanCoverage,
  dedupeWithinFile,
  encodeScanCache,
  planTranscriptScan,
  pruneScanCache,
  type ScanCache,
  type ScanCoverage,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";
import {
  applyCodexServiceTier,
  CODEX_FAST_WINDOWS,
  CODEX_TIER_JOURNAL,
  parseCodexFastWindows,
  parseCodexTierJournal,
} from "./codexServiceTier.ts";
import {
  QuotaCostAccumulator,
  encodeQuotaHistory,
  readQuotaHistory,
  validQuotaIntervals,
} from "./usageQuotaHistory.ts";
import {
  readQuotaCostLedger,
  upsertQuotaCostLedger,
  writeQuotaCostLedger,
  type QuotaCostLedgerRow,
} from "./usageQuotaCostLedger.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;
const SUMMARY_CACHE_TTL_MS = 60 * 1000;
const MAX_SUMMARY_CACHE_ENTRIES = 16;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 365;

/** Keeps a first-time usage read responsive even with very large transcripts. */
const MAX_COLD_SCAN_BYTES_PER_SOURCE = 128 * 1024 * 1024;

/** Files changed in this span are checked between complete directory audits. */
const RECENT_TRANSCRIPT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Range switches inside this span reuse the inventory from the previous read. */
const INCREMENTAL_SCAN_TTL_MS = 60 * 1000;

/** Full audits catch deleted history without putting a tree walk on every request. */
const FULL_SCAN_INTERVAL_MS = 15 * 60 * 1000;

/** A macOS server can collect one authenticated allowance reading per cycle. */
const MAC_QUOTA_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/** Matches the client query TTL while deduplicating requests across clients. */

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const UsageImportsFile = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Array(
    Schema.Struct({
      provider: Schema.Literals(["chatgpt", "aistudio"]),
      path: Schema.String,
    }),
  ),
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const decodeUsageImports = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UsageImportsFile as unknown as Schema.Codec<typeof UsageImportsFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

const decodeCodexQuotaSettings = Schema.decodeUnknownOption(CodexSettings);

/** Resolve the enabled Codex instance that owns the quota window, preferring the default ID. */
export function resolveCodexQuotaSettings(
  settings: ServerSettingsValue,
): CodexSettingsValue | null {
  const instances = Object.entries(settings.providerInstances)
    .filter(([, instance]) => instance.driver === "codex")
    .sort(([left], [right]) => {
      if (left === "codex") return -1;
      if (right === "codex") return 1;
      return left.localeCompare(right);
    });

  for (const [, instance] of instances) {
    if (instance.enabled === false) continue;
    const decoded = Option.getOrUndefined(decodeCodexQuotaSettings(instance.config ?? {}));
    if (decoded?.enabled === true) return decoded;
  }

  return settings.providers.codex.enabled ? settings.providers.codex : null;
}

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    /** Refetches the rate table ahead of its TTL. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;
  const hostPlatform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Scope.make("sequential");
  const scanSemaphore = yield* Semaphore.make(1);
  const macQuotaCollectionSemaphore = yield* Semaphore.make(1);

  const fileCache: ScanCache = new Map();
  const scanCoverage = new Map<string, ScanCoverage>();
  const recentScanAt = new Map<string, number>();
  const summaryCache = new UsageSummaryCache(SUMMARY_CACHE_TTL_MS, MAX_SUMMARY_CACHE_ENTRIES);
  // Shares the result only while an identical scan is running. Completed
  // provider-backed summaries are deliberately not retained because transcript
  // changes must be visible to the next request.
  const inFlightSummaries = new Map<
    string,
    Deferred.Deferred<Exit.Exit<UsageSummary, UsageReadError>, never>
  >();
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );
  let cacheDirty = false;
  let cacheRevision = 0;

  // A scan response must not wait for the complete JSON cache to be encoded
  // and atomically replaced. The cache is an optimization; the in-memory
  // records already used to build the response are authoritative for this
  // process. Revisions let the worker tell whether another scan made changes
  // while it was serializing or writing its snapshot.
  const markCacheDirty = () => {
    cacheDirty = true;
    cacheRevision += 1;
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  const usageImportsPath = path.join(config.stateDir, "usage-imports.json");
  const macQuotaHistoryPath = path.join(config.stateDir, "usage-codex-quota-history.json");
  let lastMacQuotaCollectionAtMs = 0;
  const quotaCostLedgerPath = path.join(config.stateDir, "usage-quota-cost-ledger.json");
  let quotaCostLedger: readonly QuotaCostLedgerRow[] =
    yield* readQuotaCostLedger(quotaCostLedgerPath);
  let quotaCostLedgerDirty = false;
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";
  const ratesLock = yield* Semaphore.make(1);

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  const ensureRates = (force = false) =>
    ratesLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
        if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

        if (ratesFetchedAtMs === null) {
          const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
            Effect.flatMap((raw) => decodeRatesCache(raw)),
            Effect.catchCause(() => Effect.succeed(null)),
          );
          if (fromDisk !== null) {
            const parsed = parseRateTable(fromDisk.document);
            if (parsed.size > 0) {
              rates = parsed;
              ratesFetchedAtMs = fromDisk.fetchedAtMs;
              ratesStatus = "cached";
              if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
            }
          }
        }

        const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout(10_000),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (fetched === null) {
          // The refresh failed; whatever we are serving is now past its TTL and
          // must not keep claiming to be fresh.
          if (rates.size > 0) ratesStatus = "cached";
          return;
        }

        const parsed = parseRateTable(fetched);
        if (parsed.size === 0) return;

        rates = parsed;
        ratesFetchedAtMs = now;
        ratesStatus = "fresh";

        yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
          Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
          Effect.catchCause(() => Effect.void),
        );
      }),
    );

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
  ) {
    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexHomes = new Set<string>();
    const addCodexHome = Effect.fn("UsageService.addCodexHome")(function* (
      instanceId: string,
      codexConfig: CodexSettings,
    ) {
      const layout = yield* resolveCodexHomeLayout(codexConfig);
      // Usage must retain the legacy source while also seeing new T3-owned
      // transcripts. The private home is derived exactly as in CodexDriver.
      codexHomes.add(layout.sharedHomePath);
      if (!codexConfig.useDesktopAppDaemon && codexConfig.shadowHomePath.trim().length === 0) {
        codexHomes.add(codexIsolatedHomePath(path, config.baseDir, instanceId));
      }
    });
    yield* addCodexHome("codex", settings.providers.codex);
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (String(instance.driver) !== "codex") continue;
      const codexConfig = yield* Schema.decodeUnknownEffect(CodexSettings)(
        instance.config ?? {},
      ).pipe(Effect.orElseSucceed(() => null));
      if (codexConfig !== null) yield* addCodexHome(instanceId, codexConfig);
    }
    const geminiHome = path.join(NodeOS.homedir(), ".gemini");
    const openCodeHome = path.join(NodeOS.homedir(), ".local", "share", "opencode");
    const imports = yield* fileSystem.readFileString(usageImportsPath).pipe(
      Effect.flatMap((raw) => decodeUsageImports(raw)),
      Effect.orElseSucceed(() => null),
    );

    return [
      { provider: "claude" as const, dir: claudeDir },
      ...[...codexHomes].flatMap((codexHome) => [
        { provider: "codex" as const, dir: path.join(codexHome, "sessions") },
        { provider: "codex" as const, dir: path.join(codexHome, "archived_sessions") },
      ]),
      { provider: "gemini" as const, dir: path.join(geminiHome, "tmp") },
      { provider: "gemini" as const, dir: path.join(geminiHome, "antigravity", "brain") },
      { provider: "opencode" as const, dir: openCodeHome },
      ...(imports?.sources ?? [])
        .filter((source) => source.path.trim().length > 0)
        .map((source) => ({ provider: source.provider, dir: path.resolve(source.path) })),
    ];
  });

  /**
   * Loads once under the scan semaphore, marking completion only after the read.
   * A cancelled first reader leaves the next request free to load the cache.
   */
  let scanCacheLoaded = false;
  const ensureScanCacheLoaded = Effect.gen(function* () {
    if (scanCacheLoaded) return;
    const document = yield* fileSystem.readFileString(scanCachePath).pipe(
      Effect.flatMap((raw) => decodeScanCacheFile(raw)),
      Effect.orElseSucceed(() => null),
    );
    if (document !== null) {
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
      for (const entry of decodeScanCoverage(document)) {
        scanCoverage.set(`${entry.provider}\u0000${entry.rootPath}`, entry);
      }
    }
    scanCacheLoaded = true;
  });

  const persistScanCacheOnce = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return true;
    const revision = cacheRevision;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale. If a newer
    // scan changed the maps meanwhile, its revision remains dirty and the
    // worker publishes that newer snapshot next.
    return yield* encodeScanCacheFile(encodeScanCache(fileCache, [...scanCoverage.values()])).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          writeFileStringAtomically({ filePath: scanCachePath, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        ),
      ),
      Effect.map(() => {
        if (cacheRevision === revision) cacheDirty = false;
        return true;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.succeed(false)),
    );
  });
  const persistQueue = yield* Queue.dropping<void>(1);
  const persistQuotaCostLedgerOnce = Effect.fn("UsageService.persistQuotaCostLedger")(function* () {
    if (!quotaCostLedgerDirty) return true;
    const rows = quotaCostLedger;
    const persisted = yield* writeQuotaCostLedger(quotaCostLedgerPath, rows).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (persisted && rows === quotaCostLedger) quotaCostLedgerDirty = false;
    return persisted;
  });
  const runPersistWorker = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(persistQueue);
      yield* persistQuotaCostLedgerOnce();
      yield* persistScanCacheOnce();
    }
  });
  // Keep exactly one consumer alive for the service lifetime. Queue wakes are
  // deliberately lossy: the revision check in persistScanCacheOnce means a
  // single wake is enough to publish all changes made before it runs.
  const persistWorker = yield* Effect.forkIn(runPersistWorker, serviceScope, {
    startImmediately: true,
  });
  yield* Effect.addFinalizer(() =>
    Effect.uninterruptible(
      Scope.close(serviceScope, Exit.void).pipe(
        Effect.andThen(Fiber.await(persistWorker)),
        Effect.andThen(persistQuotaCostLedgerOnce()),
        Effect.ignore,
      ),
    ),
  );

  /**
   * macOS has no separately installed Codex Limits task. When no external
   * history exists, collect one sanitized sample through the configured Codex
   * home and retain it locally.
   */
  const collectMacQuotaSample = Effect.fn("UsageService.collectMacQuotaSample")(function* () {
    yield* macQuotaCollectionSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (hostPlatform !== "darwin") return;
        const now = yield* Clock.currentTimeMillis;
        if (now - lastMacQuotaCollectionAtMs < MAC_QUOTA_SAMPLE_INTERVAL_MS) return;
        lastMacQuotaCollectionAtMs = now;

        const settings = yield* settingsService.getSettings;
        const codex = resolveCodexQuotaSettings(settings);
        if (codex === null) return;
        const homeLayout = yield* resolveCodexHomeLayout(
          codex.useDesktopAppDaemon ? { ...codex, shadowHomePath: "" } : codex,
        );
        const environment = {
          PATH: hostEnvironment.PATH,
          HOME: hostEnvironment.HOME,
          ...(homeLayout.effectiveHomePath
            ? { CODEX_HOME: homeLayout.effectiveHomePath }
            : hostEnvironment.CODEX_HOME
              ? { CODEX_HOME: hostEnvironment.CODEX_HOME }
              : {}),
        };
        const binaryPath = yield* resolveCodexBinaryPath(codex);
        const launchArgs = resolveCodexLaunchArgs(codex.launchArgs, hostEnvironment);
        const sample = yield* readCodexQuotaSample({
          binaryPath,
          transport: "stdio",
          environment,
          cwd: process.cwd(),
          launchArgs: codexLaunchArgv(launchArgs),
          ...(homeLayout.effectiveHomePath ? { homePath: homeLayout.effectiveHomePath } : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, hostPlatform),
          Effect.scoped,
          Effect.timeout("10 seconds"),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (sample === null) return;

        const prior = yield* readQuotaHistory(macQuotaHistoryPath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcessPlatform, hostPlatform),
        );
        const retained = prior.status === "ready" ? prior.samples : [];
        const nextSamples = new Map(retained.map((entry) => [Date.parse(entry.observedAt), entry]));
        nextSamples.set(Date.parse(sample.observedAt), sample);
        const contents = encodeQuotaHistory(
          [...nextSamples.values()]
            .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
            .slice(-5_000),
        );
        yield* writeFileStringAtomically({ filePath: macQuotaHistoryPath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catchCause(() => Effect.void),
        );
      }),
    );
  });

  const readQuotaHistoryForEnvironment = Effect.fn("UsageService.readQuotaHistoryForEnvironment")(
    function* () {
      const imported = yield* readQuotaHistory(undefined).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcessPlatform, hostPlatform),
      );
      if (
        imported.status !== "missing" ||
        hostPlatform !== "darwin" ||
        process.env.T3CODE_QUOTA_HISTORY_PATH?.trim()
      ) {
        return imported;
      }
      yield* collectMacQuotaSample().pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause(() => Effect.void),
      );
      return yield* readQuotaHistory(macQuotaHistoryPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcessPlatform, hostPlatform),
      );
    },
  );

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    startByte: number,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const appendable = cached !== undefined && startByte > 0;
      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, {
          startByte,
          endByte: size - 1,
          ...(appendable && provider === "codex" && cached?.codexState !== undefined
            ? { codexState: cached.codexState }
            : {}),
        }),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return [];
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile([
        ...(appendable && cached !== undefined ? cached.records : []),
        ...parsed.records,
      ]);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        ...(parsed.codexState === undefined ? {} : { codexState: parsed.codexState }),
      });
      markCacheDirty();
      return records;
    });

  const readSummaryUnlocked = Effect.fn("UsageService.readSummaryUnlocked")(function* (
    input: UsageSummaryInput,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const quotaIntervals = input.quotaIntervals ?? [];
    if (!validQuotaIntervals(quotaIntervals, input.sinceDay, input.untilDay)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail:
          "Quota intervals must be ordered, disjoint, and inside the scanned window with two days of padding.",
      });
    }
    const quotaHistory =
      input.includeQuotaHistory || input.quotaHistoryOnly || input.quotaIntervals !== undefined
        ? yield* readQuotaHistoryForEnvironment()
        : undefined;
    if (input.quotaHistoryOnly) {
      const finishedAtMs = yield* Clock.currentTimeMillis;
      return {
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAtMs)),
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: "Not requested",
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
        quotaHistory,
        quotaCostSnapshots:
          input.quotaIntervals === undefined
            ? quotaCostLedger
            : quotaCostLedger.filter((row) =>
                input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
              ),
      } satisfies UsageSummary;
    }
    const quotaCosts: UsageQuotaCost[] = [];
    yield* ensureRates();
    yield* ensureScanCacheLoaded;
    const tierJournal = yield* fileSystem
      .readFileString(path.join(config.stateDir, CODEX_TIER_JOURNAL))
      .pipe(Effect.catchCause(() => Effect.succeed("")));
    const tiers = parseCodexTierJournal(tierJournal);
    const fastWindowText = yield* fileSystem
      .readFileString(path.join(config.stateDir, CODEX_FAST_WINDOWS))
      .pipe(Effect.catchCause(() => Effect.succeed("[]")));
    const fastWindows = yield* Effect.try({
      try: () => parseCodexFastWindows(fastWindowText),
      catch: (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: `Invalid local Codex Fast Mode windows: ${String(cause)}`,
        }),
    });

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    const settings = yield* readSettings;
    const dirs = yield* resolveTranscriptDirs(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
    });

    const sources: UsageSource[] = [];
    const activeDirs = dirs.filter(
      ({ provider }) => input.quotaIntervals === undefined || provider === "codex",
    );
    const plannedSources = yield* Effect.forEach(
      activeDirs,
      Effect.fnUntraced(function* ({ provider, dir }) {
        const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const exists = yield* fileSystem
          .exists(dir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) return { provider, dir, volumeId, exists: false as const };

        const coverageKey = `${provider}\u0000${dir}`;
        const coverage = scanCoverage.get(coverageKey);
        const lastRecentScanAt = recentScanAt.get(coverageKey) ?? 0;
        const plan = planTranscriptScan({
          coverage,
          windowStartMs,
          nowMs: startedAtMs,
          lastRecentScanAtMs: lastRecentScanAt,
          // Every summary read checks the current transcript inventory. The
          // per-file cache still avoids rereading unchanged transcript bytes.
          incrementalScanTtlMs: 0,
          recentTranscriptWindowMs: RECENT_TRANSCRIPT_WINDOW_MS,
          fullScanIntervalMs: FULL_SCAN_INTERVAL_MS,
        });
        const discoveredFiles = plan.shouldRefresh
          ? yield* Effect.promise(() => listTranscriptFiles(dir, plan.scanStartMs, provider))
          : [];
        return {
          provider,
          dir,
          volumeId,
          exists: true as const,
          coverageKey,
          discoveredFiles,
          ...plan,
        };
      }),
      { concurrency: 8 },
    );

    for (const source of plannedSources) {
      const { provider, dir, volumeId } = source;
      if (!source.exists) {
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message:
            provider === "chatgpt" || provider === "aistudio"
              ? "Configured chat archive directory was not found on this environment."
              : "No transcript directory on this environment.",
        });
        continue;
      }

      const { coverageKey, discoveredFiles, hasCurrentCoverage, shouldRefresh, scanStartMs } =
        source;
      const filesByPath = new Map<string, TranscriptFile>();

      if (hasCurrentCoverage) {
        for (const [filePath, entry] of fileCache) {
          if (entry.provider !== provider || entry.mtimeMs < windowStartMs) continue;
          const relative = path.relative(dir, filePath);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            continue;
          }
          filesByPath.set(filePath, {
            path: filePath,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          });
        }
      }
      for (const file of discoveredFiles) filesByPath.set(file.path, file);
      const files = [...filesByPath.values()];
      const plannedFiles = yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (file) {
          const cached = fileCache.get(file.path);
          const warm =
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider;
          const appendable =
            !warm &&
            cached !== undefined &&
            cached.provider === provider &&
            file.size > cached.size &&
            (provider === "claude" || (provider === "codex" && cached.codexState !== undefined)) &&
            (yield* Effect.promise(() => transcriptCursorIsLineBoundary(file.path, cached.size)));
          return { ...file, startByte: warm ? file.size : appendable ? cached.size : 0 };
        }),
        { concurrency: 16 },
      );
      const selection = selectTranscriptFilesForScan(
        plannedFiles,
        (file) => file.size - file.startByte,
        MAX_COLD_SCAN_BYTES_PER_SOURCE,
      );

      if (shouldRefresh) {
        const pruned = pruneScanCache(fileCache, {
          livePaths: new Set(discoveredFiles.map((file) => file.path)),
          walkedRoots: [dir],
          windowStartMs: scanStartMs,
          retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        });
        if (pruned > 0) markCacheDirty();
      }
      let scannedFiles = 0;
      let skippedFiles = selection.deferredFiles;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const quota = new QuotaCostAccumulator(
        provider === "codex" ? quotaIntervals : [],
        rates,
        createOverrideRateTable(settings.usagePriceOverrides),
      );

      for (const file of selection.files) {
        const records = yield* readFileRecords(
          file.path,
          file.size,
          file.mtimeMs,
          provider,
          file.startByte,
        );
        if (records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const rawRecord of records) {
          const record = applyCodexServiceTier(rawRecord, tiers, fastWindows);
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record)) {
            if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
            if (quotaIntervals.length > 0) quota.add(record);
          }
        }
      }

      const scanCompleted =
        selection.deferredFiles === 0 &&
        selection.files.every((file) => {
          const cached = fileCache.get(file.path);
          return (
            cached !== undefined &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs &&
            cached.provider === provider
          );
        });
      if (shouldRefresh && scanCompleted) {
        recentScanAt.set(coverageKey, startedAtMs);
        if (!hasCurrentCoverage) {
          scanCoverage.set(coverageKey, {
            provider,
            rootPath: dir,
            sinceMs: scanStartMs,
            scannedAtMs: startedAtMs,
          });
          markCacheDirty();
        }
      }

      for (const { start: _start, end: _end, ...cost } of quota.rows) {
        quotaCosts.push({
          ...cost,
          complete: scanCompleted,
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        });
      }
      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: selection.deferredFiles > 0 ? "partial" : "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          selection.deferredFiles > 0
            ? `Usage is partial while the transcript cache warms; ${selection.deferredFiles} older or oversized transcript files were deferred.`
            : provider === "aistudio"
              ? "AI Studio exports use exact chunk counts and source message dates when present. Older exports without createTime remain on their downloaded-file date; per-turn input context is reconstructed and copied branch prefixes are counted once."
              : provider === "chatgpt"
                ? scannedFiles === 0
                  ? "ChatGPT import is ready; no conversations.json export has been downloaded yet."
                  : "ChatGPT exports contain message dates but no token ledger; token counts and API-equivalent cost are estimated from chat text."
                : null,
      });
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths: new Set(),
      walkedRoots: [],
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    const recordedAt = DateTime.formatIso(DateTime.makeUnsafe(startedAtMs));
    for (const cost of quotaCosts) {
      const interval = quotaIntervals.find((candidate) => candidate.id === cost.intervalId);
      const first = quotaHistory?.samples.find(
        (sample) => sample.observedAt === interval?.sinceTime,
      );
      const last = quotaHistory?.samples.find(
        (sample) => sample.observedAt === interval?.untilTime,
      );
      if (!interval || !first || !last) continue;
      const next = upsertQuotaCostLedger(
        quotaCostLedger,
        cost,
        cost.fingerprint,
        {
          ...interval,
          firstRemainingPercent: first.remainingPercent,
          lastRemainingPercent: last.remainingPercent,
          resetsAt: first.resetsAt,
        },
        recordedAt,
      );
      if (next !== quotaCostLedger) {
        quotaCostLedger = next;
        quotaCostLedgerDirty = true;
      }
    }
    if (pruned > 0) markCacheDirty();
    // Cache persistence is derived work. Wake the permanent consumer without
    // making the response wait for JSON encoding or atomic replacement.
    yield* Queue.offer(persistQueue, undefined);

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const clientContractVersion = input.clientContractVersion ?? 5;
    const supportsOpenCode = clientContractVersion >= 6;
    const supportsImports = clientContractVersion >= 7;
    const supportsProvider = (provider: UsageProviderKind) =>
      (provider !== "opencode" || supportsOpenCode) &&
      ((provider !== "chatgpt" && provider !== "aistudio") || supportsImports);

    return {
      contractVersion: supportsImports ? USAGE_CONTRACT_VERSION : supportsOpenCode ? 6 : 5,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets.filter((bucket) => supportsProvider(bucket.provider)),
      sources: sources.filter((source) => supportsProvider(source.fingerprint.provider)),
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(quotaHistory === undefined ? {} : { quotaHistory }),
      ...(input.quotaIntervals === undefined ? {} : { quotaCosts }),
      ...(input.quotaIntervals === undefined
        ? {}
        : {
            quotaCostSnapshots: quotaCostLedger.filter((row) =>
              input.quotaIntervals!.some((interval) => interval.id === row.intervalId),
            ),
          }),
    } satisfies UsageSummary;
  });

  // A cache miss is decided from mutable per-file state. Serializing summary
  // scans makes that decision single-flight: a second window waits for the
  // first scan to persist its newly warm files instead of parsing them again.
  const readSummary: UsageService["Service"]["readSummary"] = (input) =>
    input.quotaHistoryOnly
      ? readSummaryUnlocked(input)
      : input.includeQuotaHistory
        ? Effect.gen(function* () {
            const settings = yield* readSettings;
            const key = usageSummaryCacheKey(input, settings.usagePriceOverrides);
            if (!input.refresh) {
              const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
              if (cached !== undefined) return cached;
            }
            return yield* scanSemaphore.withPermits(1)(
              Effect.gen(function* () {
                if (!input.refresh) {
                  const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
                  if (cached !== undefined) return cached;
                }
                const summary = yield* readSummaryUnlocked(input);
                // A provider-backed result must be rebuilt so changed transcript
                // metadata can invalidate it. Empty-source history fixtures are
                // safe to reuse and keep history-only navigation inexpensive.
                if (summary.sources.every((source) => source.status === "missing")) {
                  summaryCache.set(key, yield* Clock.currentTimeMillis, summary);
                }
                return summary;
              }),
            );
          })
        : // Reject an inverted calendar window before joining the single-flight
          // map. Invalid input has no scan to share and must remain immediate.
          input.sinceDay > input.untilDay
          ? readSummaryUnlocked(input)
          : Effect.gen(function* () {
              const settings = yield* readSettings;
              const key = usageSummaryCacheKey(input, settings.usagePriceOverrides);
              if (!input.refresh) {
                const cached = summaryCache.get(key, yield* Clock.currentTimeMillis);
                if (cached !== undefined) return cached;
              }

              const registration = yield* Effect.sync(() => {
                const existing = inFlightSummaries.get(key);
                if (existing !== undefined) return { existing } as const;
                const result = Deferred.makeUnsafe<Exit.Exit<UsageSummary, UsageReadError>>();
                inFlightSummaries.set(key, result);
                return { result } as const;
              });
              if ("existing" in registration) {
                const exit = yield* Deferred.await(registration.existing);
                if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
                return exit.value;
              }

              const result = registration.result;
              // Registration is synchronous, so concurrent callers cannot both
              // observe an empty map before the owner is installed.
              const exit = yield* scanSemaphore
                .withPermits(1)(readSummaryUnlocked(input))
                .pipe(
                  Effect.onExit((completed) =>
                    Effect.sync(() => inFlightSummaries.delete(key)).pipe(
                      Effect.andThen(Deferred.succeed(result, completed)),
                    ),
                  ),
                  Effect.exit,
                );
              if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
              if (exit.value.sources.every((source) => source.status === "missing")) {
                summaryCache.set(key, yield* Clock.currentTimeMillis, exit.value);
              }
              return exit.value;
            });

  return { readSummary, refreshRates } as const;
});

export const layer = Layer.effect(UsageService, make);
