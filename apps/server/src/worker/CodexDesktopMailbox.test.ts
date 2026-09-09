// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { buildCodexDesktopCoordinatorInstructions } from "./CodexDesktopCoordinatorInstructions.ts";
import {
  CODEX_DESKTOP_MAILBOX_MAX_JSON_BYTES,
  CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION,
  assertMailboxJobId,
  claimCodexDesktopRequest,
  createCodexDesktopMailboxLayout,
  inspectCodexDesktopRecovery,
  isCodexDesktopCoordinatorLeaseFresh,
  nativeChildInput,
  publishCodexDesktopBinding,
  publishCodexDesktopRequest,
  publishCodexDesktopResult,
  publishCodexDesktopStatus,
  readCodexDesktopCoordinatorLease,
  readCodexDesktopStatus,
  renewCodexDesktopCoordinatorLease,
  readCodexDesktopResult,
  type CodexDesktopCoordinatorRequest,
} from "./CodexDesktopMailbox.ts";

const jobId = "11111111-1111-4111-8111-111111111111";

const makeRequest = (): CodexDesktopCoordinatorRequest => ({
  schemaVersion: CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION,
  jobId,
  requestId: "request-1",
  operation: "start",
  workerId: "22222222-2222-4222-8222-222222222222",
  parentThreadId: "parent-thread",
  title: "Native worker",
  assignment: "Keep this assignment unchanged.",
  context: { references: ["context.json"] },
  requestedAt: "2026-09-07T15:00:00.000Z",
});

const withMailbox = async <A>(run: (root: string) => Promise<A>): Promise<A> => {
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codex-desktop-mailbox-"));
  try {
    return await run(root);
  } finally {
    await NodeFS.rm(root, { recursive: true, force: true });
  }
};

