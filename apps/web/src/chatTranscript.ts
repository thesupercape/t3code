import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

interface TaskTranscriptInput {
  readonly title: string;
  readonly threadId: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) return "[Circular]";
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(normalize);
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value), null, 2);
}

export function serializeTaskTranscript(input: TaskTranscriptInput): string {
  const entries = [
    ...input.messages
      .filter((message) => message.role !== "system")
      .map((message, index) => ({
        kind: "message" as const,
        createdAt: message.createdAt,
        stableOrder: index,
        message,
      })),
    ...input.activities.map((activity, index) => ({
      kind: "activity" as const,
      createdAt: activity.createdAt,
      stableOrder: input.messages.length + index,
      activity,
    })),
  ].sort((left, right) => {
    const timeOrder = left.createdAt.localeCompare(right.createdAt);
    if (timeOrder !== 0) return timeOrder;
    if (left.kind === "activity" && right.kind === "activity") {
      const sequenceOrder = (left.activity.sequence ?? 0) - (right.activity.sequence ?? 0);
      if (sequenceOrder !== 0) return sequenceOrder;
    }
    return left.stableOrder - right.stableOrder;
  });

  const sections = entries.map((entry) => {
    if (entry.kind === "message") {
      const label = entry.message.role === "user" ? "USER MESSAGE" : "ASSISTANT MESSAGE";
      const attachments = entry.message.attachments?.length
        ? `\nAttachments:\n${stableJson(entry.message.attachments)}`
        : "";
      return `[${entry.createdAt}] ${label}\n${entry.message.text}${attachments}`;
    }
    const payload =
      entry.activity.payload === undefined
        ? ""
        : `\nPayload:\n${stableJson(entry.activity.payload)}`;
    return `[${entry.createdAt}] EVENT ${entry.activity.kind}\n${entry.activity.summary}${payload}`;
  });

  return [
    "T3 Code task transcript",
    `Title: ${input.title}`,
    `Task: ${input.threadId}`,
    "",
    ...sections.flatMap((section, index) => (index === 0 ? [section] : ["", section])),
  ].join("\n");
}
