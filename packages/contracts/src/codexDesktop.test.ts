import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  CodexDesktopSendMessageResponse,
  CodexDesktopThreadHistoryResponse,
} from "./codexDesktop.ts";

describe("Codex desktop contracts", () => {
  it("accepts native history with untimestamped items and tool activity", () => {
    const history = Schema.decodeUnknownSync(CodexDesktopThreadHistoryResponse)({
      thread: {
        id: "thread-1",
        title: "Release review",
        updatedAt: "2026-09-07T12:00:00.000Z",
        preview: "Inspect the release notes",
        cwd: "A:/Dev",
        status: "active",
      },
      messages: [
        {
          id: "item-1",
          role: "tool",
          text: "Reading files",
          createdAt: null,
          tool: { name: "shell", status: "completed", detail: "3 files" },
        },
      ],
      nextCursor: null,
    });

    expect(history.messages[0]?.createdAt).toBeNull();
    expect(history.messages[0]?.tool?.name).toBe("shell");
  });

  it("keeps delivery state distinct from native agent state", () => {
    const delivery = Schema.decodeUnknownSync(CodexDesktopSendMessageResponse)({
      requestId: "request-1",
      status: "queued",
      message: null,
      error: null,
    });

    expect(delivery.status).toBe("queued");
  });
});
