// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeFS from "node:fs/promises";
import * as NodeWatch from "node:fs";
import * as NodePath from "node:path";

export const CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION = 1 as const;

export const resolveCodexDesktopMailboxRoot = (baseDir: string): string =>
  NodePath.join(baseDir, "codex-desktop-bridge");

export type CodexDesktopCoordinatorOperation =
  | "start"
  | "send"
  | "wait"
  | "status"
  | "close"
  | "interrupt"
  | "list"
  | "read";

export type CodexDesktopCoordinatorJobStatus =
  | "claimed"
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "approval_required"
  | "uncertain_start"
  | "unsupported";

export interface CodexDesktopCoordinatorRequest {
  readonly schemaVersion: typeof CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION;
  readonly jobId: string;
  /** Stable caller id used to replay network retries safely. */
  readonly requestId: string;
  readonly operation: CodexDesktopCoordinatorOperation;
  /** Set for a T3 Worker operation; omitted for an existing native chat. */
  readonly workerId?: string | undefined;
  readonly activationId?: string | undefined;
  readonly parentThreadId?: string | undefined;
  readonly parentTurnId?: string | undefined;
  readonly title?: string | undefined;
  /** Existing native Codex thread to inspect or message for non-worker jobs. */
  readonly threadId?: string | undefined;
  readonly message?: string | undefined;
  /** The assignment remains a plain user assignment for the native child. */
  readonly assignment?: string | undefined;
  /** Context is carried without transcript or prompt rewriting. */
  readonly context?: unknown;
  readonly instructions?: string | undefined;
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly permissionMode?: "readOnly" | "workspaceWrite" | "fullAccess" | undefined;
  readonly requestedAt: string;
}

export interface CodexDesktopCoordinatorBinding {
  readonly schemaVersion: typeof CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly requestId: string;
  readonly operation: "start";
  readonly childThreadId: string;
  readonly childHostId?: string | undefined;
  readonly claimedAt: string;
  readonly boundAt: string;
}

export interface CodexDesktopCoordinatorResult {
  readonly schemaVersion: typeof CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly requestId: string;
  readonly operation: CodexDesktopCoordinatorOperation;
  readonly status: CodexDesktopCoordinatorJobStatus;
  readonly childThreadId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly threads?: ReadonlyArray<{
    readonly threadId: string;
    readonly title?: string | undefined;
    readonly status?: string | undefined;
  }>;
  readonly text?: string | undefined;
  readonly error?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt: string;
}

export interface CodexDesktopCoordinatorStatus {
  readonly schemaVersion: typeof CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly requestId: string;
  readonly operation: CodexDesktopCoordinatorOperation;
  readonly status: Extract<CodexDesktopCoordinatorJobStatus, "claimed" | "started" | "running">;
  readonly childThreadId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly observedAt: string;
}

