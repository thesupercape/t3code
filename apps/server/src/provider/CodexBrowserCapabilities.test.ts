import { describe, expect, it } from "vite-plus/test";

import {
  hasT3ManagedChromeTools,
  hasT3PreviewBrowserTools,
  resolveCodexBrowserCapabilities,
  T3_MANAGED_CHROME_TOOLS,
  T3_PREVIEW_BROWSER_TOOLS,
} from "./CodexBrowserCapabilities.ts";

const managedTools = Object.fromEntries(T3_MANAGED_CHROME_TOOLS.map((name) => [name, {}]));

describe("Codex browser capabilities", () => {
  it("discovers preview separately from managed Chrome", () => {
    const servers = [
      {
        name: "t3-code",
        tools: Object.fromEntries(T3_PREVIEW_BROWSER_TOOLS.map((name) => [name, {}])),
      },
    ];
    expect(hasT3PreviewBrowserTools(servers)).toBe(true);
    expect(hasT3ManagedChromeTools(servers)).toBe(false);
    expect(hasT3PreviewBrowserTools([{ name: "t3-code", tools: managedTools }])).toBe(false);
    expect(hasT3PreviewBrowserTools([])).toBe(false);
  });

  it("requires the complete tool catalog on the T3 MCP server", () => {
    expect(hasT3ManagedChromeTools([])).toBe(false);
    expect(hasT3ManagedChromeTools([{ name: "other", tools: managedTools }])).toBe(false);
    expect(hasT3ManagedChromeTools([{ name: "t3-code", tools: { computer_open_url: {} } }])).toBe(
      false,
    );
    for (const missing of T3_MANAGED_CHROME_TOOLS) {
      const tools = { ...managedTools };
      delete tools[missing];
      expect(hasT3ManagedChromeTools([{ name: "t3-code", tools }])).toBe(false);
    }
    expect(hasT3ManagedChromeTools([{ name: "t3-code", tools: managedTools }])).toBe(true);
  });

  it("does not infer desktop integration from a JavaScript tool or plugin names", () => {
    const providers = resolveCodexBrowserCapabilities([
      { name: "node_repl", tools: { js: {} } },
      { name: "chrome", tools: managedTools },
      { name: "browser", tools: managedTools },
      { name: "computer-use", tools: managedTools },
    ]);
    expect(providers.every((provider) => !provider.available)).toBe(true);
  });

  it("marks configured Windows skill reachability as unverified by the catalog, not unsupported", () => {
    const providers = resolveCodexBrowserCapabilities([{ name: "node_repl", tools: { js: {} } }]);
    const desktop = providers.find((provider) => provider.id === "codex-computer-use");
    expect(desktop).toMatchObject({
      available: false,
      transport: "mcp",
      profile: "desktop",
    });
    expect(desktop?.reason).toContain("does not verify Windows Computer Use");
    expect(desktop?.reason).toContain("official API");
    expect(desktop?.reason).toContain("current session");
    expect(desktop?.reason).not.toMatch(/no supported adapter|unavailable|impossible/);
  });

  it("keeps the separate browser profiles and Windows input owner explicit", () => {
    const providers = resolveCodexBrowserCapabilities([{ name: "t3-code", tools: managedTools }]);
    expect(providers.map(({ id, available, profile }) => ({ id, available, profile }))).toEqual([
      { id: "t3-managed-chrome", available: true, profile: "t3-managed" },
      { id: "codex-chrome", available: false, profile: "user-browser" },
      { id: "codex-browser", available: false, profile: "codex-browser" },
      { id: "codex-computer-use", available: false, profile: "desktop" },
    ]);
    expect(providers.every((provider) => provider.reason.length > 0)).toBe(true);
  });

  it("does not retain availability after the advertised tools disappear", () => {
    expect(
      resolveCodexBrowserCapabilities([{ name: "t3-code", tools: managedTools }])[0]?.available,
    ).toBe(true);
    expect(resolveCodexBrowserCapabilities([{ name: "t3-code", tools: {} }])[0]?.available).toBe(
      false,
    );
  });
});
