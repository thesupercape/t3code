import { describe, expect, it } from "vite-plus/test";
import {
  applyCodexServiceTier,
  parseCodexFastWindows,
  parseCodexTierJournal,
} from "./codexServiceTier.ts";
import { initialCodexScanState, parseCodexLine, type UsageRecord } from "./usageTranscripts.ts";
import { decodeScanCache, encodeScanCache } from "./usageScanCache.ts";
import { parseRateTable, priceUsage, cacheSavingsUsd } from "./usagePricing.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { QuotaCostAccumulator } from "./usageQuotaHistory.ts";

const tokens = {
  uncachedInputTokens: 100,
  cachedInputTokens: 400,
  cacheCreationTokens: 20,
  outputTokens: 50,
  reasoningTokens: 30,
};
const record: UsageRecord = {
  provider: "codex",
  model: "gpt-5.6-sol",
  timestampMs: Date.parse("2026-08-31T01:00:00Z"),
  sessionId: "native-session",
  turnId: "native-turn",
  totals: tokens,
  reportedCostUsd: null,
  dedupeKey: "unique-response",
};
const windows = parseCodexFastWindows(
  JSON.stringify([
    {
      sinceTime: "2026-08-30T23:00:00Z",
      untilTime: "2026-08-31T03:00:00Z",
      note: "User reported 6 to 10 PM CDT",
    },
  ]),
);
const rates = parseRateTable({
  "gpt-5.6-sol": {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 20e-6,
    cache_read_input_token_cost: 0.4e-6,
    cache_creation_input_token_cost: 5e-6,
    input_cost_per_token_priority: 8e-6,
    output_cost_per_token_priority: 40e-6,
    cache_read_input_token_cost_priority: 0.8e-6,
    cache_creation_input_token_cost_priority: 10e-6,
    input_cost_per_token_above_272k_tokens: 8e-6,
    output_cost_per_token_above_272k_tokens: 30e-6,
    cache_read_input_token_cost_above_272k_tokens: 0.8e-6,
    cache_creation_input_token_cost_above_272k_tokens: 10e-6,
  },
});

describe("Codex service tier attribution", () => {
  it("uses an explicit window only for otherwise unidentified Codex usage", () => {
    expect(applyCodexServiceTier(record, new Map(), windows)).toMatchObject({
      serviceTier: "priority",
      serviceTierSource: "userReported",
    });
    expect(
      applyCodexServiceTier({ ...record, provider: "claude" }, new Map(), windows).serviceTier,
    ).toBeUndefined();
    expect(
      applyCodexServiceTier({ ...record, model: "gpt-5.3-codex-spark" }, new Map(), windows)
        .serviceTier,
    ).toBeUndefined();
    expect(
      applyCodexServiceTier(
        { ...record, timestampMs: Date.parse(windows[0]!.sinceTime) },
        new Map(),
        windows,
      ).serviceTier,
    ).toBe("priority");
    expect(
      applyCodexServiceTier(
        { ...record, timestampMs: Date.parse(windows[0]!.untilTime) },
        new Map(),
        windows,
      ).serviceTier,
    ).toBeUndefined();
  });
  it("lets logged standard service override a manual Fast Mode window", () => {
    const tiers = parseCodexTierJournal(
      JSON.stringify({
        sessionId: record.sessionId,
        turnId: record.turnId,
        serviceTier: "default",
      }),
    );
    expect(applyCodexServiceTier(record, tiers, windows)).toMatchObject({
      serviceTier: "default",
      serviceTierSource: "t3Request",
    });
    const transcript = { ...record, serviceTier: "flex", serviceTierSource: "transcript" as const };
    expect(applyCodexServiceTier(transcript, tiers, windows)).toBe(transcript);
    expect(
      applyCodexServiceTier({ ...record, sessionId: "other-session" }, tiers, []).serviceTier,
    ).toBeUndefined();
  });
  it("ignores partial journal lines and rejects invalid correction windows", () => {
    expect(parseCodexTierJournal('{"sessionId":').size).toBe(0);
    expect(() => parseCodexFastWindows('[{"sinceTime":"yesterday"}]')).toThrow();
    expect(() => parseCodexFastWindows("{}")).toThrow();
  });
  it("keeps the tier and native turn through the durable append cursor", () => {
    const state = initialCodexScanState();
    parseCodexLine(
      JSON.stringify({
        type: "turn_context",
        payload: { model: record.model, turn_id: record.turnId, service_tier: "fast" },
      }),
      state,
    );
    const line = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-31T01:00:00Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } },
      },
    });
    const parsed = parseCodexLine(line, state)!;
    expect(parsed).toMatchObject({
      serviceTier: "priority",
      turnId: "native-turn",
      serviceTierSource: "transcript",
    });
    const cached = decodeScanCache(
      encodeScanCache(
        new Map([
          [
            "test.jsonl",
            { size: 500, mtimeMs: 1, provider: "codex", records: [parsed], codexState: state },
          ],
        ]),
      ),
    ).get("test.jsonl")!;
    expect(cached.records[0]).toEqual(parsed);
    expect(cached.codexState).toEqual(state);
    parseCodexLine(
      JSON.stringify({ type: "turn_context", payload: { model: record.model, turn_id: "next" } }),
      cached.codexState!,
    );
    expect(cached.codexState?.serviceTier).toBeUndefined();
  });
  it("retains old cached tokens without a global rescan or invented tier", () => {
    const encoded = encodeScanCache(
      new Map([["old.jsonl", { size: 500, mtimeMs: 1, provider: "codex", records: [record] }]]),
    );
    const legacy = {
      ...encoded,
      files: {
        "old.jsonl": {
          ...encoded.files["old.jsonl"],
          r: encoded.files["old.jsonl"]!.r.map((row) => row.slice(0, 10)),
        },
      },
    };
    expect(decodeScanCache(legacy).get("old.jsonl")?.records[0]).toMatchObject({ totals: tokens });
    expect(decodeScanCache(legacy).get("old.jsonl")?.records[0]?.serviceTier).toBeUndefined();
  });
});

