import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { UsageQuotaCharts } from "./UsageQuotaCharts";

describe("quota history charts", () => {
  it("does not invent a graph when observations are missing", () => {
    expect(renderToStaticMarkup(<UsageQuotaCharts samples={[]} values={[]} />)).toBe("");
  });
  it("supports one observation without a false timeline or invalid coordinates", () => {
    const markup = renderToStaticMarkup(
      <UsageQuotaCharts
        samples={[
          {
            observedAt: "2026-07-22T17:00:00Z",
            remainingPercent: 82,
            resetsAt: "2026-07-28T17:00:00Z",
          },
        ]}
        values={[]}
      />,
    );
    expect(markup).toContain("82% remaining");
    expect(markup).toContain('role="img"');
    expect(markup).toContain('max="0"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
  });
});
