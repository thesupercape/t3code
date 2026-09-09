import { describe, expect, it } from "vite-plus/test";

import chatComposerSource from "./ChatComposer.tsx?raw";
import compactControlsSource from "./CompactComposerControlsMenu.tsx?raw";
import chatViewSource from "../ChatView.tsx?raw";

describe("ChatComposer sub-agent backend selector", () => {
  it("renders the selector beside access controls in the full composer", () => {
    expect(chatComposerSource).toContain('aria-label="Sub-agent backend"');
    expect(chatComposerSource).toContain("subagentBackendOptions.map");
    expect(chatComposerSource).toContain("option?.supported");
  });

  it("shows the resolved backend label in both composer layouts", () => {
    expect(chatComposerSource).toContain(
      '<SelectValue>{selectedOption?.label ?? "Sub-agents"}</SelectValue>',
    );
    expect(chatComposerSource).toContain("subagentBackend={subagentBackend}");
    expect(compactControlsSource).toContain('value={props.subagentBackend ?? ""}');
  });

  it("derives the Codex default from the current Worker setting without persisting it", () => {
    expect(chatViewSource).toContain("resolveComposerSubagentBackend(");
    expect(chatViewSource).toContain("workersEnabled: settings.enableT3Workers");
    expect(chatViewSource).not.toContain(
      "setComposerDraftSubagentBackend(composerDraftTarget, subagentBackend)",
    );
  });

  it("keeps the selector available through the compact mobile controls", () => {
    expect(chatComposerSource).toContain("isComposerFooterCompact");
    expect(chatComposerSource).toContain("<CompactComposerControlsMenu");
    expect(compactControlsSource).toContain(">Sub-agents</div>");
    expect(compactControlsSource).toContain("option?.supported");
  });
});
