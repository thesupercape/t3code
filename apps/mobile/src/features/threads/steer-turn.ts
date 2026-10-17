import type { OrchestrationSession, ThreadId, TurnId } from "@t3tools/contracts";

/** The provider, not the session projection, resolves the current parent turn. */
export function resolveMobileSteering(input: {
  readonly threadId: ThreadId;
  readonly session: OrchestrationSession | null;
  readonly targetTurnId: TurnId | null;
  readonly text: string;
  readonly disabled: boolean;
  readonly submitting: boolean;
}) {
  const canSteer =
    input.session?.threadId === input.threadId && input.session.providerName === "codex";
  const activeTurnId = canSteer ? (input.session?.activeTurnId ?? null) : null;
  const text = input.text.trim();
  return {
    activeTurnId,
    canSteer,
    submission:
      canSteer && text && !input.disabled && !input.submitting
        ? { threadId: input.threadId, expectedTurnId: input.targetTurnId, text }
        : null,
  };
}
