import { describe, expect, it } from "vite-plus/test";
import { makeCodexFileChangeApprovalContext } from "./CodexFileChangeApprovalContext.ts";

const identity = { threadId: "provider-thread", turnId: "turn-1", itemId: "patch-1" };
const changes = [{ path: "a.ts", kind: { type: "add" as const }, diff: "+hello" }];

describe("Codex file-change approval context", () => {
  it("requires the complete identity and consumes a matching item once", () => {
    const context = makeCodexFileChangeApprovalContext();
    context.remember(identity, changes);
    for (const field of ["threadId", "turnId", "itemId"] as const) {
      expect(context.take({ ...identity, [field]: "different" })).toBeUndefined();
    }
    expect(context.take(identity)).toContain("ADD a.ts\n\nChange 1 diff:\n+hello");
    expect(context.take(identity)).toBeUndefined();
  });

  it("does not borrow context for a request arriving before its item", () => {
    const context = makeCodexFileChangeApprovalContext();
    expect(context.take(identity)).toBeUndefined();
    context.remember(identity, changes);
    expect(context.take(identity)).toContain("a.ts");
  });

  it("keeps the latest 32 items and replaces repeated item starts", () => {
    const context = makeCodexFileChangeApprovalContext();
    for (let index = 0; index < 33; index++)
      context.remember({ ...identity, itemId: `patch-${index}` }, changes);
    expect(context.take({ ...identity, itemId: "patch-0" })).toBeUndefined();
    context.remember(identity, [{ ...changes[0]!, diff: "+updated" }]);
    expect(context.take(identity)).toContain("+updated");
    expect(context.take({ ...identity, itemId: "patch-32" })).toContain("a.ts");
  });

  it("cleans completed item, turn, and thread scopes without clearing another thread", () => {
    for (const scope of [
      identity,
      { threadId: identity.threadId, turnId: identity.turnId },
      { threadId: identity.threadId },
    ]) {
      const context = makeCodexFileChangeApprovalContext();
      context.remember(identity, changes);
      context.remember({ ...identity, threadId: "other" }, changes);
      context.discard(scope);
      expect(context.take(identity)).toBeUndefined();
      expect(context.take({ ...identity, threadId: "other" })).toContain("a.ts");
    }
  });

  it("bounds previews with an explicit warning and lists scope before long diffs", () => {
    const context = makeCodexFileChangeApprovalContext();
    context.remember(identity, [
      { ...changes[0]!, diff: "x".repeat(100_000) },
      { path: "deleted.ts", kind: { type: "delete" }, diff: "-deleted" },
    ]);
    const detail = context.take(identity)!;
    expect(detail.length).toBeLessThanOrEqual(64_000);
    expect(detail).toContain("2 proposed file changes:\nADD a.ts\nDELETE deleted.ts");
    expect(detail).toContain(
      "Preview truncated. Review the complete file-change item before approving.",
    );
  });

  it("clears context when a session closes", () => {
    const context = makeCodexFileChangeApprovalContext();
    context.remember(identity, changes);
    context.clear();
    expect(context.take(identity)).toBeUndefined();
  });
});
