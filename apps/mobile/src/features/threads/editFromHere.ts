import type { EditThreadFromHereInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

export type EditFromHereMode = "branch" | "rewind";

export interface EditFromHereSubmission {
  readonly threadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly replacementMessageId: MessageId;
  readonly editedText: string;
  readonly mode: EditFromHereMode;
  readonly targetThreadId?: ThreadId;
}

export function buildEditFromHereInput(input: EditFromHereSubmission): EditThreadFromHereInput {
  const common = {
    threadId: input.threadId,
    sourceMessageId: input.sourceMessageId,
    replacementMessageId: input.replacementMessageId,
    editedText: input.editedText.trim(),
  };

  return input.mode === "branch"
    ? {
        ...common,
        mode: "branch",
        targetThreadId: input.targetThreadId!,
      }
    : { ...common, mode: "rewind" };
}

export function resolveEditFromHereNavigation(input: {
  readonly environmentId: EnvironmentId;
  readonly currentThreadId: ThreadId;
  readonly mode: EditFromHereMode;
  readonly targetThreadId?: ThreadId;
}): { readonly environmentId: string; readonly threadId: string } {
  return {
    environmentId: String(input.environmentId),
    threadId: String(
      input.mode === "branch"
        ? (input.targetThreadId ?? input.currentThreadId)
        : input.currentThreadId,
    ),
  };
}

export function isEditFromHereBlocked(input: {
  readonly sessionStatus: string | null | undefined;
  readonly activeWorkStartedAt: string | null;
  readonly editPending: boolean;
}): boolean {
  return (
    input.sessionStatus === "starting" ||
    input.sessionStatus === "running" ||
    input.activeWorkStartedAt !== null ||
    input.editPending
  );
}
