/** @vitest-environment happy-dom */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Button } from "../ui/button";
import { CompactTaskActions } from "./ChatHeader";
import { PanelLayoutControls } from "./PanelLayoutControls";

function HeaderInteractionHarness({
  onTaskActionsOpen,
  onToggleRightPanel,
}: {
  onTaskActionsOpen: () => void;
  onToggleRightPanel: () => void;
}) {
  const [taskActionsOpen, setTaskActionsOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  return (
    <header className="relative flex" data-chat-header>
      <CompactTaskActions
        open={taskActionsOpen}
        reservePanelControls={!rightPanelOpen}
        onOpenChange={(open) => {
          setTaskActionsOpen(open);
          if (open) onTaskActionsOpen();
        }}
      >
        <div aria-label="Task actions" role="group">
          <Button aria-label="Copy chat">Copy chat</Button>
          <Button>New task in Dev</Button>
          <Button>Open in editor</Button>
          <Button>Git actions</Button>
        </div>
      </CompactTaskActions>
      <div className="absolute right-3 z-50" data-workspace-titlebar-controls>
        <PanelLayoutControls
          terminalAvailable
          terminalOpen={false}
          terminalShortcutLabel={null}
          rightPanelAvailable
          rightPanelOpen={rightPanelOpen}
          rightPanelShortcutLabel={null}
          liveAgentCount={0}
          onToggleTerminal={() => {}}
          onToggleRightPanel={() => {
            onToggleRightPanel();
            setRightPanelOpen((open) => !open);
          }}
        />
      </div>
      {rightPanelOpen ? <div aria-label="Open a surface" role="dialog" /> : null}
    </header>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("compact header interaction boundary", () => {
  it("opens Task actions without dispatching the overlapping right-panel path", async () => {
    const onTaskActionsOpen = vi.fn();
    const onToggleRightPanel = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <HeaderInteractionHarness
          onTaskActionsOpen={onTaskActionsOpen}
          onToggleRightPanel={onToggleRightPanel}
        />,
      );
    });

    const taskActions = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Task actions"]',
    );
    expect(taskActions).not.toBeNull();
    await act(async () => taskActions?.click());

    expect(onTaskActionsOpen).toHaveBeenCalledTimes(1);
    expect(onToggleRightPanel).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Copy chat"]')).not.toBeNull();
    expect(document.body.textContent).toContain("New task in Dev");
    expect(document.body.textContent).toContain("Open in editor");
    expect(document.body.textContent).toContain("Git actions");
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });

  it("routes Toggle right panel only to its own callback", async () => {
    const onTaskActionsOpen = vi.fn();
    const onToggleRightPanel = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <HeaderInteractionHarness
          onTaskActionsOpen={onTaskActionsOpen}
          onToggleRightPanel={onToggleRightPanel}
        />,
      );
    });

    const rightPanel = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle right panel"]',
    );
    expect(rightPanel).not.toBeNull();
    await act(async () => rightPanel?.click());

    expect(onToggleRightPanel).toHaveBeenCalledTimes(1);
    expect(onTaskActionsOpen).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Copy chat"]')).toBeNull();
  });
});
