import { describe, expect, it } from "@effect/vitest";

import {
  codexAppServerCommandArgs,
  codexAppServerTransport,
  macDesktopCodexBinaryCandidates,
} from "./CodexAppServerTransport.ts";
import {
  codexDesktopDaemonSocketPath,
  useCodexDesktopDaemonSocketTransport,
} from "./CodexDesktopDaemonTransport.ts";

describe("CodexAppServerTransport", () => {
  it("uses the managed daemon proxy only when the desktop bridge is enabled", () => {
    expect(codexAppServerTransport({ useDesktopAppDaemon: false })).toBe("stdio");
    expect(codexAppServerTransport({ useDesktopAppDaemon: true })).toBe("desktop-daemon");
  });

  it("places existing app-server overrides after the selected subcommand", () => {
    const overrides = ["-c", 'mcp_servers.t3-code.url="http://127.0.0.1"'];
    expect(codexAppServerCommandArgs("stdio", overrides)).toEqual(["app-server", ...overrides]);
    expect(codexAppServerCommandArgs("desktop-daemon", overrides)).toEqual([
      "app-server",
      "proxy",
      ...overrides,
    ]);
  });

  it("prefers the Codex app bundle while retaining the ChatGPT compatibility paths", () => {
    expect(macDesktopCodexBinaryCandidates("/Users/christinesmith")).toEqual([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/christinesmith/Applications/ChatGPT.app/Contents/Resources/codex",
    ]);
  });

  it("resolves the managed daemon socket from Codex home and host environment", () => {
    expect(codexDesktopDaemonSocketPath("/tmp/codex-home/")).toBe(
      "/tmp/codex-home/app-server-control/app-server-control.sock",
    );
    expect(
      codexDesktopDaemonSocketPath(undefined, {
        CODEX_HOME: "/tmp/from-codex-home",
        HOME: "/tmp/from-home",
      }),
    ).toBe("/tmp/from-codex-home/app-server-control/app-server-control.sock");
    expect(codexDesktopDaemonSocketPath(undefined, { HOME: "/tmp/from-home" })).toBe(
      "/tmp/from-home/.codex/app-server-control/app-server-control.sock",
    );
    expect(
      codexDesktopDaemonSocketPath("~/.codex-work", {
        HOME: "/tmp/from-home",
      }),
    ).toBe("/tmp/from-home/.codex-work/app-server-control/app-server-control.sock");
    expect(
      codexDesktopDaemonSocketPath(undefined, {
        CODEX_HOME: "~/.codex-work",
        HOME: "/tmp/from-home",
      }),
    ).toBe("/tmp/from-home/.codex-work/app-server-control/app-server-control.sock");
  });

  it("uses the Unix desktop adapter only on macOS", () => {
    expect(useCodexDesktopDaemonSocketTransport("desktop-daemon", "darwin")).toBe(true);
    expect(useCodexDesktopDaemonSocketTransport("desktop-daemon", "win32")).toBe(false);
    expect(useCodexDesktopDaemonSocketTransport("stdio", "darwin")).toBe(false);
  });
});
