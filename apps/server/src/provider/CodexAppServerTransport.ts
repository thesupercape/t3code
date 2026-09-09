import * as NodeOS from "node:os";

import type { CodexSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type CodexAppServerTransport = "stdio" | "desktop-daemon";

export function codexAppServerTransport(
  settings: Pick<CodexSettings, "useDesktopAppDaemon">,
): CodexAppServerTransport {
  return settings.useDesktopAppDaemon ? "desktop-daemon" : "stdio";
}

export function codexAppServerCommandArgs(
  transport: CodexAppServerTransport,
  appServerArgs: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  return transport === "desktop-daemon"
    ? ["app-server", "proxy", ...appServerArgs]
    : ["app-server", ...appServerArgs];
}

export function macDesktopCodexBinaryCandidates(homeDirectory: string): ReadonlyArray<string> {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    `${homeDirectory}/Applications/Codex.app/Contents/Resources/codex`,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    `${homeDirectory}/Applications/ChatGPT.app/Contents/Resources/codex`,
  ];
}

/**
 * The desktop bridge must use the app-bundled CLI when it is available. That
 * keeps the proxy protocol version aligned with the running desktop daemon.
 * An explicit binary path always wins.
 */
export const resolveCodexBinaryPath = Effect.fn("resolveCodexBinaryPath")(function* (
  settings: Pick<CodexSettings, "binaryPath" | "useDesktopAppDaemon">,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcessPlatform;
  if (!settings.useDesktopAppDaemon || settings.binaryPath !== "codex" || platform !== "darwin") {
    return settings.binaryPath;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const candidate of macDesktopCodexBinaryCandidates(NodeOS.homedir())) {
    const exists = yield* fileSystem
      .exists(path.normalize(candidate))
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return path.normalize(candidate);
  }

  return settings.binaryPath;
});
