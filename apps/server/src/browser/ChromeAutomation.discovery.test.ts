import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { findInstalledChrome, resolveInstalledChrome } from "./ChromeAutomation.ts";

const withDiscovery = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  files: Readonly<Record<string, "File" | "Directory">> = {},
  env: NodeJS.ProcessEnv = {},
) => {
  const unavailableFileSystem = FileSystem.makeNoop({});
  return effect.pipe(
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessEnvironment, env),
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        stat: (filePath) => {
          const type = files[filePath];
          return type === undefined
            ? unavailableFileSystem.stat(filePath)
            : Effect.succeed({ type } as FileSystem.File.Info);
        },
      }),
    ),
    Effect.provide(NodePath.layerWin32),
  );
};

it.effect("reports no installed executable without turning the launch channel into readiness", () =>
  withDiscovery(
    Effect.gen(function* () {
      assert.equal(yield* findInstalledChrome(), undefined);
      assert.deepEqual(yield* resolveInstalledChrome(), {
        executablePath: undefined,
        channel: "chrome",
      });
    }),
  ),
);

it.effect("returns the explicit installed executable for readiness and launch", () => {
  const executablePath = "D:\\Managed Chrome\\chrome.exe";
  return withDiscovery(
    Effect.gen(function* () {
      assert.equal(yield* findInstalledChrome(), executablePath);
      assert.deepEqual(yield* resolveInstalledChrome(), { executablePath, channel: undefined });
    }),
    { [executablePath]: "File" },
    { CHROME_PATH: executablePath },
  );
});

it.effect("skips a directory override and discovers a standard Chrome executable", () => {
  const override = "D:\\Not a binary\\chrome.exe";
  const executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return withDiscovery(
    Effect.gen(function* () {
      assert.equal(yield* findInstalledChrome(), executablePath);
    }),
    { [override]: "Directory", [executablePath]: "File" },
    { CHROME_PATH: override },
  );
});

it.effect("discovers portable Chrome from PATH without a browser or profile operation", () => {
  const executablePath = "D:\\Portable\\chrome.exe";
  return withDiscovery(
    Effect.gen(function* () {
      assert.equal(yield* findInstalledChrome(), executablePath);
    }),
    { [executablePath]: "File" },
    { PATH: "D:\\Portable", PATHEXT: ".EXE" },
  );
});
