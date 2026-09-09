import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadEditFromHereFinishedPayload } from "./orchestration.ts";

const legacyThreadEditFromHereFinishedEvent = Schema.Struct({
  type: Schema.Literal("thread.edit-from-here-finished"),
  payload: Schema.Struct({
    threadId: Schema.String,
    requestId: Schema.String,
    targetThreadId: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    workspaceRestore: Schema.optional(
      Schema.Struct({
        filesRestored: Schema.Boolean,
        reason: Schema.optional(
          Schema.Literals([
            "workspace-unavailable",
            "repository-mismatch",
            "branch-mismatch",
            "checkpoint-missing",
            "checkpoint-invalid",
            "current-checkpoint-missing",
            "current-worktree-dirty",
          ]),
        ),
        detail: Schema.optional(Schema.String),
      }),
    ),
    finishedAt: Schema.String,
  }),
});
const decodeLegacyThreadEditFromHereFinishedEvent = Schema.decodeUnknownSync(
  legacyThreadEditFromHereFinishedEvent,
);
const decodeCurrentThreadEditFromHereFinishedPayload = Schema.decodeUnknownSync(
  ThreadEditFromHereFinishedPayload,
);

describe("orchestration compatibility", () => {
  it("keeps conversation-only rewind additive for older finished-event decoders", () => {
    const event = {
      type: "thread.edit-from-here-finished" as const,
      payload: {
        threadId: "thread-1",
        requestId: "request-1",
        workspaceRestore: {
          filesRestored: false,
          conversationOnly: true,
          detail: "The conversation was rewound without changing files.",
        },
        finishedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const legacyDecoded = decodeLegacyThreadEditFromHereFinishedEvent(event);
    expect(legacyDecoded.payload.workspaceRestore).toEqual({
      filesRestored: false,
      detail: "The conversation was rewound without changing files.",
    });
    const currentDecoded = decodeCurrentThreadEditFromHereFinishedPayload(event.payload);
    expect(currentDecoded.workspaceRestore?.conversationOnly).toBe(true);
  });
});
