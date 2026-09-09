import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRenameCommit, shouldShowOpenInPicker } from "./ChatHeader";
import chatHeaderSource from "./ChatHeader.tsx?raw";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});

describe("compact task header", () => {
  const source = chatHeaderSource;

  it("uses one ellipsized title and project context row at narrow widths", () => {
    expect(source).toContain("data-mobile-chat-header-context");
    expect(source).toContain("@xl/header-actions:hidden");
    expect(source).toContain('className="min-w-0 flex-1 truncate text-sm font-medium"');
    expect(source).toContain("`${activeProjectName} / `");
  });

  it("relocates desktop actions behind one accessible 44px overflow control", () => {
    expect(source).toContain('aria-label="Task actions"');
    expect(source).toContain("data-mobile-header-overflow");
    expect(source).toContain('className="size-11"');
    expect(source).toContain(
      '"hidden shrink-0 items-center justify-end gap-2 @xl/header-actions:flex @3xl/header-actions:gap-3"',
    );
  });

  it("keeps every existing action family in the compact overflow surface", () => {
    const mobileStart = source.lastIndexOf("<CompactTaskActions");
    const mobileActions = source.slice(
      mobileStart,
      source.indexOf("data-chat-header-actions", mobileStart),
    );

    expect(mobileActions).toContain("Copy chat");
    expect(mobileActions).toContain("ProjectScriptsControl");
    expect(mobileActions).toContain("OpenInPicker");
    expect(mobileActions).toContain("GitActionsControl");
    expect(mobileActions).toContain("onNewThreadInProject");
    expect(mobileActions).toContain("min-h-11");
  });

  it("keeps compact and desktop controls mutually exclusive at the same breakpoint", () => {
    expect(source.match(/data-mobile-chat-header-actions/g)).toHaveLength(1);
    expect(source.match(/data-chat-header-actions/g)).toHaveLength(2);
    expect(source).toContain('"no-drag relative flex shrink-0 @xl/header-actions:hidden"');
    expect(source).toContain('reservePanelControls ? "mr-[4.5rem]" : "mr-0"');
    expect(source).toContain("@xl/header-actions:flex");
  });

  it("keeps the compact layout active at every supported phone width", () => {
    for (const width of [320, 375, 390, 430]) {
      expect(width).toBeLessThan(576);
    }
    expect(source).toContain("@xl/header-actions:hidden");
    expect(source).toContain("min-w-0 flex-1 truncate");
  });
});
