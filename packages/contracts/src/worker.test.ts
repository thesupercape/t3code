import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  WorkerContextPackage,
  WorkerEfficiencyOverview,
  WorkerMcpGetInput,
  WorkerMcpGetResult,
  WorkerMcpListInput,
  WorkerMcpStartInput,
  WorkerStartInput,
  sanitizeWorkerDisplayName,
  workerDisplayNameFor,
} from "./worker.ts";

const decodeContext = Schema.decodeUnknownSync(WorkerContextPackage);
const decodeStart = Schema.decodeUnknownSync(WorkerStartInput);
const decodeMcpStart = Schema.decodeUnknownSync(WorkerMcpStartInput);
const decodeList = Schema.decodeUnknownSync(WorkerMcpListInput);
const decodeGet = Schema.decodeUnknownSync(WorkerMcpGetInput);
const decodeOverview = Schema.decodeUnknownSync(WorkerEfficiencyOverview);

describe("Worker contracts", () => {
  it("keeps Worker identity separate and sanitizes optional display names deterministically", () => {
    expect(sanitizeWorkerDisplayName("  Copper\n Finch  ")).toBe("Copper Finch");
    expect(sanitizeWorkerDisplayName(" \t ")).toBeUndefined();
    expect(sanitizeWorkerDisplayName("x".repeat(200))).toHaveLength(64);
    expect(workerDisplayNameFor("worker-stable-id")).toBe(workerDisplayNameFor("worker-stable-id"));
    expect(workerDisplayNameFor("worker-stable-id", "  Review Bot  ")).toBe("Review Bot");
    expect(workerDisplayNameFor("worker-stable-id", "   ")).toBe(
      workerDisplayNameFor("worker-stable-id"),
    );
  });

  it("keeps context explicit and defaults empty references", () => {
    expect(decodeContext({})).toEqual({ references: [], snippets: [] });
    expect(() => decodeStart({ title: "worker", assignment: "inspect" })).toThrow();
  });

  it("accepts named MCP input and result contracts", () => {
    expect(
      decodeMcpStart({
        displayName: "  Review Bot  ",
        title: "worker",
        assignment: "inspect",
        context: {},
        permissionMode: "fullAccess",
        approvalPolicy: "never",
      }),
    ).toEqual({
      displayName: "  Review Bot  ",
      title: "worker",
      assignment: "inspect",
      context: { references: [], snippets: [] },
    });
    expect(WorkerMcpGetResult).toBeDefined();
    expect(decodeList({})).toEqual({});
    expect(() => decodeGet({ workerId: "worker-1" })).not.toThrow();
  });

  it("accepts a Worker model option patch without an opaque instance id or model slug", () => {
    expect(
      decodeMcpStart({
        title: "Luna review",
        assignment: "Inspect the provider boundary.",
        context: {},
        modelSelection: {
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    ).toEqual({
      title: "Luna review",
      assignment: "Inspect the provider boundary.",
      context: { references: [], snippets: [] },
      modelSelection: {
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("decodes exact overview dimensions and explicit unavailable coverage", () => {
    const decoded = decodeOverview({
      computedAt: "2026-08-22T20:00:00.000Z",
      workersCreated: 0,
      workersActive: 0,
      workersCompleted: 0,
      workersFailed: 0,
      workersInterrupted: 0,
      timing: {
        computedAt: "2026-08-22T20:00:00.000Z",
        totalWallTimeMs: 0,
        overallSpanMs: 0,
        busyTimeMs: 0,
        overlapTimeMs: 0,
        averageConcurrency: 0,
        peakConcurrency: 0,
        activeActivationCount: 0,
      },
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      usageCoverage: { status: "complete" },
      toolCalls: 0,
      completedToolCalls: 0,
      failedToolCalls: 0,
      unknownToolCalls: 0,
      tools: [],
      toolCoverage: { status: "complete" },
      parentCoordinationCalls: 0,
      parentCoordinationCompleted: 0,
      parentCoordinationFailures: 0,
      parentCoordinationUnknown: 0,
      parentCoordinationTools: [],
      parentCoordinationCoverage: { status: "complete" },
      parentCoordinationTokenCoverage: {
        status: "unavailable",
        reason: "Usage is not linked per coordination call.",
      },
      workers: [],
    });
    expect(decoded.parentCoordinationTokenCoverage.status).toBe("unavailable");
  });
});
