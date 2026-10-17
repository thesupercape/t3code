import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/threads", () => ({ threadEnvironment: { steerTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { SteerTurnDialog } from "./SteerTurnDialog";

const input = {
  environmentId: EnvironmentId.make("synthetic-environment"),
  threadId: ThreadId.make("synthetic-thread"),
  activeTurnId: null,
  canSteer: true,
  disabled: false,
};

describe("explicit steering availability", () => {
  it("offers provider-resolved steering without a projected active turn ID", () => {
    expect(renderToStaticMarkup(createElement(SteerTurnDialog, input))).toContain(
      "Steer active turn",
    );
  });

  it("does not offer steering without a bound Codex session", () => {
    expect(
      renderToStaticMarkup(createElement(SteerTurnDialog, { ...input, canSteer: false })),
    ).not.toContain("Steer active turn");
  });

  it("preserves the disconnected or editing gate", () => {
    const html = renderToStaticMarkup(createElement(SteerTurnDialog, { ...input, disabled: true }));
    expect(html).toContain("disabled");
  });
});
