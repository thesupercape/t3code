import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnId, type OrchestrationSession } from "@t3tools/contracts";

import { resolveMobileSteering } from "./steer-turn";

const threadId = ThreadId.make("thread-1");
const targetTurnId = TurnId.make("turn-original");
const session: OrchestrationSession = {
  threadId,
  providerName: "codex",
  status: "running",
  activeTurnId: targetTurnId,
  runtimeMode: "full-access",
  lastError: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const input = {
  threadId,
  session,
  targetTurnId,
  text: "  Focus on tests  ",
  disabled: false,
  submitting: false,
};

describe("mobile turn steering", () => {
  it("submits the captured turn and trimmed text without turn-start options", () => {
    expect(resolveMobileSteering(input).submission).toEqual({
      threadId,
      expectedTurnId: targetTurnId,
      text: "Focus on tests",
    });
  });

  it("exposes the current target without submitting before the dialog opens", () => {
    expect(resolveMobileSteering({ ...input, targetTurnId: null })).toEqual({
      activeTurnId: targetTurnId,
      targetIsRunning: false,
      submission: null,
    });
  });

  it("does not retarget an open dialog when another turn starts", () => {
    const nextTurnId = TurnId.make("turn-next");
    expect(
      resolveMobileSteering({ ...input, session: { ...session, activeTurnId: nextTurnId } }),
    ).toEqual({ activeTurnId: nextTurnId, targetIsRunning: false, submission: null });
  });

  it.each(["idle", "starting", "ready", "interrupted", "stopped", "error"] as const)(
    "rejects a %s session even if its old turn ID remains",
    (status) => {
      expect(
        resolveMobileSteering({ ...input, session: { ...session, status } }).submission,
      ).toBeNull();
    },
  );

  it.each(["claudeAgent", "cursor", null])(
    "does not offer steering for provider %s",
    (providerName) => {
      const state = resolveMobileSteering({ ...input, session: { ...session, providerName } });
      expect(state.activeTurnId).toBeNull();
      expect(state.submission).toBeNull();
    },
  );

  it("rejects missing, stale-thread, and missing-turn sessions", () => {
    for (const currentSession of [
      null,
      { ...session, threadId: ThreadId.make("other-thread") },
      { ...session, activeTurnId: null },
    ]) {
      expect(resolveMobileSteering({ ...input, session: currentSession }).submission).toBeNull();
    }
  });

  it("blocks disconnected or editing actions without changing the captured turn", () => {
    const state = resolveMobileSteering({ ...input, disabled: true });
    expect(state.submission).toBeNull();
    expect(state.targetIsRunning).toBe(true);
  });

  it("blocks blank instructions and repeated submissions", () => {
    expect(resolveMobileSteering({ ...input, text: " \n " }).submission).toBeNull();
    expect(resolveMobileSteering({ ...input, submitting: true }).submission).toBeNull();
  });

  it("allows retry only while the original turn is still active", () => {
    expect(resolveMobileSteering({ ...input, submitting: false }).submission?.expectedTurnId).toBe(
      targetTurnId,
    );
    expect(
      resolveMobileSteering({
        ...input,
        submitting: false,
        session: { ...session, activeTurnId: TurnId.make("replacement") },
      }).submission,
    ).toBeNull();
  });
});
