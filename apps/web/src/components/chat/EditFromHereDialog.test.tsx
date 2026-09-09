import { describe, expect, it } from "vite-plus/test";

import dialogSource from "./EditFromHereDialog.tsx?raw";

describe("EditFromHereDialog", () => {
  it("offers branch as the default, rewind with an explicit truncation warning, and cancel", () => {
    expect(dialogSource).toContain("Start new task");
    expect(dialogSource).toContain('onClick={() => submit("branch")}');
    expect(dialogSource).toContain("autoFocus");
    expect(dialogSource).toContain("Rewind current task");
    expect(dialogSource).toContain('onClick={() => submit("rewind")}');
    expect(dialogSource).toContain("removes the selected original message and all later messages");
    expect(dialogSource).toContain("<DialogClose");
    expect(dialogSource).toContain("Cancel");
    expect(dialogSource).toContain("Waiting for the server to accept this edit…");
    expect(dialogSource).toContain('submitting ? "Close" : "Cancel"');
    expect(dialogSource).not.toContain("!submitting && onOpenChange");
  });

  it("keeps all choices keyboard and touch accessible on compact screens", () => {
    expect(dialogSource.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(3);
    expect(dialogSource).toContain('aria-label="Edited message"');
    expect(dialogSource).toContain("disabled={!trimmedText || submitting}");
    expect(dialogSource).toContain('aria-live="polite"');
  });
});