describe("Fast Mode API estimates", () => {
  it("uses priority input, output and cache rates, never the 2.5x credit multiplier", () => {
    const standard = priceUsage(rates, record.model, tokens, null).costUsd;
    expect(priceUsage(rates, record.model, tokens, null, "priority").costUsd).toBeCloseTo(
      standard * 2,
    );
    expect(priceUsage(rates, record.model, tokens, null, "fast").costUsd).toBeCloseTo(standard * 2);
    expect(cacheSavingsUsd(rates, record.model, tokens, "priority")).toBeCloseTo(
      cacheSavingsUsd(rates, record.model, tokens) * 2,
    );
    expect(priceUsage(rates, record.model, tokens, 12, "priority")).toEqual({
      costUsd: 12,
      costSource: "providerReported",
    });
    expect(priceUsage(rates, record.model, tokens, null, "ultrafast").costSource).toBe("unpriced");
  });
  it("prices long-context GPT-5.6 priority requests at the published long-context rate", () => {
    const long = { ...tokens, uncachedInputTokens: 300_000 };
    expect(priceUsage(rates, record.model, long, null, "priority").costUsd).toBeCloseTo(
      priceUsage(rates, record.model, long, null).costUsd * 2,
    );
  });
  it("does not invent missing priority prices", () => {
    const noPriority = parseRateTable({
      model: { input_cost_per_token: 1, output_cost_per_token: 2 },
    });
    expect(priceUsage(noPriority, "model", tokens, null, "priority").costSource).toBe("unpriced");
  });
  it("uses the highest applicable context tier without requiring unused lower tiers", () => {
    const base = rates.get(record.model)!;
    const table = new Map([[record.model, { ...base, above200kTokens: base }]]);
    const long = { ...tokens, uncachedInputTokens: 300_000 };
    expect(priceUsage(table, record.model, long, null, "priority")).toEqual(
      priceUsage(rates, record.model, long, null, "priority"),
    );
    expect(
      priceUsage(table, record.model, { ...tokens, uncachedInputTokens: 220_000 }, null, "priority")
        .costSource,
    ).toBe("unpriced");
  });
  it("uses the same price once in usage graphs and quota-interval costs", () => {
    const fast = applyCodexServiceTier(record, new Map(), windows);
    const aggregator = new UsageAggregator({
      timeZone: "America/Chicago",
      sinceDay: "2026-08-30",
      untilDay: "2026-08-30",
      rates,
    });
    const quota = new QuotaCostAccumulator(
      [{ id: "cycle", sinceTime: "2026-08-30T23:00:00Z", untilTime: "2026-08-31T03:00:00Z" }],
      rates,
    );
    if (aggregator.add(fast)) quota.add(fast);
    if (aggregator.add(fast)) quota.add(fast);
    const result = aggregator.finish();
    expect(result.duplicatesDropped).toBe(1);
    expect(result.buckets[0]?.totals).toEqual(tokens);
    expect(result.buckets[0]?.serviceTierSource).toBe("userReported");
    expect(result.buckets[0]?.costUsd).toBeCloseTo(quota.rows[0]!.costUsd);
    expect(quota.rows[0]!.records).toBe(1);
  });
});
