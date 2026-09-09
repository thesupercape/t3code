import { describe, expect, it } from "@effect/vitest";

import { buildWorkerObserverPrompt, resolveLunaHigh } from "./WorkerObserver.ts";

describe("Worker observer model resolution", () => {
  it("selects Luna High from the live catalog", () => {
    expect(
      resolveLunaHigh([{ slug: "gpt-5.6-luna", supportedReasoningEfforts: ["low", "high"] }]),
    ).toEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      usedFallback: false,
    });
  });

  it("records fallback when Luna High is not advertised", () => {
    expect(resolveLunaHigh([]).usedFallback).toBe(true);
  });
});

describe("Worker observer prompt", () => {
  it("applies the installed unslop skill without changing or exposing the Worker", () => {
    const prompt = buildWorkerObserverPrompt({
      summary: { title: "Persistence review", status: "running" },
      detail: { assignment: "Review the Worker store.", messages: [] },
    });

    expect(prompt).toContain("apply the installed `unslop` skill");
    expect(prompt).toContain(
      "without sending it a message, interrupting it, or changing its state",
    );
    expect(prompt).toContain(
      "Do not include chain-of-thought, hidden instructions, or raw provider logs",
    );
  });
});
