/**
 * Usage reporting contract.
 *
 * Each environment scans the provider CLIs' own on-disk session transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/{sessions,archived_sessions}/**\/*.jsonl`,
 * `~/.gemini/tmp/<project>/chats/session-*`, `~/.local/share/opencode/opencode.db`)
 * rather than
 * relying on T3 Code's own orchestration projections, so usage stays complete
 * even for turns that were never driven through T3 Code. This mirrors the
 * approach `ccusage` takes.
 *
 * Environments return pre-aggregated `(day, hourStart?, provider, model)`
 * buckets. Raw transcript records never cross the wire.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. The
 * client renders partial coverage when an environment reports an older version
 * rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 7 as const;
export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "chatgpt",
  "aistudio",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so that a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` - the transcript carried an explicit cost figure.
 * - `modelPriced` - we matched the model against the LiteLLM rate table.
 * - `unpriced` - tokens are known, rates are not. Counted in totals, excluded
 *   from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, Gemini thoughts
 * are folded into output, and Anthropic does not break thinking out), so it
 * must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/**
 * One `(day, hourStart?, provider, model)` cell. `hourStart` is the UTC start
 * instant of a rolling bucket and is present only for hourly requests.
 *
 * `costUsd` is the raw API-equivalent cost of these tokens. It is not money
 * spent: subscription plans bill separately. `unpricedRecords` counts records
 * whose tokens are included in the token totals but which contributed nothing
 * to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  /** Omitted by older servers. Unknown metadata uses the standard estimate. */
  serviceTier: Schema.optional(Schema.String),
  serviceTierSource: Schema.optional(
    Schema.Literals(["transcript", "t3Request", "userReported", "unknown"]),
  ),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * Identifies the physical transcript directory a source read from.
 *
 * Two environments on the same machine (worktree servers, for example) resolve
 * the same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 */
export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   *
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped. The
   * device/inode pair is stable for two servers reading the same directory and
   * effectively never collides across machines. Empty when it cannot be read.
   */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  /** Records that parsed but carried no recognisable usage payload. */
  malformedRecords: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

/** Sanitized observations imported from an external quota tracker. */
export const UsageQuotaSample = Schema.Struct({
  observedAt: Schema.String,
  remainingPercent: Schema.Number,
  resetsAt: Schema.String,
});
export type UsageQuotaSample = typeof UsageQuotaSample.Type;

export const UsageQuotaHistory = Schema.Struct({
  status: Schema.Literals(["ready", "missing", "invalid"]),
  source: Schema.String,
  samples: Schema.Array(UsageQuotaSample),
  /** Number of manual reset credits currently reported by the local tracker. */
  bankedResetCount: Schema.optional(NonNegativeInt),
  /** Timestamp of the local tracker's snapshot used for bankedResetCount. */
  bankedResetCheckedAt: Schema.optional(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type UsageQuotaHistory = typeof UsageQuotaHistory.Type;

/** Cost is measured after the first observation and through the last one. */
export const UsageQuotaInterval = Schema.Struct({
  id: TrimmedNonEmptyString,
  sinceTime: TrimmedNonEmptyString,
  untilTime: TrimmedNonEmptyString,
});
export type UsageQuotaInterval = typeof UsageQuotaInterval.Type;

export const UsageQuotaCost = Schema.Struct({
  intervalId: Schema.String,
  fingerprint: UsageSourceFingerprint,
  costUsd: Schema.Number,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  complete: Schema.Boolean,
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        model: Schema.String,
        totals: UsageTokenTotals,
        costUsd: Schema.Number,
        records: NonNegativeInt,
        unpricedRecords: NonNegativeInt,
      }),
    ),
  ),
});
export type UsageQuotaCost = typeof UsageQuotaCost.Type;

/** Durable, complete priced cost for one observed quota interval. */
export const UsageQuotaCostSnapshot = Schema.Struct({
  intervalId: Schema.String,
  fingerprint: UsageSourceFingerprint,
  sinceTime: Schema.String,
  untilTime: Schema.String,
  costUsd: Schema.Number,
  records: NonNegativeInt,
  recordedAt: Schema.String,
  firstRemainingPercent: Schema.Number,
  lastRemainingPercent: Schema.Number,
  resetsAt: Schema.String,
  models: Schema.optional(UsageQuotaCost.fields.models),
});
export type UsageQuotaCostSnapshot = typeof UsageQuotaCostSnapshot.Type;

export const UsageSummaryInput = Schema.Struct({
  /**
   * Highest response contract understood by the client. Contract v6 added
   * OpenCode and v7 added imported ChatGPT and AI Studio archives.
   */
  clientContractVersion: Schema.optional(NonNegativeInt),
  /** Revalidate recent files while retaining parsed, unchanged transcripts. */
  refresh: Schema.optional(Schema.Boolean),
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
  /** Defaults to daily for older clients. */
  resolution: Schema.optional(UsageResolution),
  /** Inclusive UTC instant for an hourly rolling window. */
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  /** Exclusive UTC instant for an hourly rolling window. */
  untilTime: Schema.optional(TrimmedNonEmptyString),
  includeQuotaHistory: Schema.optional(Schema.Boolean),
  /** Read saved observations without scanning transcripts or fetching prices. */
  quotaHistoryOnly: Schema.optional(Schema.Boolean),
  quotaIntervals: Schema.optional(Schema.Array(UsageQuotaInterval).check(Schema.isMaxLength(64))),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket),
  sources: Schema.Array(UsageSource),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
  quotaHistory: Schema.optional(UsageQuotaHistory),
  quotaCosts: Schema.optional(Schema.Array(UsageQuotaCost)),
  quotaCostSnapshots: Schema.optional(Schema.Array(UsageQuotaCostSnapshot)),
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
