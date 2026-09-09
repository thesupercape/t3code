/** A server tool catalog, either registered by T3 or returned by Codex for a thread. */
export interface CodexMcpToolInventory {
  readonly name: string;
  readonly tools: Readonly<Record<string, unknown>>;
}

export const T3_MANAGED_CHROME_TOOLS = [
  "computer_start",
  "computer_status",
  "computer_tabs",
  "computer_select_tab",
  "computer_navigate",
  "computer_snapshot",
  "computer_click",
  "computer_fill",
  "computer_type",
  "computer_close",
] as const;

export const T3_PREVIEW_BROWSER_TOOLS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_snapshot",
  "preview_click",
  "preview_type",
] as const;

const hasT3Tools = (
  servers: ReadonlyArray<CodexMcpToolInventory>,
  requiredTools: ReadonlyArray<string>,
): boolean =>
  servers.some(
    (server) =>
      server.name === "t3-code" &&
      requiredTools.every((name) => Object.prototype.hasOwnProperty.call(server.tools, name)),
  );

/** Tool availability does not imply that Chrome has started or that an action is approved. */
export const hasT3ManagedChromeTools = (servers: ReadonlyArray<CodexMcpToolInventory>): boolean =>
  hasT3Tools(servers, T3_MANAGED_CHROME_TOOLS);

export const hasT3PreviewBrowserTools = (servers: ReadonlyArray<CodexMcpToolInventory>): boolean =>
  hasT3Tools(servers, T3_PREVIEW_BROWSER_TOOLS);

export interface CodexBrowserCapability {
  readonly id: "t3-managed-chrome" | "codex-chrome" | "codex-browser" | "codex-computer-use";
  readonly label: string;
  /** Whether the supplied catalog establishes a selectable T3 route, not host reachability. */
  readonly available: boolean;
  readonly reason: string;
  readonly transport: "mcp" | "desktop-host";
  readonly profile: "t3-managed" | "user-browser" | "codex-browser" | "desktop";
}

/**
 * A tool catalog cannot establish the host connection behind a skill's JavaScript
 * runtime. Those routes need a session-scoped check through their documented API.
 */
export function resolveCodexBrowserCapabilities(
  servers: ReadonlyArray<CodexMcpToolInventory>,
): ReadonlyArray<CodexBrowserCapability> {
  const managedChromeAvailable = hasT3ManagedChromeTools(servers);
  return [
    {
      id: "t3-managed-chrome",
      label: "T3 managed Chrome",
      available: managedChromeAvailable,
      reason: managedChromeAvailable
        ? "T3 browser tools are attached. Chrome uses a separate persistent profile; start it to check runtime readiness."
        : "The complete T3 managed Chrome tool catalog is not attached to this Codex thread.",
      transport: "mcp",
      profile: "t3-managed",
    },
    {
      id: "codex-chrome",
      label: "Codex Chrome",
      available: false,
      reason:
        "This catalog does not verify the Codex Chrome extension host or its normal browser profile. Check the installed Chrome skill's runtime in the current session.",
      transport: "desktop-host",
      profile: "user-browser",
    },
    {
      id: "codex-browser",
      label: "Codex built-in browser",
      available: false,
      reason:
        "This catalog does not verify the Codex built-in browser host or its separate profile. Check the installed Browser skill's runtime in the current session.",
      transport: "desktop-host",
      profile: "codex-browser",
    },
    {
      id: "codex-computer-use",
      label: "Windows Computer Use via configured skill",
      available: false,
      reason:
        "This catalog does not verify Windows Computer Use. A configured MCP JavaScript runtime can expose the installed Computer Use skill's official API; check host reachability and target-app approvals in the current session.",
      transport: "mcp",
      profile: "desktop",
    },
  ];
}
