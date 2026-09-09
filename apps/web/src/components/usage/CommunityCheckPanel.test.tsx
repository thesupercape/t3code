/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CommunityCheckState } from "@t3tools/contracts";
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { CommunityCheckResult } from "./CommunityCheckPanel";
const state: CommunityCheckState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};
const render = (current: CommunityCheckState) =>
  renderToStaticMarkup(
    <CommunityCheckResult
      state={current}
      label="Desktop"
      sending={false}
      unavailable={false}
      error={null}
      onStart={() => {}}
      onCancel={() => {}}
    />,
  );
describe("Luna community panel", () => {
  it("has its own action and running/cancel state", () => {
    expect(render(state)).toContain("Check community with Luna");
    expect(render({ ...state, status: "running" })).toContain("Cancel community check");
    expect(render({ ...state, status: "running" })).toContain("Luna is reading reset discussions");
  });
  it("renders linked reports with timestamps and partial-access warnings", () => {
    const html = render({
      ...state,
      status: "completed",
      finishedAt: "2026-08-31T02:00:00Z",
      result: {
        outcome: "found",
        coverage: "partial",
        summary: "People are asking about timing.",
        accessNote: "X current replies were blocked.",
        posts: [
          {
            url: "https://x.com/example/status/12345",
            author: "@example",
            publishedAt: "2026-08-31T01:00:00Z",
            access: "index",
            kind: "question",
            summary: "Asks when the reset will arrive.",
          },
        ],
      },
    });
    expect(html).toContain('href="https://x.com/example/status/12345"');
    expect(html).toContain("Question");
    expect(html).toContain("Latest X discussion not fully verified");
    expect(html).toContain("Saved snapshot, not a live feed");
    expect(html).toContain("Individual reports are not confirmation of your reset");
  });
  it("keeps failure and cancellation visible and permits a new check", () => {
    expect(render({ ...state, status: "failed", error: "Luna could not finish." })).toContain(
      "Luna could not finish.",
    );
    expect(render({ ...state, status: "cancelled" })).toContain("Community check cancelled.");
    expect(render({ ...state, status: "failed" })).toContain("Check community with Luna");
  });
});
