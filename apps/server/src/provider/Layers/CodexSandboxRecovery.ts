// @effect-diagnostics nodeBuiltinImport:off - This is a small synchronous boundary for the Windows sandbox state file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

const Fs = NodeFS;
const Os = NodeOS;
const Path = NodePath;

const DENY_READ_ACL_STATE_FILE = "deny_read_acl_state.json";
const QUARANTINE_SUFFIX = ".corrupt";
export const CODEX_SANDBOX_QUARANTINE_COLLISION_LIMIT = 16;

export interface CodexSandboxStateInspection {
  readonly path: string;
  readonly status: "missing" | "valid" | "corrupt" | "unsafe";
}

export interface CodexSandboxStateQuarantine {
  readonly path: string;
  readonly quarantinedPath: string;
}

export interface CodexSandboxStateRecovery {
  readonly path: string;
  readonly status: "quarantined" | "already-recovered";
  readonly quarantinedPath?: string;
}

const startupRecoveryFlights = new Map<string, Promise<CodexSandboxStateRecovery | undefined>>();

export function codexDenyReadAclStatePath(homeDirectory = Os.homedir()): string {
  return Path.join(Path.resolve(homeDirectory), ".codex", ".sandbox", DENY_READ_ACL_STATE_FILE);
}

export function codexDenyReadAclQuarantinePath(
  statePath: string,
  attempt: number,
  processId = process.pid,
): string {
  return `${statePath}${QUARANTINE_SUFFIX}-${processId}-${attempt}`;
}

function isSafeStatePath(path: string, homeDirectory: string): boolean {
  const home = Path.resolve(homeDirectory);
  const expectedParent = Path.join(home, ".codex", ".sandbox");
  return Path.dirname(path) === expectedParent && Path.basename(path) === DENY_READ_ACL_STATE_FILE;
}

