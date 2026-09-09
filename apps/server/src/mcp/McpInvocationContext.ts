import {
  type EnvironmentId,
  ComputerControlUnavailableError,
  type ModelSelection,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
  WorkerDisabledError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "computer" | "preview" | "workers";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriverKind?: ProviderDriverKind | undefined;
  /** Canonical selection used by the parent turn that owns this credential. */
  readonly parentModelSelection?: ModelSelection | undefined;
  /** Active canonical parent turn. Worker creation is bound to this lineage. */
  readonly parentTurnId?: TurnId | undefined;
  /** Always set by issued credentials. Missing legacy/test scopes fail closed. */
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly workingDirectory?: string | undefined;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "workers",
): Effect.Effect<McpInvocationScope, WorkerDisabledError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "computer",
): Effect.Effect<McpInvocationScope, ComputerControlUnavailableError, McpInvocationContext>;
export function requireMcpCapability(capability: McpCapability) {
  return Effect.gen(function* () {
    const invocation = yield* McpInvocationContext;
    if (invocation.capabilities.has(capability)) return invocation;
    if (capability === "workers") return yield* new WorkerDisabledError({});
    if (capability === "computer") {
      return yield* new ComputerControlUnavailableError({
        message:
          "Full Chrome or Full desktop control is not active for this provider turn. Select one of those computer-control modes and start a new turn.",
      });
    }
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  });
}
