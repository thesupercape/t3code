/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Provider parsers are line-at-a-time reducers where their formats allow it, so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";
import { normalizeServiceTier } from "./codexServiceTier.ts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  readonly serviceTier?: string;
  readonly serviceTierSource?: "transcript" | "t3Request" | "userReported";
  readonly turnId?: string;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  if (provider === "claude") return line.includes('"usage"');
  if (provider === "gemini") return line.includes('"tokens"');
  return line.includes('"token_count"');
}

/**
 * Grok reports cost in integer ticks where `1 USD = 10^10` ticks. See Grok
 * headless `total_cost_usd_ticks`. Convert to dollars for pricing.
 */
export const GROK_COST_USD_TICKS_PER_DOLLAR = 10_000_000_000;

function grokCostTicksToUsd(ticks: unknown): number | null {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
}
/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Gemini CLI                                                                 */
/* -------------------------------------------------------------------------- */

export interface GeminiScanState {
  sessionId: string;
}

export function initialGeminiScanState(): GeminiScanState {
  return { sessionId: "" };
}

/**
 * Parses Gemini CLI's session metadata and standalone message records.
 *
 * Newer sessions are JSONL streams, while older sessions store the same
 * message shape in one JSON document. The caller feeds either representation
 * through this function and keeps the last record for each message id.
 */
export function parseGeminiValue(parsed: unknown, state: GeminiScanState): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (typeof record["sessionId"] === "string") state.sessionId = record["sessionId"];
  if (record["type"] !== "gemini") return null;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  const model = typeof record["model"] === "string" ? record["model"] : "";
  const usage = record["tokens"];
  if (timestampMs === null || model.length === 0 || typeof usage !== "object" || usage === null) {
    return null;
  }
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = int(usageRecord["input"]);
  const cachedInputTokens = Math.min(inputTokens, int(usageRecord["cached"]));
  const thoughtTokens = int(usageRecord["thoughts"]);
  const candidateTokens = int(usageRecord["output"]);
  const toolTokens = int(usageRecord["tool"]);
  const totals: UsageTokenTotals = {
    // Gemini reports cached content as a subset of prompt tokens. Tool-use
    // prompt tokens are a separate input category and are billed as input.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens) + toolTokens,
    cachedInputTokens,
    cacheCreationTokens: 0,
    // Thoughts are billed output and included in totalTokenCount separately
    // from candidate output, so fold them into output while retaining the mix.
    outputTokens: candidateTokens + thoughtTokens,
    reasoningTokens: thoughtTokens,
  };
  if (totalTokens(totals) === 0) return null;

  const messageId = typeof record["id"] === "string" ? record["id"] : null;
  return {
    provider: "gemini",
    timestampMs,
    model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    dedupeKey:
      messageId === null
        ? null
        : `gemini:${state.sessionId.length > 0 ? state.sessionId : "?"}:${messageId}`,
  };
}

export function parseGeminiLine(line: string, state: GeminiScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseGeminiValue(parsed, state);
}

/** One Antigravity conversation-level token cache. */
export function parseAntigravityTokenCache(
  parsed: unknown,
  input: { readonly timestampMs: number; readonly sessionId: string },
): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const usage = parsed as Record<string, unknown>;
  const inputTokens = int(usage["input"]);
  const cachedInputTokens = Math.min(inputTokens, int(usage["cached"]));
  const outputTokens = int(usage["output"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "gemini",
    timestampMs: input.timestampMs,
    model: "gemini-antigravity",
    sessionId: input.sessionId,
    totals,
    // Antigravity's local cache reports subscription cost as zero. Usage uses
    // API-equivalent pricing, so leave this null for the normal rate lookup.
    reportedCostUsd: null,
    dedupeKey: `gemini-antigravity:${input.sessionId}`,
  };
}

/* -------------------------------------------------------------------------- */
/* OpenCode                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parses one OpenCode assistant message from its SQLite session store.
 *
 * OpenCode 1.x stores fresh input, cache reads, cache writes, visible output,
 * and reasoning as disjoint counters. Its own `opencode stats` command adds
 * reasoning to output when computing the total, so we do the same while
 * retaining reasoning as the output subset expected by the usage contract.
 * The recorded cost is authoritative: it includes OpenCode's provider/model
 * pricing configuration, including explicit zero-cost local and free models.
 */
export function parseOpenCodeMessageValue(
  parsed: unknown,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly timestampMs: number;
  },
): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message["role"] !== "assistant") return null;

  const providerId = typeof message["providerID"] === "string" ? message["providerID"] : "";
  const modelId = typeof message["modelID"] === "string" ? message["modelID"] : "";
  const tokens = message["tokens"];
  if (
    providerId.length === 0 ||
    modelId.length === 0 ||
    typeof tokens !== "object" ||
    tokens === null ||
    !Number.isFinite(input.timestampMs)
  ) {
    return null;
  }

  const tokenRecord = tokens as Record<string, unknown>;
  const cache = tokenRecord["cache"];
  const cacheRecord =
    typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : {};
  const reasoningTokens = int(tokenRecord["reasoning"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(tokenRecord["input"]),
    cachedInputTokens: int(cacheRecord["read"]),
    cacheCreationTokens: int(cacheRecord["write"]),
    outputTokens: int(tokenRecord["output"]) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;

  const cost = message["cost"];
  return {
    provider: "opencode",
    timestampMs: input.timestampMs,
    model: `${providerId}/${modelId}`,
    sessionId: input.sessionId,
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    dedupeKey: input.id.length > 0 ? `opencode:${input.id}` : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  serviceTier?: string | undefined;
  turnId?: string | undefined;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+). One second of
 * separation splits the two cleanly; `ccusage` uses the same threshold.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    state.serviceTier = normalizeServiceTier(
      payloadRecord["service_tier"] ?? payloadRecord["serviceTier"],
    );
    state.turnId =
      typeof payloadRecord["turn_id"] === "string" ? payloadRecord["turn_id"] : undefined;
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  const tier =
    normalizeServiceTier(
      (info as Record<string, unknown>)["service_tier"] ?? payloadRecord["service_tier"],
    ) ?? state.serviceTier;
  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
    ...(tier === undefined ? {} : { serviceTier: tier, serviceTierSource: "transcript" as const }),
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // The same rollout may temporarily exist in the legacy shared home and a
    // T3-owned home during resume migration. Keep a stable cross-file key so
    // usage counts that copied event once while preserving distinct turns.
    dedupeKey:
      state.sessionId.length > 0 ? `codex:${state.sessionId}:${timestampMs}:${signature}` : null,
  };
}

export { EMPTY_TOTALS };