export interface CodexDesktopCoordinatorLease {
  readonly schemaVersion: typeof CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION;
  readonly coordinatorThreadId: string;
  readonly hostId?: string | undefined;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface CodexDesktopMailboxLayout {
  readonly root: string;
  readonly requestDirectory: string;
  readonly processingDirectory: string;
  readonly bindingDirectory: string;
  readonly resultDirectory: string;
  readonly statusDirectory: string;
  readonly leaseDirectory: string;
  readonly requestPath: (jobId: string) => string;
  readonly processingPath: (jobId: string) => string;
  readonly bindingPath: (jobId: string) => string;
  readonly resultPath: (jobId: string) => string;
  readonly statusPath: (jobId: string) => string;
  readonly leasePath: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isMailboxJobId = (value: string): boolean => UUID_PATTERN.test(value);

export const assertMailboxJobId = (value: string): string => {
  if (!isMailboxJobId(value)) {
    throw new TypeError("Codex Desktop mailbox job IDs must be UUIDs");
  }
  return value;
};

const assertRequestId = (value: string): string => {
  if (value.trim().length === 0 || value.length > 200) {
    throw new TypeError("Codex Desktop mailbox request IDs must be non-empty and bounded");
  }
  return value;
};

const safePath = (directory: string, jobId: string): string =>
  NodePath.join(directory, `${assertMailboxJobId(jobId)}.json`);

export const createCodexDesktopMailboxLayout = (root: string): CodexDesktopMailboxLayout => {
  const normalizedRoot = NodePath.resolve(root);
  const requestDirectory = NodePath.join(normalizedRoot, "requests");
  const processingDirectory = NodePath.join(normalizedRoot, "processing");
  const bindingDirectory = NodePath.join(normalizedRoot, "bindings");
  const resultDirectory = NodePath.join(normalizedRoot, "results");
  const statusDirectory = NodePath.join(normalizedRoot, "status");
  const leaseDirectory = NodePath.join(normalizedRoot, "lease");
  return {
    root: normalizedRoot,
    requestDirectory,
    processingDirectory,
    bindingDirectory,
    resultDirectory,
    statusDirectory,
    leaseDirectory,
    requestPath: (jobId) => safePath(requestDirectory, jobId),
    processingPath: (jobId) => safePath(processingDirectory, jobId),
    bindingPath: (jobId) => safePath(bindingDirectory, jobId),
    resultPath: (jobId) => safePath(resultDirectory, jobId),
    statusPath: (jobId) => safePath(statusDirectory, jobId),
    leasePath: NodePath.join(leaseDirectory, "coordinator.json"),
  };
};

const isMissingFile = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export const CODEX_DESKTOP_MAILBOX_MAX_JSON_BYTES = 1_048_576;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertBoundedString = (value: unknown, field: string, required = true): void => {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200_000) {
    throw new TypeError(`Invalid Codex Desktop mailbox ${field}`);
  }
};

const assertRequest = (value: unknown): CodexDesktopCoordinatorRequest => {
  if (!isRecord(value)) throw new TypeError("Invalid Codex Desktop mailbox request");
  if (value.schemaVersion !== CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION) {
    throw new TypeError("Unsupported Codex Desktop mailbox request version");
  }
  assertMailboxJobId(String(value.jobId));
  assertBoundedString(value.requestId, "requestId");
  const operations: ReadonlyArray<CodexDesktopCoordinatorOperation> = [
    "start",
    "send",
    "wait",
    "status",
    "close",
    "interrupt",
    "list",
    "read",
  ];
  if (!operations.includes(value.operation as CodexDesktopCoordinatorOperation)) {
    throw new TypeError("Invalid Codex Desktop mailbox operation");
  }
  if (value.operation === "start") {
    assertBoundedString(value.title, "title");
    assertBoundedString(value.assignment, "assignment");
  }
  if (["send", "wait", "status", "close", "interrupt", "read"].includes(String(value.operation))) {
    assertBoundedString(value.threadId, "threadId");
  }
  if (value.operation === "send") assertBoundedString(value.message, "message");
  assertBoundedString(value.parentThreadId, "parentThreadId", false);
  assertBoundedString(value.parentTurnId, "parentTurnId", false);
  assertBoundedString(value.workerId, "workerId", false);
  assertBoundedString(value.activationId, "activationId", false);
  assertBoundedString(value.instructions, "instructions", false);
  assertBoundedString(value.cwd, "cwd", false);
  assertBoundedString(value.model, "model", false);
  assertBoundedString(value.requestedAt, "requestedAt");
  return value as unknown as CodexDesktopCoordinatorRequest;
};

const assertBinding = (value: unknown): CodexDesktopCoordinatorBinding => {
  if (!isRecord(value) || value.schemaVersion !== CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION) {
    throw new TypeError("Invalid Codex Desktop mailbox binding");
  }
  assertMailboxJobId(String(value.jobId));
  assertBoundedString(value.requestId, "binding requestId");
  if (value.operation !== "start")
    throw new TypeError("Invalid Codex Desktop mailbox binding operation");
  assertBoundedString(value.childThreadId, "childThreadId");
  assertBoundedString(value.childHostId, "childHostId", false);
  assertBoundedString(value.claimedAt, "claimedAt");
  assertBoundedString(value.boundAt, "boundAt");
  return value as unknown as CodexDesktopCoordinatorBinding;
};

const assertResult = (value: unknown): CodexDesktopCoordinatorResult => {
  if (!isRecord(value) || value.schemaVersion !== CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION) {
    throw new TypeError("Invalid Codex Desktop mailbox result");
  }
  assertMailboxJobId(String(value.jobId));
  assertBoundedString(value.requestId, "result requestId");
  const operations: ReadonlyArray<CodexDesktopCoordinatorOperation> = [
    "start",
    "send",
    "wait",
    "status",
    "close",
    "interrupt",
    "list",
    "read",
  ];
  if (!operations.includes(value.operation as CodexDesktopCoordinatorOperation)) {
    throw new TypeError("Invalid Codex Desktop mailbox result operation");
  }
  const statuses: ReadonlyArray<CodexDesktopCoordinatorJobStatus> = [
    "claimed",
    "started",
    "running",
    "completed",
    "failed",
    "interrupted",
    "approval_required",
    "uncertain_start",
    "unsupported",
  ];
  if (!statuses.includes(value.status as CodexDesktopCoordinatorJobStatus)) {
    throw new TypeError("Invalid Codex Desktop mailbox result status");
  }
  assertBoundedString(value.childThreadId, "result childThreadId", false);
  assertBoundedString(value.threadId, "result threadId", false);
  assertBoundedString(value.text, "result text", false);
  assertBoundedString(value.error, "result error", false);
  assertBoundedString(value.completedAt, "completedAt");
  return value as unknown as CodexDesktopCoordinatorResult;
};

const assertStatus = (value: unknown): CodexDesktopCoordinatorStatus => {
  if (!isRecord(value) || value.schemaVersion !== CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION) {
    throw new TypeError("Invalid Codex Desktop mailbox status");
  }
  assertMailboxJobId(String(value.jobId));
  assertBoundedString(value.requestId, "status requestId");
  const operations: ReadonlyArray<CodexDesktopCoordinatorOperation> = [
    "start",
    "send",
    "wait",
    "status",
    "close",
    "interrupt",
    "list",
    "read",
  ];
  if (!operations.includes(value.operation as CodexDesktopCoordinatorOperation)) {
    throw new TypeError("Invalid Codex Desktop mailbox status operation");
  }
  if (!["claimed", "started", "running"].includes(String(value.status))) {
    throw new TypeError("Invalid Codex Desktop mailbox status state");
  }
  assertBoundedString(value.childThreadId, "status childThreadId", false);
  assertBoundedString(value.threadId, "status threadId", false);
  assertBoundedString(value.observedAt, "status observedAt");
  return value as unknown as CodexDesktopCoordinatorStatus;
};

const writeJsonAtomically = async (
  filePath: string,
  value: unknown,
  overwrite = true,
): Promise<void> => {
  const directory = NodePath.dirname(filePath);
  await NodeFS.mkdir(directory, { recursive: true });
  const temporaryDirectory = await NodeFS.mkdtemp(
    NodePath.join(directory, `.${NodePath.basename(filePath)}.`),
  );
  const temporaryPath = NodePath.join(temporaryDirectory, "contents.json");
  try {
    await NodeFS.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
    if (overwrite) {
      await NodeFS.rename(temporaryPath, filePath);
    } else {
      // A hard-link publish fails atomically when the target already exists.
      await NodeFS.link(temporaryPath, filePath);
    }
  } finally {
    await NodeFS.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const readJson = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    const contents = await NodeFS.readFile(filePath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > CODEX_DESKTOP_MAILBOX_MAX_JSON_BYTES) {
      throw new RangeError("Codex Desktop mailbox JSON exceeds the size limit");
    }
    return JSON.parse(contents) as T;
  } catch (cause) {
    if (isMissingFile(cause)) return undefined;
    throw cause;
  }
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const publishImmutableJson = async <T>(
  target: string,
  value: T,
  description: string,
): Promise<void> => {
  try {
    await writeJsonAtomically(target, value, false);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
      const existing = await readJson<T>(target);
      if (existing !== undefined && sameJson(existing, value)) return;
      throw new Error(`${description} already exists with different data`, { cause: cause });
    }
    throw cause;
  }
};

export const publishCodexDesktopRequest = async (
  layout: CodexDesktopMailboxLayout,
  request: CodexDesktopCoordinatorRequest,
): Promise<void> => {
  assertRequest(request);
  await publishImmutableJson(
    layout.requestPath(request.jobId),
    request,
    `Mailbox request for ${request.jobId}`,
  );
};

export interface CodexDesktopClaimedRequest {
  readonly request: CodexDesktopCoordinatorRequest;
  readonly processingPath: string;
}

export const readCodexDesktopRequest = async (
  layout: CodexDesktopMailboxLayout,
  jobId: string,
): Promise<CodexDesktopCoordinatorRequest | undefined> => {
  assertMailboxJobId(jobId);
  const value = await readJson<unknown>(layout.requestPath(jobId));
  return value === undefined ? undefined : assertRequest(value);
};

/**
 * Claims a request with one exclusive lock file. The canonical request stays
 * in place so retries and recovery can inspect the exact original payload.
 */
export const claimCodexDesktopRequest = async (
  layout: CodexDesktopMailboxLayout,
  jobId: string,
): Promise<CodexDesktopClaimedRequest | undefined> => {
  assertMailboxJobId(jobId);
  await NodeFS.mkdir(layout.processingDirectory, { recursive: true });
  const destination = layout.processingPath(jobId);
  const request = await readCodexDesktopRequest(layout, jobId);
  if (request === undefined) return undefined;
  try {
    await NodeFS.writeFile(
      destination,
      `${JSON.stringify({ jobId, claimedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "EEXIST" || cause.code === "ENOENT")
    ) {
      return undefined;
    }
    throw cause;
  }
  return { request, processingPath: destination };
};

export const readCodexDesktopBinding = async (
  layout: CodexDesktopMailboxLayout,
  jobId: string,
): Promise<CodexDesktopCoordinatorBinding | undefined> => {
  assertMailboxJobId(jobId);
  const value = await readJson<unknown>(layout.bindingPath(jobId));
  if (value === undefined) return undefined;
  const binding = assertBinding(value);
  if (binding.jobId !== jobId)
    throw new TypeError("Mailbox binding job ID does not match its path");
  return binding;
};

/** The binding is written immediately after native create_thread succeeds. */
export const publishCodexDesktopBinding = async (
  layout: CodexDesktopMailboxLayout,
  binding: CodexDesktopCoordinatorBinding,
): Promise<void> => {
  assertMailboxJobId(binding.jobId);
  assertRequestId(binding.requestId);
  assertBinding(binding);
  await publishImmutableJson(
    layout.bindingPath(binding.jobId),
    binding,
    `Mailbox binding for ${binding.jobId}`,
  );
};

export const publishCodexDesktopResult = async (
  layout: CodexDesktopMailboxLayout,
  result: CodexDesktopCoordinatorResult,
): Promise<void> => {
  assertMailboxJobId(result.jobId);
  assertRequestId(result.requestId);
  assertResult(result);
  await publishImmutableJson(
    layout.resultPath(result.jobId),
    result,
    `Mailbox result for ${result.jobId}`,
  );
};

export const readCodexDesktopResult = async (
  layout: CodexDesktopMailboxLayout,
  jobId: string,
): Promise<CodexDesktopCoordinatorResult | undefined> => {
  assertMailboxJobId(jobId);
  const value = await readJson<unknown>(layout.resultPath(jobId));
  if (value === undefined) return undefined;
  const result = assertResult(value);
  if (result.jobId !== jobId) throw new TypeError("Mailbox result job ID does not match its path");
  return result;
};

export const publishCodexDesktopStatus = async (
  layout: CodexDesktopMailboxLayout,
  status: CodexDesktopCoordinatorStatus,
): Promise<void> => {
  assertStatus(status);
  await writeJsonAtomically(layout.statusPath(status.jobId), status);
};

export const readCodexDesktopStatus = async (
  layout: CodexDesktopMailboxLayout,
  jobId: string,
): Promise<CodexDesktopCoordinatorStatus | undefined> => {
  assertMailboxJobId(jobId);
  const value = await readJson<unknown>(layout.statusPath(jobId));
  if (value === undefined) return undefined;
  const status = assertStatus(value);
  if (status.jobId !== jobId) throw new TypeError("Mailbox status job ID does not match its path");
  return status;
};

const assertLease = (value: unknown): CodexDesktopCoordinatorLease => {
  if (!isRecord(value) || value.schemaVersion !== CODEX_DESKTOP_COORDINATOR_PROTOCOL_VERSION) {
    throw new TypeError("Invalid Codex Desktop coordinator lease");
  }
  assertBoundedString(value.coordinatorThreadId, "coordinatorThreadId");
  assertBoundedString(value.hostId, "hostId", false);
  assertBoundedString(value.observedAt, "observedAt");
  assertBoundedString(value.expiresAt, "expiresAt");
  return value as unknown as CodexDesktopCoordinatorLease;
};

export const renewCodexDesktopCoordinatorLease = async (
  layout: CodexDesktopMailboxLayout,
  lease: CodexDesktopCoordinatorLease,
): Promise<void> => {
  assertLease(lease);
  await writeJsonAtomically(layout.leasePath, lease);
};

export const readCodexDesktopCoordinatorLease = async (
  layout: CodexDesktopMailboxLayout,
): Promise<CodexDesktopCoordinatorLease | undefined> => {
  const value = await readJson<unknown>(layout.leasePath);
  return value === undefined ? undefined : assertLease(value);
};

export const isCodexDesktopCoordinatorLeaseFresh = (
  lease: CodexDesktopCoordinatorLease | undefined,
  now = Date.now(),
): boolean => lease !== undefined && Date.parse(lease.expiresAt) > now;

/** Wait for a receipt change without keeping the server in a tight poll loop. */
export const waitForCodexDesktopMailboxChange = async (
  layout: CodexDesktopMailboxLayout,
  timeoutMs: number,
): Promise<"changed" | "timeout"> => {
  const directories = [layout.bindingDirectory, layout.statusDirectory, layout.resultDirectory];
  await Promise.all(directories.map((directory) => NodeFS.mkdir(directory, { recursive: true })));
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchers = directories.map((directory) =>
      NodeWatch.watch(directory, () => {
        if (settled) return;
        settled = true;
        for (const watcher of watchers) watcher.close();
        if (timer !== undefined) clearTimeout(timer);
        resolve("changed");
      }),
    );
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      for (const watcher of watchers) watcher.close();
      resolve("timeout");
    }, timeoutMs);
  });
};

export type CodexDesktopRecoveryState =
  | { readonly kind: "pending" }
  | { readonly kind: "uncertain_start"; readonly processingPath: string }
  | { readonly kind: "bound"; readonly binding: CodexDesktopCoordinatorBinding }
  | { readonly kind: "completed"; readonly result: CodexDesktopCoordinatorResult }
  | { readonly kind: "absent" };

/**
 * Recovery is deliberately descriptive. A claimed start without a binding is
 * uncertain and must not be auto-respawned by a coordinator.
 */
export const inspectCodexDesktopRecovery = async (
  layout: CodexDesktopMailboxLayout,
  jobId: string,
): Promise<CodexDesktopRecoveryState> => {
  assertMailboxJobId(jobId);
  const result = await readCodexDesktopResult(layout, jobId);
  if (result !== undefined) return { kind: "completed", result };
  const binding = await readCodexDesktopBinding(layout, jobId);
  if (binding !== undefined) return { kind: "bound", binding };
  try {
    await NodeFS.access(layout.processingPath(jobId));
    return { kind: "uncertain_start", processingPath: layout.processingPath(jobId) };
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
  try {
    await NodeFS.access(layout.requestPath(jobId));
    return { kind: "pending" };
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
    return { kind: "absent" };
  }
};

/**
 * Assignment and context are separate fields so the native coordinator can
 * forward them without silently changing the parent worker's payload.
 */
export const nativeChildInput = (request: CodexDesktopCoordinatorRequest) => ({
  assignment: request.assignment,
  context: request.context,
  instructions: request.instructions,
});
