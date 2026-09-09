import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      typeof initial === "function"
        ? {
            days: 1,
            window: {
              sinceDay: "2026-08-10",
              untilDay: "2026-08-11",
              timeZone: "UTC",
              resolution: "hour",
              sinceTime: "2026-08-10T12:37:00.000Z",
              untilTime: "2026-08-11T12:37:00.000Z",
            },
          }
        : initial === "model"
          ? "time"
          : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({ Link: "a", useNavigate: () => vi.fn() }));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      ...Object.fromEntries(
        Object.entries(actual.PROVIDER_PRESENTATION).map(([id, presentation]) => [
          id,
          { ...presentation, mark: "span" },
        ]),
      ),
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";
import usagePageSource from "./UsagePage.tsx?raw";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
          byModel: new Map([
            [
              "codex:gpt-5.6-luna",
              {
                model: "gpt-5.6-luna",
                provider: "codex",
                costUsd: 7,
                totalTokens: 7_000,
                records: 1,
              },
            ],
          ]),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
          byModel: new Map([
            [
              "codex:gpt-5.6-sol",
              {
                model: "gpt-5.6-sol",
                provider: "codex",
                costUsd: 6,
                totalTokens: 6_000,
                records: 1,
              },
            ],
          ]),
        },
      ],
    },
    environments: [],
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage hourly breakdown", () => {
  it("distinguishes API Fast Mode estimates, user corrections and unknown history", () => {
    const view = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...view,
      merged: {
        ...view.merged,
        codexServiceTiers: {
          fastCostUsd: 24,
          fastRecords: 9,
          userReportedRecords: 3,
          unknownRecords: 7,
        },
      },
    });
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup).toContain('aria-label="Codex Fast Mode accounting"');
    expect(markup).toContain("$24.00");
    expect(markup).toContain("3 responses use a user-reported Fast Mode window");
    expect(markup).toContain("7 Codex responses have no speed metadata");
    expect(markup).toContain("2.5× Codex credits");
  });
  it("makes only Codex's provider row open its usage and reset details", () => {
    const view = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...view,
      merged: {
        ...view.merged,
        providers: ["codex", "claude"].map((provider) => ({
          provider,
          costUsd: 10,
          totalTokens: 1000,
          records: 1,
          sessions: 1,
          costShare: 0.5,
          tokenShare: 0.5,
        })),
      },
    });
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup.match(/aria-label="Open Codex usage and resets"/g)).toHaveLength(1);
    expect(markup).toContain("Usage &amp; resets");
    expect(markup).toContain("Claude Code");
    expect(markup).not.toContain('aria-label="Open Claude');
  });
  it("keeps Codex reset history reachable while usage is loading", () => {
    testState.useUsage.mockReturnValue({ ...testState.useUsage(), isPending: true });
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup).toContain('to="/usage-resets"');
    expect(markup).toContain("Codex usage &amp; resets");
  });

  it("shows completed totals while another environment is still scanning", () => {
    const view = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...view,
      environments: [
        {
          environmentId: "desktop",
          label: "Desktop",
          isPending: false,
          error: null,
          summary: { sources: [] },
        },
        { environmentId: "laptop", label: "Laptop", isPending: true, error: null, summary: null },
      ],
      isPending: false,
      isPartial: true,
    });

    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup).toContain("Totals");
    expect(markup).toContain("Laptop is still scanning usage.");
  });

  it("does not present an all-failed window as zero activity", () => {
    const view = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...view,
      environments: [
        {
          environmentId: "desktop",
          label: "Desktop",
          isPending: false,
          error: "This environment could not report usage.",
          summary: null,
        },
      ],
      isPending: false,
      isPartial: false,
      merged: { ...view.merged, daily: [], models: [], sessions: 0, costUsd: 0 },
    });
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Desktop could not report usage.");
    expect(markup).not.toContain("0 sessions");
    expect(markup).not.toContain("No activity in this window.");
  });

  it("warns that missing prices are not free usage", () => {
    const view = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...view,
      merged: { ...view.merged, costQuality: { ...view.merged.costQuality, unpricedShare: 0.01 } },
    });
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup).toContain("Some usage is unpriced and excluded from dollar totals");
    expect(markup).toContain("not mean that usage was free");
  });
  it("keeps recent activity visible first without empty hourly rows", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body).toContain("$11.00");
    expect(body).toContain("$13.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });
});

describe("UsagePage mobile range controls", () => {
  it("keeps every range, including one year, in the compact period selector", () => {
    expect(usagePageSource).toContain('{ days: 365, label: "1 year" }');
    expect(usagePageSource).toContain('aria-label="Usage period"');
    expect(usagePageSource).toContain("WINDOW_OPTIONS.map((option)");
  });
});
