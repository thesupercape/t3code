import {
  ClientOrchestrationCommand,
  EnvironmentId,
  IsoDateTime,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AGENT_ACTION_MAX_BYTES = 256 * 1024;
export const AGENT_OUTPUT_MAX_BYTES = 192 * 1024;
export const AGENT_RECEIPT_METADATA_MAX_BYTES = AGENT_OUTPUT_MAX_BYTES / 2;
export const AGENT_COMMAND_TYPES = [
  "project.create",
  "project.meta.update",
  "thread.create",
  "thread.meta.update",
  "thread.pin",
  "thread.unpin",
  "thread.settle",
  "thread.unsettle",
  "thread.archive",
  "thread.unarchive",
  "thread.turn.start",
  "thread.turn.steer",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
] as const;

export class AgentCliError extends Schema.TaggedErrorClass<AgentCliError>()("AgentCliError", {
  message: Schema.String,
}) {}

const AgentAction = Schema.Struct({
  environmentId: EnvironmentId,
  runtime: Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    startedAt: IsoDateTime,
  }),
  command: ClientOrchestrationCommand,
});
export type AgentAction = typeof AgentAction.Type;
const decodeActionJson = Schema.decodeUnknownSync(Schema.fromJsonString(AgentAction));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export type AgentIdentity = {
  readonly environmentId: string;
  readonly runtime: { readonly pid: number; readonly startedAt: string };
};

export function agentCommandSchema(type: string) {
  if (!AGENT_COMMAND_TYPES.some((allowed) => allowed === type))
    reject("Command is not exposed by t3 agent.");
  const command = ClientOrchestrationCommand.members.find(
    (member) => "fields" in member && member.fields.type.literal === type,
  );
  if (!command) reject("Command schema is unavailable.");
  const document = Schema.toJsonSchemaDocument(command);
  return { ...document.schema, $defs: document.definitions };
}

function reject(message: string): never {
  throw new AgentCliError({ message });
}

export function decodeAgentAction(json: string): AgentAction {
  if (Buffer.byteLength(json, "utf8") > AGENT_ACTION_MAX_BYTES)
    reject("Action file exceeds 256 KiB.");
  let action: AgentAction;
  try {
    action = decodeActionJson(json, {
      onExcessProperty: "error",
    });
  } catch {
    return reject(
      "Invalid action JSON. Expected environmentId, runtime {pid, startedAt}, and an existing ClientOrchestrationCommand with no unknown fields.",
    );
  }
  const command = action.command;
  if (!AGENT_COMMAND_TYPES.some((type) => type === command.type))
    reject("Command is not exposed by t3 agent.");
  if (command.type === "thread.turn.interrupt" && !command.turnId)
    reject("Interrupt requires the observed active turnId.");
  if (command.type === "thread.turn.start" && command.bootstrap !== undefined)
    reject("HTTP agent commands do not support bootstrap. Create a thread separately.");
  if (
    command.type === "thread.create" &&
    (command.runtimeMode !== "approval-required" ||
      command.branch !== null ||
      command.worktreePath !== null)
  ) {
    reject(
      "New agent CLI threads require approval-required mode and the project's existing checkout.",
    );
  }
  if (command.type === "thread.approval.respond" && command.decision === "acceptForSession")
    reject("Session-wide approval is not exposed by t3 agent. Respond to one request.");
  if (
    command.type === "thread.meta.update" &&
    (command.modelSelection !== undefined ||
      command.branch !== undefined ||
      command.worktreePath !== undefined)
  ) {
    reject("Agent thread metadata updates are limited to titles.");
  }
  if (
    command.type === "project.meta.update" &&
    (command.workspaceRoot !== undefined ||
      command.scripts !== undefined ||
      command.defaultThreadEnvMode !== undefined ||
      command.defaultModelSelection !== undefined ||
      command.faviconPath !== undefined)
  ) {
    reject("Agent project metadata updates are limited to titles.");
  }
  if (command.type === "project.create" && command.createWorkspaceRootIfMissing === true)
    reject("Agent project creation requires an existing directory.");
  return action;
}

/** Local auth storage must never authorize an arbitrary remote origin. */
export function validateAgentOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return reject("Invalid persisted server origin.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    reject(
      "Agent CLI requires a bare loopback HTTP server origin from the selected data directory.",
    );
  }
  return url.origin;
}

export function validateAgentIdentity(expected: AgentIdentity, actual: AgentIdentity): void {
  if (
    expected.environmentId !== actual.environmentId ||
    expected.runtime.pid !== actual.runtime.pid ||
    expected.runtime.startedAt !== actual.runtime.startedAt
  ) {
    reject("Environment or server runtime changed. Take a fresh snapshot before acting.");
  }
}

