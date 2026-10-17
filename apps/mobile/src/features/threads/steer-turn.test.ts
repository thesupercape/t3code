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

  it("can submit a provider-resolved target without a projected turn ID", () => {
    expect(resolveMobileSteering({ ...input, targetTurnId: null })).toEqual({
      activeTurnId: targetTurnId,
      canSteer: true,
      submission: { threadId, expectedTurnId: null, text: "Focus on tests" },
    });
  });

  it("lets the provider resolve a stale captured turn without inventing a replacement", () => {
    const nextTurnId = TurnId.make("turn-next");
    expect(
      resolveMobileSteering({ ...input, session: { ...session, activeTurnId: nextTurnId } }),
    ).toMatchObject({
      activeTurnId: nextTurnId,
      canSteer: true,
      submission: { expectedTurnId: targetTurnId },
    });
  });

  it.each(["idle", "starting", "ready", "interrupted", "stopped", "error"] as const)(
    "does not veto a bound Codex %s projection",
    (status) => {
      expect(
        resolveMobileSteering({ ...input, session: { ...session, status } }).submission,
      ).toMatchObject({ expectedTurnId: targetTurnId });
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

  it("rejects missing and stale-thread sessions", () => {
    for (const currentSession of [null, { ...session, threadId: ThreadId.make("other-thread") }]) {
      expect(resolveMobileSteering({ ...input, session: currentSession }).submission).toBeNull();
    }
  });

  it("allows starting without a projected turn ID", () => {
    expect(
      resolveMobileSteering({
        ...input,
        session: { ...session, status: "starting", activeTurnId: null },
        targetTurnId: null,
      }).submission,
    ).toEqual({ threadId, expectedTurnId: null, text: "Focus on tests" });
  });

  it("blocks disconnected or editing actions without changing the captured turn", () => {
    const state = resolveMobileSteering({ ...input, disabled: true });
    expect(state.submission).toBeNull();
    expect(state.canSteer).toBe(true);
  });

  it("blocks blank instructions and repeated submissions", () => {
    expect(resolveMobileSteering({ ...input, text: " \n " }).submission).toBeNull();
    expect(resolveMobileSteering({ ...input, submitting: true }).submission).toBeNull();
  });

  it("does not infer an ended parent from a different projected turn on retry", () => {
    expect(resolveMobileSteering({ ...input, submitting: false }).submission?.expectedTurnId).toBe(
      targetTurnId,
    );
    expect(
      resolveMobileSteering({
        ...input,
        submitting: false,
        session: { ...session, activeTurnId: TurnId.make("replacement") },
      }).submission,
    ).toMatchObject({ expectedTurnId: targetTurnId });
  });
});
