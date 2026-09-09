import type {
  CodexDesktopMessage,
  CodexDesktopThread,
  CodexDesktopThreadStatus,
} from "@t3tools/contracts";

export function resolveCodexSelectedThreadId(input: {
  currentId: string | null;
  requestedId: string | undefined;
  threads: readonly CodexDesktopThread[];
}): string | null {
  if (input.currentId && input.threads.some((thread) => thread.id === input.currentId)) {
    return input.currentId;
  }
  return input.requestedId ?? input.threads[0]?.id ?? null;
}

export function mergeOlderCodexMessages(
  current: readonly CodexDesktopMessage[],
  older: readonly CodexDesktopMessage[],
): readonly CodexDesktopMessage[] {
  const seen = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !seen.has(message.id)), ...current];
}

export function mergeLatestCodexMessages(
  current: readonly CodexDesktopMessage[],
  latest: readonly CodexDesktopMessage[],
): readonly CodexDesktopMessage[] {
  const latestIds = new Set(latest.map((message) => message.id));
  return [...current.filter((message) => !latestIds.has(message.id)), ...latest];
}

export function hasNewCodexActivity(
  current: readonly CodexDesktopMessage[],
  latest: readonly CodexDesktopMessage[],
): boolean {
  const currentIds = new Set(current.map((message) => message.id));
  return latest.some((message) => !currentIds.has(message.id) && message.role !== "user");
}

export function shouldApplyCodexResult(input: {
  currentThreadId: string | null;
  resultThreadId: string;
  currentGeneration: number;
  resultGeneration: number;
}): boolean {
  return (
    input.currentThreadId === input.resultThreadId &&
    input.currentGeneration === input.resultGeneration
  );
}

export function shouldPollCodexThread(status: CodexDesktopThreadStatus): boolean {
  return status === "active";
}
