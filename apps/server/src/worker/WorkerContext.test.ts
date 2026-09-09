import { describe, expect, it } from "@effect/vitest";

import {
  buildWorkerAssignmentPrompt,
  buildWorkerContextPrompt,
  buildWorkerFollowUpPrompt,
} from "./WorkerContext.ts";

describe("Worker context package", () => {
  it("contains only explicitly selected context", () => {
    const input = {
      assignment: "Review the persistence boundary.",
      context: {
        note: "Check the migration and store.",
        references: [{ path: "apps/server/src/worker/WorkerStore.ts", lineStart: 1, lineEnd: 20 }],
        snippets: ["Use the existing SQLite layer."],
      },
      parentTranscript: "SECRET PARENT TRANSCRIPT",
    };
    const prompt = buildWorkerAssignmentPrompt(input);

    expect(prompt).toContain("WorkerStore.ts:1-20");
    expect(prompt).not.toContain("SECRET PARENT TRANSCRIPT");
  });

  it("forbids descendant delegation and keeps all work in the linked Worker", () => {
    const prompt = buildWorkerAssignmentPrompt({
      assignment: "Review the persistence boundary.",
      context: { references: [], snippets: [] },
    });

    expect(prompt).toContain("Do not spawn, create, resume, message, or delegate");
    expect(prompt).toContain("Perform all assignment work in this Worker yourself");
  });

  it("bounds the explicit context package", () => {
    expect(
      buildWorkerContextPrompt({
        note: "x".repeat(100),
        references: [],
        snippets: [],
        maxCharacters: 20,
      }),
    ).toContain("[context truncated]");
  });

  it("renders a contextual follow-up once without first-turn boilerplate", () => {
    const message = "Open the Wi-Fi article and download the page.";
    const prompt = buildWorkerFollowUpPrompt({
      message,
      context: {
        note: "Use Chrome.",
        references: [],
        snippets: [],
        maxCharacters: 14,
      },
    });

    expect(prompt.split(message)).toHaveLength(2);
    expect(prompt).toContain("[context truncated]");
    expect(prompt).not.toContain("You are a T3 Worker");
  });
});
