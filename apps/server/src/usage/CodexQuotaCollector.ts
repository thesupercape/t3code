import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as NodeOS from "node:os";

import type { UsageQuotaSample } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  codexAppServerCommandArgs,
  type CodexAppServerTransport,
} from "../provider/CodexAppServerTransport.ts";
import {
  makeCodexDesktopDaemonStdio,
  useCodexDesktopDaemonSocketTransport,
} from "../provider/CodexDesktopDaemonTransport.ts";
import { expandHomePath } from "../pathExpansion.ts";

const FORCE_KILL_AFTER = "2 seconds" as const;

/** The Codex Limits tracker records only the main weekly Codex window. */
const CODEX_LIMIT_ID = "codex";
const CODEX_WINDOW_MINUTES = 10_080;

export interface CodexQuotaCollectorInput {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly transport: CodexAppServerTransport;
  /** Only process variables needed to locate and authenticate the CLI. */
  readonly environment: {
    readonly PATH?: string | undefined;
    readonly HOME?: string | undefined;
    readonly CODEX_HOME?: string | undefined;
  };
  readonly launchArgs?: ReadonlyArray<string>;
  readonly cwd: string;
}

type RateLimitWindow = CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow;
type RateLimitSnapshot = CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot;
type RateLimitsResponse = CodexSchema.V2GetAccountRateLimitsResponse;

/** Both transports expose the same read-only rate-limit method. */
export function isSafeCodexQuotaTransport(transport: CodexAppServerTransport): boolean {
  return transport === "desktop-daemon" || transport === "stdio";
}

function mainSnapshot(response: RateLimitsResponse): RateLimitSnapshot | null {
  const byLimitId = response.rateLimitsByLimitId;
  if (byLimitId !== undefined && byLimitId !== null) {
    // A map is authoritative. Falling back to the legacy field when it is
    // present but does not contain Codex could attribute another allowance to
    // the weekly Codex tracker.
    return Object.prototype.hasOwnProperty.call(byLimitId, CODEX_LIMIT_ID)
      ? (byLimitId[CODEX_LIMIT_ID] ?? null)
      : null;
  }

  // Older app-server versions returned the weekly window directly. If a
  // newer response names another limit, fail closed instead of recording it as
  // Codex usage.
  const legacy = response.rateLimits;
  return legacy.limitId === undefined ||
    legacy.limitId === null ||
    legacy.limitId === CODEX_LIMIT_ID
    ? legacy
    : null;
}

/**
 * Build the allowlisted environment used by the short-lived app-server
 * process. In particular, do not let an API key or an unrelated provider
 * variable leak into this child. `HOME` is explicit so direct stdio and the
 * desktop bridge resolve the same Codex home as the parent.
 */
export function codexQuotaChildEnvironment(
  environment: CodexQuotaCollectorInput["environment"],
  homePath?: string,
): NodeJS.ProcessEnv {
  const resolvedHomePath = homePath
    ? expandHomePath(homePath)
    : environment.CODEX_HOME
      ? expandHomePath(environment.CODEX_HOME)
      : undefined;
  return {
    ...(environment.PATH ? { PATH: environment.PATH } : {}),
    HOME: environment.HOME ?? NodeOS.homedir(),
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
}

/**
 * Convert one app-server response to the same sanitized sample shape used by
 * the external Codex Limits tracker. No account identity or raw response data
 * is retained.
 */
export function quotaSampleFromRateLimits(
  response: RateLimitsResponse,
  observedAtMs: number,
): UsageQuotaSample | null {
  if (!Number.isFinite(observedAtMs)) return null;
  const snapshot = mainSnapshot(response);
  const window: RateLimitWindow | null =
    [snapshot?.primary, snapshot?.secondary].find(
      (candidate) => candidate?.windowDurationMins === CODEX_WINDOW_MINUTES,
    ) ?? null;
  if (
    window === null ||
    window.windowDurationMins !== CODEX_WINDOW_MINUTES ||
    !Number.isInteger(window.usedPercent) ||
    window.usedPercent < 0 ||
    window.usedPercent > 100 ||
    window.resetsAt === undefined ||
    window.resetsAt === null ||
    !Number.isFinite(window.resetsAt)
  ) {
    return null;
  }

  const resetsAtMs = window.resetsAt * 1_000;
  if (!Number.isFinite(resetsAtMs) || resetsAtMs < observedAtMs) return null;
  return {
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(observedAtMs)),
    remainingPercent: 100 - window.usedPercent,
    resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)),
  };
}

/** Read the current weekly Codex allowance over the authenticated app-server protocol. */
export const readCodexQuotaSample = Effect.fn("CodexQuotaCollector.read")(function* (
  input: CodexQuotaCollectorInput,
) {
  return yield* Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = codexQuotaChildEnvironment(input.environment, input.homePath);
    const useDesktopDaemonSocket = useCodexDesktopDaemonSocketTransport(input.transport, platform);
    const clientContext = useDesktopDaemonSocket
      ? yield* Layer.build(
          CodexClient.layer(
            yield* makeCodexDesktopDaemonStdio(
              input.homePath ? expandHomePath(input.homePath) : undefined,
              environment,
            ),
          ),
        )
      : yield* Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const commandArgs = codexAppServerCommandArgs(
            useDesktopDaemonSocket ? input.transport : "stdio",
            input.launchArgs,
          );
          const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, commandArgs, {
            env: environment,
            extendEnv: false,
          });
          const child = yield* spawner.spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: input.cwd,
              env: environment,
              extendEnv: false,
              shell: spawnCommand.shell,
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          );
          return yield* Layer.build(CodexClient.layerChildProcess(child));
        });
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    yield* client.request("initialize", {
      clientInfo: {
        name: "t3code_usage_tracker",
        title: "T3 Code Usage Tracker",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    yield* client.notify("initialized", undefined);
    const response = yield* client.request("account/rateLimits/read", undefined);
    const observedAtMs = yield* Clock.currentTimeMillis;
    return quotaSampleFromRateLimits(response, observedAtMs);
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => null),
  );
});
