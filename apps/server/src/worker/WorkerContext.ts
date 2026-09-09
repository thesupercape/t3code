import type { WorkerContextPackage } from "@t3tools/contracts";

export const DEFAULT_WORKER_CONTEXT_MAX_CHARACTERS = 24_000;

/**
 * Builds the only context that crosses the Worker boundary. Parent transcript
 * text is intentionally not an input to this function.
 */
export function buildWorkerContextPrompt(
  context: WorkerContextPackage,
  maxCharacters = context.maxCharacters ?? DEFAULT_WORKER_CONTEXT_MAX_CHARACTERS,
): string {
  const sections: string[] = [];
  if (context.note?.trim()) sections.push(`Context note:\n${context.note.trim()}`);

  if (context.references.length > 0) {
    sections.push(
      [
        "Explicit references:",
        ...context.references.map((reference) => {
          const range =
            reference.lineStart === undefined
              ? ""
              : `:${reference.lineStart}${reference.lineEnd === undefined ? "" : `-${reference.lineEnd}`}`;
          const symbol = reference.symbol === undefined ? "" : ` (${reference.symbol})`;
          const excerpt = reference.excerpt?.trim();
          return [
            `- ${reference.path}${range}${symbol}`,
            ...(excerpt ? [`  Excerpt: ${excerpt}`] : []),
          ].join("\n");
        }),
      ].join("\n"),
    );
  }

  if (context.snippets.length > 0) {
    sections.push(
      ["Explicit snippets:", ...context.snippets.map((snippet) => `- ${snippet}`)].join("\n"),
    );
  }

  const rendered = sections.join("\n\n");
  return rendered.length <= maxCharacters
    ? rendered
    : `${rendered.slice(0, Math.max(0, maxCharacters - 42)).trimEnd()}\n[context truncated]`;
}

export function buildWorkerAssignmentPrompt(input: {
  readonly assignment: string;
  readonly context: WorkerContextPackage;
  readonly instructions?: string | undefined;
}): string {
  const parts = [
    "You are a T3 Worker. Work only on the assignment below.",
    "You are single-level. Do not spawn, create, resume, message, or delegate to native subagents or other Workers.",
    "Perform all assignment work in this Worker yourself.",
    "You do not have the parent conversation. Do not infer missing context from it.",
    "Use the explicit paths, symbols, ranges, and snippets supplied here.",
    "When finished, return a concise handoff with changed files, checks run, and remaining risks.",
    `Assignment:\n${input.assignment.trim()}`,
    buildWorkerContextPrompt(input.context),
  ];
  if (input.instructions?.trim()) parts.push(`Worker instructions:\n${input.instructions.trim()}`);
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

/** Compact follow-up prompt. The Worker already received its role and boundary instructions. */
export function buildWorkerFollowUpPrompt(input: {
  readonly message: string;
  readonly context?: WorkerContextPackage | undefined;
}): string {
  const context = input.context === undefined ? "" : buildWorkerContextPrompt(input.context);
  return [input.message.trim(), context].filter((part) => part.length > 0).join("\n\n");
}
