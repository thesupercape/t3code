/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { TokenBudgetPanel } from "./TokenBudgetPanel";

it("lets a user compare output and Fast-mode budgets without inventing an observed mix", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TokenBudgetPanel budgetUsd={1200} models={null} observedAt="2026-09-05T06:00:00Z" />,
      ),
    );
    expect(container.textContent).toContain("Exact model totals are not available");
    expect(container.textContent).not.toContain("1.00B");
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "output";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const luna = [...container.querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("Luna"),
    )!;
    expect(luna.textContent).toContain("1.00B");
    const fast = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    await act(async () => fast.click());
    expect(luna.textContent).toContain("500.00M");
    await act(async () => {
      select.value = "custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Output share"]')).not.toBeNull();
    expect(container.textContent).toContain("Custom mix");
  } finally {
    await act(async () => root.unmount());
  }
});
