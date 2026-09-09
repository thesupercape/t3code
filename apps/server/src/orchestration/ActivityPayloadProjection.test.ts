import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves screenshot pointers across repeated projection without image bytes", () => {
    const screenshot = {
      threadId: "thread-1",
      attachmentId: "thread-1-12345678-1234-1234-1234-123456789abc",
      mimeType: "image/png",
      width: 1280,
      height: 720,
    };
    const input = activity({
      itemType: "mcp_tool_call",
      data: {
        item: {
          tool: "computer_screenshot",
          result: {
            content: [
              { type: "text", text: JSON.stringify({ screenshot }) },
              { type: "image", mimeType: "image/png", data: "large-image-bytes".repeat(100_000) },
            ],
          },
        },
      },
    });
    const projected = projectActivityPayload(input);
    expect(projected.payload).toMatchObject({
      data: { item: { result: { screenshot, content: "Screenshot 1280 × 720" } } },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
    expect(JSON.stringify(projected).length).toBeLessThan(1024);
    expect(JSON.stringify(projected)).not.toContain("large-image-bytes");
  });
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("normalizes Claude and OpenCode command inputs before slimming provider data", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: { content: "x".repeat(5_000) },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: { command: "vp test run" },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(200);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps compact T3 Worker wait fields for the parent disclosure", () => {
    const result = {
      leaseId: "lease-1",
      status: "woken",
      reason: "completed",
      events: [{ workerId: "worker-1", reason: "completed", status: "completed" }],
      workers: [{ id: "worker-1", displayName: "Scout", title: "Scan files", status: "completed" }],
    };
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_wait",
            arguments: { workerIds: ["worker-1"], timeoutMillis: 60_000 },
            status: "completed",
            result,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect((data.item as Record<string, unknown>).result).toEqual(result);
  });

  it("projects Worker detail results without histories or delegated context", () => {
    const secret = "private-context-that-must-not-reach-the-parent-snapshot";
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_status",
            arguments: { workerId: "worker-1" },
            status: "completed",
            result: {
              summary: {
                id: "worker-1",
                displayName: "Scout",
                title: "Inspect the provider boundary",
                status: "running",
                model: "gpt-5.6-sol",
                usage: {
                  inputTokens: 120,
                  cachedInputTokens: 100,
                  outputTokens: 20,
                  reasoningTokens: 5,
                  totalTokens: 145,
                },
                latestDirectMessage: { body: secret },
                latestObserverReport: {
                  id: "report-1",
                  workerId: "worker-1",
                  model: "gpt-5.6-sol",
                  report: `No blocker found.\n${secret.repeat(200)}`,
                  blockers: [],
                  observedStatus: "running",
                  readOnly: true,
                  generatedAt: "2026-08-01T10:00:00.000Z",
                },
              },
              assignment: `Inspect the provider boundary.\n${"detail ".repeat(500)}`,
              context: { note: secret, snippets: [secret.repeat(200)] },
              instructions: secret,
              messages: Array.from({ length: 100 }, () => ({ body: secret })),
              activations: Array.from({ length: 100 }, () => ({ context: { note: secret } })),
              observerReports: Array.from({ length: 100 }, () => ({ report: secret })),
              activities: Array.from({ length: 100 }, () => ({ detail: secret })),
              pendingApproval: {
                requestId: "approval-1",
                workerId: "worker-1",
                activationId: "activation-1",
                kind: "command",
                summary: "Run verification",
                detail: `${"long ".repeat(100)}detail`,
                requestedAt: "2026-08-01T10:00:00.000Z",
                status: "pending",
              },
            },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const result = (data.item as Record<string, unknown>).result as Record<string, unknown>;
    const summary = result.summary as Record<string, unknown>;

    expect(summary).toMatchObject({
      id: "worker-1",
      displayName: "Scout",
      title: "Inspect the provider boundary",
      status: "running",
      model: "gpt-5.6-sol",
      usage: { totalTokens: 145, cachedInputTokens: 100 },
      latestObserverReport: { summary: "No blocker found." },
    });
    expect(result).toMatchObject({
      assignment: "Inspect the provider boundary.",
      pendingApproval: { requestId: "approval-1", status: "pending" },
    });
    for (const omitted of [
      "context",
      "instructions",
      "messages",
      "activations",
      "observerReports",
      "activities",
    ]) {
      expect(result[omitted]).toBeUndefined();
    }
    expect(summary.latestDirectMessage).toBeUndefined();
    expect(JSON.stringify(projected.payload)).not.toContain(secret);
    expect(JSON.stringify(projected.payload).length).toBeLessThan(2_500);
  });

  it("projects legacy Worker detail data through the same compact boundary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__t3_code__worker_status",
          input: { workerId: "worker-legacy" },
          result: {
            summary: {
              id: "worker-legacy",
              displayName: "Legacy Scout",
              title: "Inspect legacy adapter",
              status: "running",
              model: "gpt-5.6-sol",
            },
            assignment: "Inspect legacy adapter",
            context: { snippets: ["large delegated context".repeat(500)] },
            messages: [{ body: "private Worker message" }],
            activities: [{ detail: "private Worker activity" }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.result).toMatchObject({
      summary: { id: "worker-legacy", displayName: "Legacy Scout", status: "running" },
      assignment: "Inspect legacy adapter",
    });
    expect(JSON.stringify(data.result)).not.toContain("private Worker");
    expect(JSON.stringify(data.result)).not.toContain("large delegated context");
  });

  it("keeps compact list and observe presentation fields", () => {
    const secret = "observer-private-history";
    const list = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_list",
            status: "completed",
            result: {
              workers: [
                {
                  id: "worker-1",
                  displayName: "Scout",
                  title: "Scan files",
                  status: "running",
                  model: "gpt-5.6-sol",
                  usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
                  latestDirectMessage: { body: secret },
                },
              ],
              nextCursor: "page-2",
              overview: { workers: Array.from({ length: 100 }, () => secret) },
            },
          },
        },
      }),
    );
    const observe = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_observe",
            status: "completed",
            result: {
              id: "report-1",
              workerId: "worker-1",
              model: "gpt-5.6-sol",
              report: `Making progress.\n${secret.repeat(500)}`,
              progress: "Reviewing tests",
              blockers: ["None"],
              observedStatus: "running",
              readOnly: true,
              generatedAt: "2026-08-01T10:00:00.000Z",
            },
          },
        },
      }),
    );
    const listResult = (
      ((list.payload as Record<string, unknown>).data as Record<string, unknown>).item as Record<
        string,
        unknown
      >
    ).result as Record<string, unknown>;
    const observeResult = (
      ((observe.payload as Record<string, unknown>).data as Record<string, unknown>).item as Record<
        string,
        unknown
      >
    ).result as Record<string, unknown>;

    expect(listResult).toMatchObject({
      nextCursor: "page-2",
      workers: [{ id: "worker-1", displayName: "Scout", usage: { totalTokens: 15 } }],
    });
    expect(listResult.overview).toBeUndefined();
    expect(observeResult).toMatchObject({
      workerId: "worker-1",
      summary: "Making progress.",
      progress: "Reviewing tests",
      observedStatus: "running",
    });
    expect(JSON.stringify({ listResult, observeResult })).not.toContain(secret);
  });

  it("falls back to a bounded Worker error summary for non-detail results", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            tool: "worker_send",
            status: "failed",
            result: { content: `Permission denied\n${"diagnostic ".repeat(1_000)}` },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect((data.item as Record<string, unknown>).result).toEqual({ content: "Permission denied" });
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});