describe("CodexDesktopMailbox", () => {
  it("derives every mailbox path from a validated UUID job ID", () => {
    const layout = createCodexDesktopMailboxLayout("./mailbox");
    expect(layout.requestPath(jobId)).toBe(NodePath.join(layout.requestDirectory, `${jobId}.json`));
    expect(() => assertMailboxJobId("../../result")).toThrow("must be UUIDs");
  });

  it("claims once and exposes an unbound processing request as uncertain", async () => {
    await withMailbox(async (root) => {
      const layout = createCodexDesktopMailboxLayout(root);
      const request = makeRequest();
      await publishCodexDesktopRequest(layout, request);
      await publishCodexDesktopRequest(layout, request);
      await expect(
        publishCodexDesktopRequest(layout, { ...request, requestId: "request-2" }),
      ).rejects.toThrow("already exists");
      expect((await inspectCodexDesktopRecovery(layout, jobId)).kind).toBe("pending");

      const claim = await claimCodexDesktopRequest(layout, jobId);
      expect(claim?.request).toEqual(request);
      await publishCodexDesktopRequest(layout, request);
      expect(await claimCodexDesktopRequest(layout, jobId)).toBeUndefined();
      expect((await inspectCodexDesktopRecovery(layout, jobId)).kind).toBe("uncertain_start");
    });
  });

  it("allows only one concurrent coordinator to claim a request", async () => {
    await withMailbox(async (root) => {
      const layout = createCodexDesktopMailboxLayout(root);
      await publishCodexDesktopRequest(layout, makeRequest());
      const claims = await Promise.all([
        claimCodexDesktopRequest(layout, jobId),
        claimCodexDesktopRequest(layout, jobId),
      ]);
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    });
  });

  it("persists a binding before the final result and recovers both idempotently", async () => {
    await withMailbox(async (root) => {
      const layout = createCodexDesktopMailboxLayout(root);
      const binding = {
        schemaVersion: CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION,
        jobId,
        requestId: "request-1",
        operation: "start" as const,
        childThreadId: "01native-child",
        claimedAt: "2026-09-07T15:00:01.000Z",
        boundAt: "2026-09-07T15:00:02.000Z",
      };
      await publishCodexDesktopBinding(layout, binding);
      expect((await inspectCodexDesktopRecovery(layout, jobId)).kind).toBe("bound");
      await publishCodexDesktopBinding(layout, binding);
      await expect(
        publishCodexDesktopBinding(layout, { ...binding, childThreadId: "different-child" }),
      ).rejects.toThrow("different data");

      const result = {
        schemaVersion: CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION,
        jobId,
        requestId: "request-1",
        operation: "start" as const,
        status: "completed" as const,
        childThreadId: binding.childThreadId,
        text: "done",
        completedAt: "2026-09-07T15:00:03.000Z",
      };
      await publishCodexDesktopResult(layout, result);
      expect(await readCodexDesktopResult(layout, jobId)).toEqual(result);
      expect((await inspectCodexDesktopRecovery(layout, jobId)).kind).toBe("completed");
      await publishCodexDesktopResult(layout, result);
      await expect(
        publishCodexDesktopResult(layout, { ...result, text: "different" }),
      ).rejects.toThrow("different data");
    });
  });

  it("keeps the native child payload fields separate", () => {
    const request = makeRequest();
    expect(nativeChildInput(request)).toEqual({
      assignment: request.assignment,
      context: request.context,
      instructions: request.instructions,
    });
  });

  it("generates coordinator instructions for worker and existing-chat operations", () => {
    const instructions = buildCodexDesktopCoordinatorInstructions("A:\\mailbox");
    expect(instructions).toContain("start");
    expect(instructions).toContain("send");
    expect(instructions).toContain("read and list");
    expect(instructions).toContain("uncertain_start");
    expect(instructions).toContain("private pipe");
  });

  it("rejects malformed and oversized canonical requests before claiming", async () => {
    await withMailbox(async (root) => {
      const layout = createCodexDesktopMailboxLayout(root);
      await NodeFS.mkdir(layout.requestDirectory, { recursive: true });
      await NodeFS.writeFile(layout.requestPath(jobId), "{bad", "utf8");
      await expect(claimCodexDesktopRequest(layout, jobId)).rejects.toThrow();

      await NodeFS.writeFile(
        layout.requestPath(jobId),
        `{"schemaVersion":1,"jobId":"${jobId}","requestId":"r","operation":"list","requestedAt":"x","padding":"${"x".repeat(CODEX_DESKTOP_MAILBOX_MAX_JSON_BYTES)}"}`,
        "utf8",
      );
      await expect(claimCodexDesktopRequest(layout, jobId)).rejects.toThrow("size limit");
    });
  });

  it("reports readiness only while the coordinator lease is fresh", async () => {
    await withMailbox(async (root) => {
      const layout = createCodexDesktopMailboxLayout(root);
      const lease = {
        schemaVersion: CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION,
        coordinatorThreadId: "01coordinator",
        observedAt: "2026-09-07T15:00:00.000Z",
        expiresAt: "2026-09-07T15:01:00.000Z",
      };
      await renewCodexDesktopCoordinatorLease(layout, lease);
      expect(await readCodexDesktopCoordinatorLease(layout)).toEqual(lease);
      expect(
        isCodexDesktopCoordinatorLeaseFresh(lease, Date.parse("2026-09-07T15:00:30.000Z")),
      ).toBe(true);
      expect(
        isCodexDesktopCoordinatorLeaseFresh(lease, Date.parse("2026-09-07T15:01:00.000Z")),
      ).toBe(false);
    });
  });

  it("publishes a started status before a final result", async () => {
    await withMailbox(async (root) => {
      const layout = createCodexDesktopMailboxLayout(root);
      const status = {
        schemaVersion: CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION,
        jobId,
        requestId: "request-1",
        operation: "start" as const,
        status: "started" as const,
        childThreadId: "01native-child",
        observedAt: "2026-09-07T15:00:02.000Z",
      };
      await publishCodexDesktopStatus(layout, status);
      expect(await readCodexDesktopStatus(layout, jobId)).toEqual(status);
      await publishCodexDesktopStatus(layout, { ...status, status: "running" });
      expect((await readCodexDesktopStatus(layout, jobId))?.status).toBe("running");
    });
  });
});