function hasSafeDirectoryParents(path: string, homeDirectory: string): boolean {
  const home = Path.resolve(homeDirectory);
  const parents = [home, Path.join(home, ".codex"), Path.join(home, ".codex", ".sandbox")];
  return parents.every((parent) => {
    try {
      const stat = Fs.lstatSync(parent);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function isSafeQuarantinePath(path: string, statePath: string): boolean {
  const parent = Path.dirname(statePath);
  const relative = Path.relative(parent, path);
  return (
    Path.dirname(path) === parent &&
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !Path.isAbsolute(relative) &&
    !relative.includes(Path.sep) &&
    Path.basename(path).startsWith(`${DENY_READ_ACL_STATE_FILE}${QUARANTINE_SUFFIX}-`)
  );
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSafeExistingQuarantine(path: string, statePath: string): boolean {
  if (!isSafeQuarantinePath(path, statePath)) return false;
  try {
    const stat = Fs.lstatSync(path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      isCorruptDenyReadAclStateBytes(Fs.readFileSync(path))
    );
  } catch {
    return false;
  }
}

function findExistingQuarantine(statePath: string): string | undefined {
  const parent = Path.dirname(statePath);
  const prefix = `${Path.basename(statePath)}${QUARANTINE_SUFFIX}-`;
  try {
    for (const entry of Fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix) || !entry.isFile() || entry.isSymbolicLink()) continue;
      const candidate = Path.join(parent, entry.name);
      if (isSafeExistingQuarantine(candidate, statePath)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function hasSameFileIdentity(left: NodeFS.Stats, right: NodeFS.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathHasFileIdentity(path: string, identity: NodeFS.Stats): boolean {
  try {
    const pathStat = Fs.lstatSync(path);
    return (
      pathStat.isFile() &&
      !pathStat.isSymbolicLink() &&
      hasSameFileIdentity(Fs.statSync(path), identity)
    );
  } catch {
    return false;
  }
}

function closeFileDescriptor(fileDescriptor: number | undefined): void {
  if (fileDescriptor === undefined) return;
  try {
    Fs.closeSync(fileDescriptor);
  } catch {
    // Best-effort cleanup after the recovery decision.
  }
}

export function isCorruptDenyReadAclStateBytes(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes.every((byte) => byte === 0);
}

export function inspectCodexDenyReadAclState(
  homeDirectory = Os.homedir(),
  platform: string = Os.platform(),
): CodexSandboxStateInspection {
  const path = codexDenyReadAclStatePath(homeDirectory);
  if (platform !== "win32" || !isSafeStatePath(path, homeDirectory)) {
    return { path, status: "unsafe" };
  }

  let stat: NodeFS.Stats;
  try {
    stat = Fs.lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        path,
        status: hasSafeDirectoryParents(path, homeDirectory) ? "missing" : "unsafe",
      };
    }
    return { path, status: "unsafe" };
  }

  if (!hasSafeDirectoryParents(path, homeDirectory) || !stat.isFile() || stat.isSymbolicLink()) {
    return { path, status: "unsafe" };
  }

  try {
    return {
      path,
      status: isCorruptDenyReadAclStateBytes(Fs.readFileSync(path)) ? "corrupt" : "valid",
    };
  } catch {
    return { path, status: "unsafe" };
  }
}

function recoverCodexSandboxStateSync(
  homeDirectory: string,
  platform: string,
): CodexSandboxStateRecovery | undefined {
  let inspection = inspectCodexDenyReadAclState(homeDirectory, platform);
  if (inspection.status === "unsafe") return undefined;
  if (inspection.status === "valid") {
    return { path: inspection.path, status: "already-recovered" };
  }
  if (inspection.status === "missing") {
    const quarantinedPath = findExistingQuarantine(inspection.path);
    return quarantinedPath
      ? { path: inspection.path, quarantinedPath, status: "already-recovered" }
      : undefined;
  }

  for (let attempt = 0; attempt < CODEX_SANDBOX_QUARANTINE_COLLISION_LIMIT; attempt += 1) {
    const quarantinedPath = codexDenyReadAclQuarantinePath(inspection.path, attempt);
    if (!isSafeQuarantinePath(quarantinedPath, inspection.path)) return undefined;

    inspection = inspectCodexDenyReadAclState(homeDirectory, platform);
    if (inspection.status === "valid") {
      return { path: inspection.path, status: "already-recovered" };
    }
    if (inspection.status === "missing") {
      const existing = findExistingQuarantine(inspection.path);
      return existing
        ? { path: inspection.path, quarantinedPath: existing, status: "already-recovered" }
        : undefined;
    }
    if (inspection.status !== "corrupt") return undefined;

    let sourceDescriptor: number | undefined;
    let quarantineDescriptor: number | undefined;
    try {
      sourceDescriptor = Fs.openSync(inspection.path, Fs.constants.O_RDONLY);
      const sourceStat = Fs.fstatSync(sourceDescriptor);
      const sourceBytes = Fs.readFileSync(sourceDescriptor);
      if (
        !sourceStat.isFile() ||
        !isCorruptDenyReadAclStateBytes(sourceBytes) ||
        !hasSafeDirectoryParents(inspection.path, homeDirectory) ||
        !pathHasFileIdentity(inspection.path, sourceStat)
      ) {
        const current = inspectCodexDenyReadAclState(homeDirectory, platform);
        return current.status === "valid"
          ? { path: current.path, status: "already-recovered" }
          : undefined;
      }

      try {
        Fs.linkSync(inspection.path, quarantinedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        const current = inspectCodexDenyReadAclState(homeDirectory, platform);
        if (current.status === "valid") {
          return { path: current.path, status: "already-recovered" };
        }
        if (current.status === "missing") {
          const existing = findExistingQuarantine(current.path);
          return existing
            ? { path: current.path, quarantinedPath: existing, status: "already-recovered" }
            : undefined;
        }
        return undefined;
      }

      quarantineDescriptor = Fs.openSync(quarantinedPath, Fs.constants.O_RDONLY);
      const quarantineStat = Fs.fstatSync(quarantineDescriptor);
      const quarantineBytes = Fs.readFileSync(quarantineDescriptor);
      const preserved =
        quarantineStat.isFile() &&
        hasSameFileIdentity(sourceStat, quarantineStat) &&
        quarantineBytes.length === sourceBytes.length &&
        isCorruptDenyReadAclStateBytes(quarantineBytes) &&
        hasSafeDirectoryParents(inspection.path, homeDirectory) &&
        isSafeQuarantinePath(quarantinedPath, inspection.path) &&
        pathHasFileIdentity(quarantinedPath, quarantineStat);
      if (!preserved) {
        const current = inspectCodexDenyReadAclState(homeDirectory, platform);
        return current.status === "valid"
          ? { path: current.path, status: "already-recovered" }
          : undefined;
      }

      if (
        !hasSafeDirectoryParents(inspection.path, homeDirectory) ||
        !pathHasFileIdentity(inspection.path, sourceStat)
      ) {
        const current = inspectCodexDenyReadAclState(homeDirectory, platform);
        if (current.status === "valid") {
          return { path: current.path, status: "already-recovered" };
        }
        return current.status === "missing"
          ? { path: current.path, quarantinedPath, status: "already-recovered" }
          : undefined;
      }

      // Node does not expose handle-relative link or unlink operations on Windows. Rechecking
      // the parent chain and both file identities narrows the remaining race to the interval
      // between this final identity check and unlinkSync.
      Fs.unlinkSync(inspection.path);
      if (
        !hasSafeDirectoryParents(inspection.path, homeDirectory) ||
        !pathHasFileIdentity(quarantinedPath, quarantineStat)
      ) {
        return undefined;
      }

      const current = inspectCodexDenyReadAclState(homeDirectory, platform);
      return current.status === "missing" || current.status === "valid"
        ? { path: current.path, quarantinedPath, status: "quarantined" }
        : undefined;
    } catch {
      const current = inspectCodexDenyReadAclState(homeDirectory, platform);
      if (current.status === "valid") {
        return { path: current.path, status: "already-recovered" };
      }
      if (current.status === "missing") {
        const existing = findExistingQuarantine(current.path);
        return existing
          ? { path: current.path, quarantinedPath: existing, status: "already-recovered" }
          : undefined;
      }
      return undefined;
    } finally {
      closeFileDescriptor(quarantineDescriptor);
      closeFileDescriptor(sourceDescriptor);
    }
  }

  return undefined;
}

function recoveryKey(homeDirectory: string): string {
  return codexDenyReadAclStatePath(homeDirectory).toLocaleLowerCase("en-US");
}

export function recoverCodexDenyReadAclState(
  input: {
    readonly homeDirectory?: string;
    readonly platform?: string;
  } = {},
): Effect.Effect<CodexSandboxStateRecovery | undefined> {
  const homeDirectory = input.homeDirectory ?? Os.homedir();
  const platform = input.platform ?? Os.platform();
  return Effect.promise(() => {
    const key = recoveryKey(homeDirectory);
    const active = startupRecoveryFlights.get(key);
    if (active) return active;

    const flight = Promise.resolve()
      .then(() => {
        try {
          return recoverCodexSandboxStateSync(homeDirectory, platform);
        } catch {
          return undefined;
        }
      })
      .finally(() => {
        if (startupRecoveryFlights.get(key) === flight) startupRecoveryFlights.delete(key);
      });
    startupRecoveryFlights.set(key, flight);
    return flight;
  });
}

export function quarantineCorruptCodexDenyReadAclState(
  input: {
    readonly homeDirectory?: string;
    readonly platform?: string;
  } = {},
): Effect.Effect<CodexSandboxStateQuarantine | undefined> {
  return recoverCodexDenyReadAclState(input).pipe(
    Effect.map((recovery) =>
      recovery?.status === "quarantined" && recovery.quarantinedPath
        ? { path: recovery.path, quarantinedPath: recovery.quarantinedPath }
        : undefined,
    ),
  );
}

const isCodexProcessExit = Schema.is(CodexErrors.CodexAppServerProcessExitedError);

export function isConfirmedCorruptCodexSandboxExit(error: unknown): boolean {
  if (!isCodexProcessExit(error) || error.code !== 1) return false;
  const stderr = error.stderr?.toLowerCase() ?? "";
  return (
    stderr.includes("deny_read_acl_state.json") &&
    (stderr.includes("expected value at line 1 column 1") ||
      stderr.includes("parse deny-read acl state"))
  );
}

export function shouldRecoverCodexSandboxExit(
  error: unknown,
  homeDirectory = Os.homedir(),
): boolean {
  return (
    isConfirmedCorruptCodexSandboxExit(error) &&
    inspectCodexDenyReadAclState(homeDirectory).status === "corrupt"
  );
}

export function withCodexSandboxStartupRecovery<A, E, R>(input: {
  readonly run: () => Effect.Effect<A, E, R>;
  readonly homeDirectory?: string;
  readonly platform?: string;
}): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const first = yield* Effect.result(input.run());
    if (first._tag === "Success") return first.success;
    if (!isConfirmedCorruptCodexSandboxExit(first.failure)) {
      return yield* Effect.fail(first.failure);
    }

    const recovery = yield* recoverCodexDenyReadAclState(
      input.homeDirectory === undefined && input.platform === undefined
        ? {}
        : {
            ...(input.homeDirectory === undefined ? {} : { homeDirectory: input.homeDirectory }),
            ...(input.platform === undefined ? {} : { platform: input.platform }),
          },
    );
    if (!recovery) return yield* Effect.fail(first.failure);
    return yield* input.run();
  });
}
