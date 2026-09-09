import { describe, expect, it } from "vite-plus/test";

import {
  hasNewCodexActivity,
  mergeLatestCodexMessages,
  mergeOlderCodexMessages,
  resolveCodexSelectedThreadId,
  shouldApplyCodexResult,
  shouldPollCodexThread,
} from "./CodexChatsView.logic";

const thread = (id: string) => ({
  id,
  title: id,
  updatedAt: "2026-09-07T12:00:00.000Z",
  preview: null,
  cwd: null,
  status: "unknown" as const,
});

const message = (id: string) => ({
  id,
  role: "assistant" as const,
  text: id,
  createdAt: null,
  tool: null,
});

describe("Codex chats view state", () => {
  it("keeps a deep-linked thread selected when it is outside the first page", () => {
    expect(
      resolveCodexSelectedThreadId({
        currentId: null,
        requestedId: "thread-on-next-page",
        threads: [thread("thread-on-first-page")],
      }),
    ).toBe("thread-on-next-page");
  });

  it("prepends older history without duplicating boundary messages", () => {
    expect(mergeOlderCodexMessages([message("new")], [message("old"), message("new")])).toEqual([
      message("old"),
      message("new"),
    ]);
  });

  it("refreshes the latest history while retaining already loaded older messages", () => {
    expect(
      mergeLatestCodexMessages(
        [message("old"), message("latest")],
        [message("latest"), message("new")],
      ),
    ).toEqual([message("old"), message("latest"), message("new")]);
  });

  it("waits for native activity instead of treating the echoed user message as a reply", () => {
    expect(
      hasNewCodexActivity([message("old")], [{ ...message("user"), role: "user" as const }]),
    ).toBe(false);
    expect(hasNewCodexActivity([message("old")], [message("reply")])).toBe(true);
  });

  it("rejects results for a changed thread or generation", () => {
    expect(
      shouldApplyCodexResult({
        currentThreadId: "thread-2",
        resultThreadId: "thread-1",
        currentGeneration: 2,
        resultGeneration: 1,
      }),
    ).toBe(false);
    expect(
      shouldApplyCodexResult({
        currentThreadId: "thread-1",
        resultThreadId: "thread-1",
        currentGeneration: 2,
        resultGeneration: 1,
      }),
    ).toBe(false);
  });

  it("polls the selected native thread only while it is active", () => {
    expect(shouldPollCodexThread("active")).toBe(true);
    expect(shouldPollCodexThread("idle")).toBe(false);
    expect(shouldPollCodexThread("needs_attention")).toBe(false);
  });
});
