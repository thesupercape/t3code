/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { UsagePaceChart } from "./UsagePaceChart";

afterEach(() => vi.restoreAllMocks());
describe("weekly pace chart", () => {
  const samples = [
    {
      observedAt: "2026-08-31T00:00:00.000Z",
      remainingPercent: 80,
      resetsAt: "2026-09-06T00:00:00.000Z",
    },
  ];
  it("renders quota, target, projection and time without transcript costs", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(samples[0]!.observedAt));
    const markup = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(markup).toContain("80%");
    expect(markup).toContain("Pace to reset");
    expect(markup).toContain("used this cycle");
    expect(markup).toContain("Runs out before reset");
    expect(markup).toContain("Updated");
    expect(markup).toContain("4d 0h");
    expect(markup).toContain("Codex remaining usage and pace to next reset");
    expect(markup).not.toContain("Unavailable");
  });
  it("does not show a stale reading as a live forecast", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(samples[0]!.observedAt) + 16 * 60_000);
    const markup = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(markup).toContain("Reading is stale");
    expect(markup).toContain("Last run-out estimate");
    expect(markup).not.toContain("4d 0h at this pace");
  });
  it("accepts a new reading between clock ticks without a stale warning", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const started = Date.parse(samples[0]!.observedAt);
    vi.setSystemTime(started);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsagePaceChart samples={samples} />));
      vi.setSystemTime(started + 20_000);
      const refreshed = [
        ...samples,
        { ...samples[0]!, observedAt: new Date(Date.now()).toISOString(), remainingPercent: 79 },
      ];
      await act(async () => root.render(<UsagePaceChart samples={refreshed} />));
      expect(container.textContent).toContain("79%");
      expect(container.textContent).toContain("Updated");
      expect(container.textContent).not.toContain("Reading is stale");
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("uses an announced deadline without claiming usage was reset", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(samples[0]!.observedAt));
    const markup = renderToStaticMarkup(
      <UsagePaceChart
        samples={samples}
        news={{
          status: "ready",
          checkedAt: Date.now(),
          announcement: {
            publishedAt: "2026-08-30T20:00:00Z",
            targetAt: "2026-08-31T01:00:00Z",
            validUntil: "2026-08-31T00:30:00Z",
            sourceUrl: "https://x.com/thsottiaux/status/2094144275957350900",
            quote: "Codex reset at 6pm PST",
          },
        }}
      />,
    );
    expect(markup).toContain("Announced reset");
    expect(markup).toContain("80%");
    expect(markup).toContain("20%");
    expect(markup).toContain("77.0");
    expect(markup).toContain("Account weekly timer");
    expect(markup).toContain("not account confirmation");
    expect(markup).toContain('href="https://x.com/thsottiaux/status/2094144275957350900"');
  });
  it("shows an API-cost switch and explains why incomplete or stale data cannot project", () => {
    const at = Date.parse(samples[0]!.observedAt);
    vi.spyOn(Date, "now").mockReturnValue(at);
    const sparse = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(sparse).toContain('aria-label="Show API cost pace"');
    expect(sparse).toContain("complete, priced costs");
    expect(sparse).not.toContain('aria-label="API cost projection"');
    vi.spyOn(Date, "now").mockReturnValue(at + 16 * 60_000);
    const stale = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(stale).toContain("API cost pace needs a fresh account reading.");
  });
  it("lets the user hide and restore the API projection without changing recorded usage", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const at = Date.parse(samples[0]!.observedAt);
    vi.spyOn(Date, "now").mockReturnValue(at);
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...samples[0]!,
      observedAt: new Date(at - (6 - index) * 3_600_000).toISOString(),
      remainingPercent: [83, 82, 81, 81, 81, 81, 81][index]!,
    }));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <UsagePaceChart
            samples={rows}
            apiPace={{
              interval: {
                id: "pace",
                sinceTime: rows[0]!.observedAt,
                untilTime: rows.at(-1)!.observedAt,
              },
              remainingValueUsd: 50,
              models: [
                {
                  model: "gpt-5.6-luna",
                  costUsd: 60,
                  unpricedRecords: 0,
                  totals: {
                    uncachedInputTokens: 0,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 50e6,
                    reasoningTokens: 0,
                  },
                },
              ],
            }}
            manualResets={{ availableCount: 3, verified: true }}
          />,
        ),
      );
      const toggle = container.querySelector<HTMLInputElement>(
        'input[aria-label="Show API cost pace"]',
      )!;
      expect(toggle.checked).toBe(true);
      expect(container.querySelector('[aria-label="API cost projection"]')).not.toBeNull();
      expect(container.textContent).toContain("$10.00/hour over the last 6.0 hours");
      expect(container.textContent).toContain("Empty in 5h 0m");
      expect(container.textContent).toContain("81%");
      expect(container.textContent).toContain("Banked manual resets");
      expect(container.textContent).toContain("3 available");
      await act(async () => toggle.click());
      expect(toggle.checked).toBe(false);
      expect(container.querySelector('[aria-label="API cost projection"]')).toBeNull();
      expect(container.textContent).toContain("81%");
      await act(async () => toggle.click());
      expect(container.querySelector('[aria-label="API cost projection"]')).not.toBeNull();
      const recorded = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Recorded",
      )!;
      await act(async () => recorded.click());
      expect(container.querySelector('[aria-label="API cost projection"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("uses time-positioned future hit testing and returns to recorded values with keyboard", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const at = Date.parse("2026-08-31T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(at + 30 * 60_000);
    const rows = [
      {
        ...samples[0]!,
        observedAt: new Date(at - 6 * 3_600_000).toISOString(),
        remainingPercent: 90,
      },
      {
        ...samples[0]!,
        observedAt: new Date(at - 30 * 60_000).toISOString(),
        remainingPercent: 80,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsagePaceChart samples={rows} />));
      const plot = container.querySelector("svg")!;
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 200,
        right: 100,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      await act(async () =>
        plot.dispatchEvent(new MouseEvent("mousemove", { clientX: 95, bubbles: true })),
      );
      const tooltip = container.querySelector('[role="status"].pointer-events-none')!;
      expect(tooltip.textContent).toContain("Projection");
      expect(container.textContent).toContain("target");
      await act(async () =>
        plot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
      );
      expect(tooltip.textContent).toContain("Recorded");
      expect(tooltip.textContent).not.toContain("Projection");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