export function validateAgentAction(
  action: AgentAction,
  identity: AgentIdentity,
  shell: OrchestrationShellSnapshot,
  detail?: OrchestrationThreadDetailSnapshot,
  capabilities?: ExecutionEnvironmentDescriptor["capabilities"],
): void {
  validateAgentIdentity(action, identity);
  const command = action.command;
  if (
    (command.type === "thread.pin" || command.type === "thread.unpin") &&
    capabilities?.threadPinning !== true
  )
    reject("Server has not advertised thread pinning.");
  if (
    command.type === "thread.pin" &&
    command.orderKey !== undefined &&
    capabilities?.threadPinReorder !== true
  )
    reject("Server has not advertised pin ordering.");
  if (
    (command.type === "thread.settle" || command.type === "thread.unsettle") &&
    capabilities?.threadSettlement !== true
  )
    reject("Server has not advertised thread settlement.");
  if (
    command.type === "thread.meta.update" &&
    command.regenerateTitle &&
    capabilities?.threadTitleRegeneration !== true
  )
    reject("Server has not advertised title regeneration.");
  if (command.type === "project.create") {
    if (shell.projects.some((project) => project.id === command.projectId))
      reject("Project ID already exists.");
    return;
  }
  if (command.type === "project.meta.update" || command.type === "thread.create") {
    if (!shell.projects.some((project) => project.id === command.projectId))
      reject("Project ID is not present in this environment.");
    if (
      command.type === "thread.create" &&
      shell.threads.some((thread) => thread.id === command.threadId)
    )
      reject("Thread ID already exists.");
    return;
  }
  if (
    !("threadId" in command) ||
    !detail ||
    detail.thread.id !== command.threadId ||
    detail.thread.deletedAt !== null
  )
    reject("Thread must be read from this environment before acting.");
  const thread = detail.thread;
  const activeTurnId = thread.session?.activeTurnId;
  // Steering resolves the live provider turn at delivery. Projection fields can
  // lag or contain child-turn state, so they cannot veto that provider check.
  if (command.type === "thread.turn.interrupt") {
    const turnId = command.turnId;
    if (
      !activeTurnId ||
      activeTurnId !== turnId ||
      thread.latestTurn?.turnId !== turnId ||
      thread.latestTurn.state !== "running"
    )
      reject("Observed active turn no longer matches the command target.");
  }
  if (command.type === "thread.turn.start") {
    if (command.runtimeMode !== thread.runtimeMode)
      reject("Send must preserve the thread runtime mode.");
    // Projection liveness can lag a missed provider completion. The provider
    // runtime resolves active/idle state; it is the delivery authority.
  }
  if (command.type === "thread.approval.respond" || command.type === "thread.user-input.respond") {
    const kind =
      command.type === "thread.approval.respond" ? "approval.requested" : "user-input.requested";
    if (
      !requestEvidence(thread.activities).some(
        (request) => request.kind === kind && request.requestId === command.requestId,
      )
    )
      reject("Request ID has no open request evidence in the current thread snapshot.");
  }
}

const clip = (value: string, limit = 1000) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const textField = (value: unknown, max = 1000) =>
  typeof value === "string" ? clip(value, max) : undefined;

