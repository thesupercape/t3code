import type { OrchestrationSession, ThreadId, TurnId } from "@t3tools/contracts";

/** Submission eligibility for a captured turn, independent of the message outbox. */
export function resolveMobileSteering(input: {
  readonly threadId: ThreadId;
  readonly session: OrchestrationSession | null;
  readonly targetTurnId: TurnId | null;
  readonly text: string;
  readonly disabled: boolean;
  readonly submitting: boolean;
}) {
  const activeTurnId =
    input.session?.threadId === input.threadId &&
    input.session.providerName === "codex" &&
    input.session.status === "running"
      ? input.session.activeTurnId
      : null;
  const targetIsRunning = input.targetTurnId !== null && input.targetTurnId === activeTurnId;
  const text = input.text.trim();
  return {
    activeTurnId,
    targetIsRunning,
    submission:
      targetIsRunning && input.targetTurnId && text && !input.disabled && !input.submitting
        ? { threadId: input.threadId, expectedTurnId: input.targetTurnId, text }
        : null,
  };
}
