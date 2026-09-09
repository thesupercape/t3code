import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { serializeTaskTranscript } from "./chatTranscript";

describe("serializeTaskTranscript", () => {
  it("exports messages, tool invocations, complete command results, and errors chronologically", () => {
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.make("assistant-1"),
        role: "assistant",
        text: "Finished checking.",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-08-22T12:00:04.000Z",
        updatedAt: "2026-08-22T12:00:04.000Z",
      },
      {
        id: MessageId.make("user-1"),
        role: "user",
        text: "Inspect the build",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-22T12:00:01.000Z",
        updatedAt: "2026-08-22T12:00:01.000Z",
      },
    ];
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("event-result"),
        kind: "tool.call.completed",
        tone: "tool",
        summary: "Command completed",
        payload: { exitCode: 1, stderr: "full failure output", stdout: "all output lines" },
        turnId: TurnId.make("turn-1"),
        sequence: 3,
        createdAt: "2026-08-22T12:00:03.000Z",
      },
      {
        id: EventId.make("event-call"),
        kind: "tool.call.started",
        tone: "tool",
        summary: "Run command",
        payload: { command: "vp check" },
        turnId: TurnId.make("turn-1"),
        sequence: 2,
        createdAt: "2026-08-22T12:00:02.000Z",
      },
    ];

    const transcript = serializeTaskTranscript({
      title: "Build inspection",
      threadId: ThreadId.make("thread-1"),
      messages,
      activities,
    });

    expect(transcript.indexOf("USER MESSAGE")).toBeLessThan(
      transcript.indexOf("tool.call.started"),
    );
    expect(transcript.indexOf("tool.call.started")).toBeLessThan(
      transcript.indexOf("tool.call.completed"),
    );
    expect(transcript.indexOf("tool.call.completed")).toBeLessThan(
      transcript.indexOf("ASSISTANT MESSAGE"),
    );
    expect(transcript).toContain('"stdout": "all output lines"');
    expect(transcript).toContain('"stderr": "full failure output"');
    expect(transcript).toContain('"exitCode": 1');
  });

  it("does not export hidden system messages", () => {
    const transcript = serializeTaskTranscript({
      title: "Safe export",
      threadId: "thread-safe",
      messages: [
        {
          id: MessageId.make("system-1"),
          role: "system",
          text: "hidden runtime instructions",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-22T12:00:00.000Z",
          updatedAt: "2026-08-22T12:00:00.000Z",
        },
      ],
      activities: [],
    });

    expect(transcript).not.toContain("hidden runtime instructions");
  });
});
