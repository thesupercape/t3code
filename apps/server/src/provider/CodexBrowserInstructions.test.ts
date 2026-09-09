import { describe, expect, it } from "vite-plus/test";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

const runtime = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;

describe("Codex browser provider instructions", () => {
  it("does not infer a managed browser from the selected mode", () => {
    for (const computerControlMode of ["chrome", "desktop"] as const) {
      const instructions = buildCodexDeveloperInstructions(
        "default",
        { ...runtime, computerControlMode },
        false,
      );
      expect(instructions).not.toContain("computer_start");
      expect(instructions).not.toContain("preview_status");
      expect(instructions).not.toMatch(
        /@oai\/sky|mcp__node_repl__js|explicitly trusts|unrestricted/,
      );
    }
  });

  it("describes only the discovered managed Chrome tools and their separate profile", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "chrome", computerControlAvailable: true },
      false,
    );
    expect(instructions).toMatch(
      /computer_start.*computer_status.*computer_tabs.*computer_select_tab/s,
    );
    expect(instructions).toMatch(/computer_navigate.*computer_snapshot.*computer_click/s);
    expect(instructions).toMatch(/computer_fill.*computer_type.*computer_close/s);
    expect(instructions).toContain("separate persistent Chrome profile");
    expect(instructions).toContain("Tool availability is not an approval");
    expect(instructions).toContain("Opening a URL does not provide observation or input control");
    expect(instructions).not.toContain("preview_status");
  });

  it("makes the saved desktop preference's browser-only fallback explicit", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "desktop", computerControlAvailable: true },
      false,
    );
    expect(instructions).toContain("does not attach Codex desktop Computer Use to T3");
    expect(instructions).toContain("browser-only fallback");
    expect(instructions).toContain("independently configured MCP server");
    expect(instructions).not.toMatch(/Full Windows and Chrome control|@oai\/sky|explicitly trusts/);
  });

  it("keeps preview mode independent from managed Chrome availability", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "preview", computerControlAvailable: true },
      true,
    );
    expect(instructions).toContain("preview_status");
    expect(instructions).not.toContain("computer_start");
    expect(instructions).not.toContain("Desktop control availability");
  });

  it("does not describe managed tools when capability discovery reports them absent", () => {
    const instructions = buildCodexDeveloperInstructions(
      "plan",
      { ...runtime, computerControlMode: "chrome", computerControlAvailable: false },
      true,
    );
    expect(instructions).toContain("preview_status");
    expect(instructions).not.toContain("computer_start");
  });

  it("allows the documented configured Windows skill route independently of browser preference", () => {
    for (const computerControlMode of ["preview", "chrome", "desktop"] as const) {
      const instructions = buildCodexDeveloperInstructions(
        "default",
        { ...runtime, computerControlMode, computerControlAvailable: false },
        false,
      );
      expect(instructions).toContain(
        "does not disable independently configured MCP tools or skills",
      );
      expect(instructions).toContain("installed Computer Use skill");
      expect(instructions).toContain("documented package entry point through the existing runtime");
      expect(instructions).toContain("lightweight host check in the current session");
      expect(instructions).toContain("A callable JavaScript tool alone does not prove");
      expect(instructions).toContain("Host reachability is not app approval or permission to act");
      expect(instructions).toContain("Select exactly one target window");
      expect(instructions).toContain("action-time confirmations");
      expect(instructions).toContain("coordinate foreground ownership with the user");
      expect(instructions).toContain("stop on cancellation or a locked desktop");
      expect(instructions).toContain(
        "Do not install a bridge, spawn a helper, use private endpoints",
      );
      expect(instructions).not.toMatch(/computer_start|preview_status/);
    }
  });

  it("does not treat a managed Chrome limitation as a denial of a requested configured provider", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { ...runtime, computerControlMode: "chrome", computerControlAvailable: true },
      false,
    );
    expect(instructions).toContain("check its installed skill and configured tools");
    expect(instructions).toContain(
      "do not treat it as proof that the requested provider is unavailable",
    );
  });

  it("retains T3 worker and native sub-agent guidance when those backends are active", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      {
        ...runtime,
        enableT3Workers: true,
        subagentBackend: "v2",
        computerControlMode: "preview",
        computerControlAvailable: false,
      },
      false,
    );
    expect(instructions).toContain("## T3 Workers");
    expect(instructions).toContain("worker_start");
    expect(instructions).toContain("## Codex native sub-agents");
    expect(instructions).toContain("Do not instruct a child agent to create another child");
  });

  it("includes the current Codex runtime context and response media guidance", () => {
    const instructions = buildCodexDeveloperInstructions("default", runtime, false);
    expect(instructions).toContain(
      "you are running in T3 Code through the Codex harness, as gpt-5.6-sol with high reasoning effort",
    );
    expect(instructions).toContain("embed images and videos");
  });
});
