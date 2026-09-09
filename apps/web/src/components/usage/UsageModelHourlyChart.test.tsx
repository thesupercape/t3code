/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, beforeEach, afterEach, vi } from "vite-plus/test";
import type { HourlyTotals, HourlyModelTotals } from "@t3tools/shared/usageMerge";
import {
  collectHourlyModelKeys,
  modelDisplayName,
  UsageModelHourlyChart,
} from "./UsageModelHourlyChart";

type ModelInput = [
  key: string,
  model: string,
  provider: HourlyModelTotals["provider"],
  costUsd: number,
  totalTokens: number,
];

const hour = (start: string, models: ModelInput[]): HourlyTotals => ({
  day: start.slice(0, 10),
  hourStart: start,
  costUsd: models.reduce((sum, item) => sum + item[3], 0),
  totalTokens: models.reduce((sum, item) => sum + item[4], 0),
  byProvider: new Map(),
  byModel: new Map(
    models.map(([key, model, provider, costUsd, totalTokens]) => [
      key,
      { model, provider, costUsd, totalTokens, records: 1 },
    ]),
  ),
});

describe("UsageModelHourlyChart", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps model keys provider-qualified and labels known models", () => {
    const values = [
      hour("2026-08-11T10:00:00.000Z", [
        ["codex:gpt-5.6-luna", "gpt-5.6-luna", "codex", 1, 100],
        ["claude:gpt-5.6-luna", "gpt-5.6-luna", "claude", 2, 200],
      ]),
    ];
    expect(collectHourlyModelKeys(values)).toEqual(["claude:gpt-5.6-luna", "codex:gpt-5.6-luna"]);
    expect(
      modelDisplayName("codex:gpt-5.6-luna", values[0]!.byModel.get("codex:gpt-5.6-luna")),
    ).toBe("codex · Luna");
    expect(
      modelDisplayName("claude:gpt-5.6-luna", values[0]!.byModel.get("claude:gpt-5.6-luna")),
    ).toBe("claude · Luna");
  });

  it("updates the selected-hour model token and cost readout through the select", async () => {
    const starts = [
      "2026-08-11T10:00:00.000Z",
      "2026-08-11T11:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
    ];
    const hourly = [
      hour(starts[0]!, [["codex:gpt-5.6-astra", "gpt-5.6-astra", "codex", 1.25, 1200]]),
      hour(starts[1]!, []),
      hour(starts[2]!, [
        ["codex:gpt-5.6-sol", "gpt-5.6-sol", "codex", 4.5, 3400],
        ["claude:gpt-5.6-sol", "gpt-5.6-sol", "claude", 2.25, 600],
      ]),
    ];
    await act(async () =>
      root.render(<UsageModelHourlyChart hours={starts} hourly={hourly} timeZone="UTC" />),
    );
    const readout = () =>
      container.querySelector<HTMLElement>('[aria-label="Usage for selected hour"]')!;
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Inspect hourly model usage"]',
    )!;
    expect(select.options).toHaveLength(3);
    expect(readout().textContent).toContain("codex · Sol");
    expect(readout().textContent).toContain("3.40K tokens · $4.50");
    expect(readout().textContent).toContain("claude · Sol");
    expect(readout().textContent).toContain("600 tokens · $2.25");
    await act(async () => {
      select.value = "0";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(readout().textContent).toContain("codex · Astra");
    expect(readout().textContent).toContain("1.20K tokens · $1.25");
    expect(readout().textContent).not.toContain("gpt-5.6-sol");
  });

  it("preserves zero activity hours and shows a clear no-usage state", async () => {
    const starts = [
      "2026-08-11T10:00:00.000Z",
      "2026-08-11T11:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
    ];
    await act(async () =>
      root.render(
        <UsageModelHourlyChart
          hours={starts}
          hourly={[hour(starts[0]!, [["codex:gpt-5.6-astra", "gpt-5.6-astra", "codex", 1, 100]])]}
          timeZone="UTC"
        />,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Inspect hourly model usage"]',
    )!;
    expect(select.options).toHaveLength(3);
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container.querySelector('[aria-label="Usage for selected hour"]')?.textContent,
    ).toContain("No model usage recorded for this hour.");
  });

  it("selects an hour and model from focused or clicked chart marks", async () => {
    const starts = ["2026-08-11T10:00:00.000Z", "2026-08-11T11:00:00.000Z"];
    const hourly = [
      hour(starts[0]!, [["codex:gpt-5.6-astra", "gpt-5.6-astra", "codex", 1.25, 1200]]),
      hour(starts[1]!, [["codex:gpt-5.6-sol", "gpt-5.6-sol", "codex", 4.5, 3400]]),
    ];
    await act(async () =>
      root.render(<UsageModelHourlyChart hours={starts} hourly={hourly} timeZone="UTC" />),
    );
    const marks = container.querySelectorAll<SVGRectElement>('rect[role="button"]');
    expect(marks).toHaveLength(4);
    await act(async () => marks[0]!.focus());
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Astra");
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("1.20K tokens");
    await act(async () => marks[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Sol");
    await act(async () =>
      marks[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Astra");
  });
});
