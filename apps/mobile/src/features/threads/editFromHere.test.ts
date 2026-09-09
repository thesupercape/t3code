import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import {
  buildEditFromHereInput,
  isEditFromHereBlocked,
  resolveEditFromHereNavigation,
} from "./editFromHere";

const environmentId = EnvironmentId.make("environment-1");
const currentThreadId = ThreadId.make("thread-current");
const sourceMessageId = MessageId.make("message-source");
const replacementMessageId = MessageId.make("message-replacement");
const targetThreadId = ThreadId.make("thread-new");

describe("mobile edit from here", () => {
  it("builds a rewind command without a new-thread target", () => {
    expect(
      buildEditFromHereInput({
        threadId: currentThreadId,
        sourceMessageId,
        replacementMessageId,
        editedText: "  revised prompt  ",
        mode: "rewind",
      }),
    ).toEqual({
      threadId: currentThreadId,
      sourceMessageId,
      replacementMessageId,
      editedText: "revised prompt",
      mode: "rewind",
    });
  });

  it("builds a branch command with its new-thread target", () => {
    expect(
      buildEditFromHereInput({
        threadId: currentThreadId,
        sourceMessageId,
        replacementMessageId,
        editedText: "revised prompt",
        mode: "branch",
        targetThreadId,
      }),
    ).toMatchObject({
      threadId: currentThreadId,
      mode: "branch",
      targetThreadId,
    });
  });

  it("navigates rewind in place and branch to the generated thread", () => {
    expect(
      resolveEditFromHereNavigation({
        environmentId,
        currentThreadId,
        mode: "rewind",
        targetThreadId,
      }),
    ).toEqual({ environmentId: "environment-1", threadId: "thread-current" });
    expect(
      resolveEditFromHereNavigation({
        environmentId,
        currentThreadId,
        mode: "branch",
        targetThreadId,
      }),
    ).toEqual({ environmentId: "environment-1", threadId: "thread-new" });
  });

  it("blocks edit while work or another edit is pending", () => {
    expect(
      isEditFromHereBlocked({
        sessionStatus: "ready",
        activeWorkStartedAt: null,
        editPending: false,
      }),
    ).toBe(false);
    expect(
      isEditFromHereBlocked({
        sessionStatus: "running",
        activeWorkStartedAt: null,
        editPending: false,
      }),
    ).toBe(true);
    expect(
      isEditFromHereBlocked({
        sessionStatus: "ready",
        activeWorkStartedAt: "2026-08-23T12:00:00.000Z",
        editPending: false,
      }),
    ).toBe(true);
    expect(
      isEditFromHereBlocked({
        sessionStatus: "ready",
        activeWorkStartedAt: null,
        editPending: true,
      }),
    ).toBe(true);
  });
});
