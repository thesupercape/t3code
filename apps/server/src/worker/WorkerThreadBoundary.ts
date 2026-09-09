import { T3_WORKER_TOOL_NAMES } from "@t3tools/contracts";

/**
 * T3-owned provider sessions use a reserved, persisted thread-id namespace.
 * Keeping this boundary separate lets the normal provider-ingestion fan-out
 * recognize Worker traffic without depending on Worker persistence or service
 * startup order.
 */
export const WORKER_PROVIDER_THREAD_PREFIX = "t3-worker-";

export const isWorkerLinkedProviderThreadId = (threadId: string): boolean =>
  threadId.startsWith(WORKER_PROVIDER_THREAD_PREFIX);

const WORKER_LIFECYCLE_TOOL_ALIASES = new Set([
  "spawn_agent",
  "followup_task",
  "send_message",
  "send_input",
  "interrupt_agent",
  "list_agents",
  "wait_agent",
  "resume_agent",
  "close_agent",
  ...T3_WORKER_TOOL_NAMES,
]);

/**
 * Defense-in-depth matcher for agent lifecycle calls that must never be
 * callable from a Worker-linked provider session. The Codex process config is
 * the catalog boundary; this matcher protects request dispatch if a future
 * runtime exposes an alias despite that configuration.
 */
export const isWorkerLifecycleToolName = (tool: string, namespace?: string | null): boolean => {
  const normalizedTool = tool.trim().toLowerCase();
  const normalizedNamespace = namespace?.trim().toLowerCase();
  const qualified = normalizedNamespace
    ? `${normalizedNamespace}.${normalizedTool}`
    : normalizedTool;

  if (
    qualified.startsWith("collaboration.") ||
    qualified.startsWith("multi_agent_v1.") ||
    qualified.startsWith("multi_agent_v1__") ||
    qualified.startsWith("mcp__t3_code__worker_") ||
    qualified.startsWith("mcp__t3-code__worker_")
  ) {
    return true;
  }

  const leaf = normalizedTool.split(".").at(-1) ?? normalizedTool;
  return WORKER_LIFECYCLE_TOOL_ALIASES.has(leaf);
};
