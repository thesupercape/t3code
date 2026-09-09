import { describe, expect, it } from "vite-plus/test";
import type { UsageTokenTotals } from "@t3tools/contracts";

import { cacheSavingsUsd, lookupRate, parseRateTable, priceUsage } from "./usagePricing.ts";

const tokens: UsageTokenTotals = {
  uncachedInputTokens: 100,
  cachedInputTokens: 1_000,
  cacheCreationTokens: 10,
  outputTokens: 50,
  reasoningTokens: 30,
};
const opus = {
  input_cost_per_token: 5e-6,
  output_cost_per_token: 25e-6,
  cache_read_input_token_cost: 0.5e-6,
  cache_creation_input_token_cost: 6.25e-6,
};

describe("usage pricing", () => {
  it("uses stable-family rates for documented Gemini preview IDs", () => {
    const rate = {
      inputCostPerToken: 1.25e-6,
      outputCostPerToken: 10e-6,
      cacheReadCostPerToken: 0.125e-6,
      cacheCreationCostPerToken: null,
    };
    const table = new Map([["gemini/gemini-2.5-pro", rate]]);

    expect(lookupRate(table, "gemini-2.5-pro-preview-05-06")).toBe(rate);
  });

  it.each([false, true])("keeps reseller prices independent of document order (%s)", (reverse) => {
    const entries = [
      ["claude-opus-5", opus],
      [
        "deepinfra/anthropic/claude-opus-5",
        { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
      ],
    ];
    const rates = parseRateTable(Object.fromEntries(reverse ? entries.toReversed() : entries));
    expect(priceUsage(rates, " CLAUDE-OPUS-5 ", tokens, null).costUsd).toBeCloseTo(0.0023125);
    expect(cacheSavingsUsd(rates, "claude-opus-5", tokens)).toBeCloseTo(0.0045);
    expect(priceUsage(rates, "deepinfra/anthropic/claude-opus-5", tokens, null).costSource).toBe(
      "unpriced",
    );
  });

  it("only aliases recognized first-party model namespaces", () => {
    const rates = parseRateTable({ "claude-opus-5": opus, "gemini/gemini-2.5-pro": opus });
    expect(lookupRate(rates, "anthropic/claude-opus-5")).toEqual(
      lookupRate(rates, "claude-opus-5"),
    );
    expect(lookupRate(rates, "google/gemini-2.5-pro")).toEqual(lookupRate(rates, "gemini-2.5-pro"));
    expect(lookupRate(rates, "local-router/claude-opus-5")).toBeNull();
    expect(lookupRate(rates, "openrouter/anthropic/claude-opus-5")).toBeNull();
  });

  it("prefers an exact provider price to its bare alias", () => {
    const rates = parseRateTable({
      "claude-opus-5": opus,
      "anthropic/claude-opus-5": { ...opus, input_cost_per_token: 8e-6 },
    });
    expect(lookupRate(rates, "anthropic/claude-opus-5")?.inputCostPerToken).toBe(8e-6);
  });

  it.each([200, 272])(
    "applies the %sk context tier only above the request threshold",
    (threshold) => {
      const rates = parseRateTable({
        model: {
          ...opus,
          [`input_cost_per_token_above_${threshold}k_tokens`]: 10e-6,
          [`output_cost_per_token_above_${threshold}k_tokens`]: 40e-6,
          [`cache_read_input_token_cost_above_${threshold}k_tokens`]: 1e-6,
        },
      });
      const base = {
        ...tokens,
        uncachedInputTokens: threshold * 1_000 - 1_000,
        cacheCreationTokens: 0,
      };
      expect(priceUsage(rates, "model", base, null).costUsd).toBeCloseTo(
        base.uncachedInputTokens * 5e-6 + 0.0005 + 0.00125,
      );
      expect(
        priceUsage(
          rates,
          "model",
          { ...base, uncachedInputTokens: base.uncachedInputTokens + 1 },
          null,
        ).costUsd,
      ).toBeCloseTo((base.uncachedInputTokens + 1) * 10e-6 + 0.001 + 0.002);
    },
  );

  it("does not guess missing cache rates or require rates for unused token categories", () => {
    const rates = parseRateTable({
      model: { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
    });
    expect(priceUsage(rates, "model", tokens, null).costSource).toBe("unpriced");
    expect(
      priceUsage(rates, "model", { ...tokens, cachedInputTokens: 0, cacheCreationTokens: 0 }, null)
        .costSource,
    ).toBe("modelPriced");
    expect(cacheSavingsUsd(rates, "model", tokens)).toBe(0);
  });

  it("supports the catalogue's cache-hit spelling without borrowing another provider's rate", () => {
    const rates = parseRateTable({
      model: {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        input_cost_per_token_cache_hit: 0.5e-6,
      },
    });
    expect(
      priceUsage(rates, "model", { ...tokens, cacheCreationTokens: 0 }, null).costUsd,
    ).toBeCloseTo(0.00225);
  });

  it("uses nonnegative reported cost once, including an explicit zero", () => {
    const rates = parseRateTable({ model: opus });
    expect(priceUsage(rates, "model", tokens, 0)).toEqual({
      costUsd: 0,
      costSource: "providerReported",
    });
    expect(priceUsage(rates, "model", tokens, 42)).toEqual({
      costUsd: 42,
      costSource: "providerReported",
    });
    expect(priceUsage(rates, "model", tokens, -1).costSource).toBe("modelPriced");
    expect(priceUsage(rates, "model", tokens, Infinity).costSource).toBe("modelPriced");
  });

  it("rejects invalid rates and leaves unknown models unpriced", () => {
    const rates = parseRateTable({
      model: { ...opus, input_cost_per_token: -1 },
      other: { ...opus, output_cost_per_token: Infinity },
    });
    expect(rates.size).toBe(0);
    expect(priceUsage(rates, "gpt-5.3-codex-spark", tokens, null).costSource).toBe("unpriced");
  });
});
