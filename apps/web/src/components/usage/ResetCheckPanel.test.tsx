import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ResetCheckState } from "@t3tools/contracts";
import { resetCheckPresentation } from "@t3tools/client-runtime/resetCheckPresentation";
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { ResetCheckResult } from "./ResetCheckPanel";

const idle: ResetCheckState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};
const render = (state: ResetCheckState) =>
  renderToStaticMarkup(
    <ResetCheckResult
      state={state}
      presentation={resetCheckPresentation(state)}
      label="Desktop"
      sending={false}
      unavailable={false}
      error={null}
      onStart={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
describe("reset check UI", () => {
  it("has an obvious action and says checks consume Codex usage", () => {
    expect(render(idle)).toContain("Check X with Luna");
    expect(render(idle)).toContain("Uses Codex allowance");
  });
  it("shows a running status with Cancel, not a fabricated progress percent", () => {
    const html = render({ ...idle, status: "running" });
    expect(html).toContain("Luna is checking X");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Check X with Luna");
  });
  it("shows uncertainty and explicitly discloses unverified latest posts", () => {
    const html = render({
      ...idle,
      status: "completed",
      finishedAt: "2026-08-30T23:00:00Z",
      result: {
        outcome: "possible",
        confidence: "medium",
        summary: "A reset may be coming.",
        confidenceReason: "Pacific time is ambiguous.",
        latestPostsVerified: false,
        accessNote: "X blocked access; an archived copy was used.",
        earliestAt: "2026-08-31T01:00:00Z",
        latestAt: "2026-08-31T02:00:00Z",
        likelyAt: "2026-08-31T01:00:00Z",
        sources: [
          { url: "https://x.com/thsottiaux/status/123", publishedAt: null, access: "index" },
        ],
      },
    });
    expect(html).toContain("Medium confidence");
    expect(html).toContain("Latest X feed not verified");
    expect(html).toContain("Sources and reasoning");
    expect(html).toContain("<details>");
    expect(html).toContain("Most likely");
    expect(html).toContain(" to ");
    expect(html).toContain('href="https://x.com/thsottiaux/status/123"');
  });
});