/** Request evidence is retained separately from the recent tool/activity tail. */
function requestEvidence(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const open = new Map<
    string,
    {
      requestId: string;
      kind: string;
      detail: string | undefined;
      requestKind: string | undefined;
      questions: unknown;
      questionsTruncated: boolean;
      createdAt: string;
    }
  >();
  for (const activity of [...activities].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt),
  )) {
    const payload = record(activity.payload);
    const requestId = payload?.requestId;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      const questionBudget = { characters: 4000, truncated: false };
      const questions = compactValue(payload?.questions, 0, questionBudget, 4);
      open.set(requestId, {
        requestId,
        kind: activity.kind,
        createdAt: activity.createdAt,
        detail: textField(payload?.detail, 2000),
        requestKind: textField(payload?.requestKind),
        questions,
        questionsTruncated: questionBudget.truncated,
      });
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      open.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      typeof payload?.detail === "string" &&
      /(?:stale|unknown) pending.*request/i.test(payload.detail)
    ) {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

function compactValue(
  value: unknown,
  depth = 0,
  budget = { characters: 1500, truncated: false },
  maxDepth = 2,
): unknown {
  if (budget.characters <= 0) {
    budget.truncated = true;
    return "[content omitted]";
  }
  if (typeof value === "string") {
    const text = clip(value, Math.min(500, budget.characters));
    if (text !== value) budget.truncated = true;
    budget.characters -= text.length;
    return text;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maxDepth) {
    if (value !== undefined) budget.truncated = true;
    return value === undefined ? undefined : "[nested content omitted]";
  }
  if (Array.isArray(value)) {
    if (value.length > 8) budget.truncated = true;
    return value.slice(0, 8).map((entry) => compactValue(entry, depth + 1, budget, maxDepth));
  }
  const object = record(value);
  if (object && Object.keys(object).length > 8) budget.truncated = true;
  return object
    ? Object.fromEntries(
        Object.entries(object)
          .slice(0, 8)
          .filter(([key]) => !["data", "image", "base64", "dataUrl"].includes(key))
          .map(([key, entry]) => [clip(key, 80), compactValue(entry, depth + 1, budget, maxDepth)]),
      )
    : undefined;
}

export function compactAgentSnapshot(
  identity: AgentIdentity,
  shell: OrchestrationShellSnapshot,
  detail?: OrchestrationThreadDetailSnapshot,
  offset = 0,
) {
  const selected = detail?.thread;
  const requests = selected ? requestEvidence(selected.activities) : [];
  return {
    environmentId: identity.environmentId,
    runtime: identity.runtime,
    snapshotSequence: detail?.snapshotSequence ?? shell.snapshotSequence,
    shellSequence: shell.snapshotSequence,
    projects: shell.projects.slice(offset, offset + 25).map((project) => ({
      id: project.id,
      title: clip(project.title, 300),
      workspaceRoot: clip(project.workspaceRoot, 1000),
      defaultModelSelection: project.defaultModelSelection,
    })),
    projectCount: shell.projects.length,
    projectsTruncated: offset > 0 || shell.projects.length > offset + 25,
    threads: shell.threads.slice(offset, offset + 25).map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: clip(thread.title, 300),
      latestTurn: thread.latestTurn,
      sessionStatus: thread.session?.status,
      activeTurnId: thread.session?.activeTurnId,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
      archivedAt: thread.archivedAt,
      pinnedAt: thread.pinnedAt,
      settledAt: thread.settledAt,
      backgroundLiveness: thread.backgroundLiveness,
    })),
    threadCount: shell.threads.length,
    threadsTruncated: offset > 0 || shell.threads.length > offset + 25,
    listPage: {
      offset,
      size: 25,
      nextOffset:
        offset + 25 < Math.max(shell.projects.length, shell.threads.length) ? offset + 25 : null,
      consistency: "nontransactional; compare shellSequence between pages",
    },
    thread: selected
      ? {
          id: selected.id,
          projectId: selected.projectId,
          title: clip(selected.title, 300),
          modelSelection: selected.modelSelection,
          runtimeMode: selected.runtimeMode,
          interactionMode: selected.interactionMode,
          latestTurn: selected.latestTurn,
          session: selected.session
            ? {
                ...selected.session,
                lastError:
                  selected.session.lastError === null
                    ? null
                    : clip(selected.session.lastError, 2000),
              }
            : null,
          messages: selected.messages.slice(-8).map((message) => ({
            id: message.id,
            role: message.role,
            text: clip(message.text, 4000),
            createdAt: message.createdAt,
          })),
          messagesOmitted: Math.max(0, selected.messages.length - 8),
          activities: selected.activities.slice(-20).map((activity) => ({
            id: activity.id,
            kind: activity.kind,
            tone: activity.tone,
            summary: clip(activity.summary, 500),
            turnId: activity.turnId,
            sequence: activity.sequence,
            createdAt: activity.createdAt,
            payload: compactValue(activity.payload),
          })),
          activitiesOmitted: Math.max(0, selected.activities.length - 20),
          requests: requests.slice(0, 20),
          requestsOmitted: Math.max(0, requests.length - 20),
          requestEvidenceOnly: true,
          page: detail.page,
        }
      : undefined,
    navigation: "client-local; this command does not select a visible tab",
  };
}

/** Reserve output space for every outcome before the command can be dispatched. */
export function validateAgentReceiptMetadata(metadata: unknown): void {
  if (Buffer.byteLength(encodeJson(metadata), "utf8") > AGENT_RECEIPT_METADATA_MAX_BYTES) {
    reject(
      "Receipt identity exceeds 96 KiB of encoded JSON. Use shorter identifiers before dispatch.",
    );
  }
}

/** A large readback must not hide a receipt for an action already dispatched. */
export function encodeAgentOutput(output: unknown): string {
  const json = encodeJson(output);
  if (Buffer.byteLength(json, "utf8") <= AGENT_OUTPUT_MAX_BYTES) return json;
  const result = record(output);
  if (result?.status === "accepted" || result?.status === "unknown") {
    const receipt = encodeJson({
      ...result,
      readback: undefined,
      readbackError:
        "Readback omitted because output exceeds 192 KiB. Read the target with a smaller history window.",
    });
    if (Buffer.byteLength(receipt, "utf8") <= AGENT_OUTPUT_MAX_BYTES) return receipt;
  }
  return reject("Output exceeds 192 KiB. Select one thread and a smaller history window.");
}
