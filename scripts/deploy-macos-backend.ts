// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalConsole:off - This is an intentionally standalone macOS operator script boundary.
/**
 * Guarded deployment helper for the Millie T3 backend.
 *
 * The default mode is a no-write plan.  `--execute` is deliberately explicit
 * and requires an exact source commit, a fresh backup root, a fresh smoke
 * home, and the PID of the process that the operator already inspected.
 * Nothing in this module guesses ownership of a port or a LaunchAgent.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const DEFAULT_BASE_DIR = "/Users/millie/.t3";
export const DEFAULT_CANDIDATE =
  "/Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/backend-candidate";
export const DEFAULT_NODE = "/Users/millie/.local/lib/node-v24.18.0/bin/node";
export const DEFAULT_OLD_ENTRY =
  "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs";
export const DEFAULT_LABEL = "com.christinesmith.t3-fork.backend";
export const DEFAULT_PORT = 3773;
export const DEFAULT_SMOKE_PORT = 38773;
export const DEPLOYMENT_MARKER = "t3-fork-backend-deployment-v1";
export const WRAPPER_MARKER = `# ${DEPLOYMENT_MARKER}`;

const VALID_PID = /^[1-9][0-9]*$/;
const VALID_SHA = /^[0-9a-f]{40}$/i;
const VALID_LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,126}$/;

export interface BackendDeployOptions {
  readonly candidate: string;
  readonly commit: string;
  readonly baseDir: string;
  readonly nodePath: string;
  readonly oldEntry: string;
  readonly oldNodePath: string;
  readonly backupRoot: string;
  readonly smokeHome: string;
  readonly port: number;
  readonly smokePort: number;
  readonly label: string;
  readonly expectedOldPid: number | undefined;
  readonly dryRun: boolean;
}

export interface LsofListener {
  readonly pid: number;
  readonly name: string;
}

export interface ProcessIdentityInput {
  readonly expectedPid: number;
  readonly actualPid: number;
  readonly command: string;
  readonly oldEntry: string;
  readonly baseDir: string;
  readonly host: string;
  readonly port: number;
}

export class DeploymentGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentGuardError";
  }
}

const fail = (message: string): never => {
  throw new DeploymentGuardError(message);
};

const absolute = (value: string, name: string): string => {
  if (!NodePath.isAbsolute(value)) fail(`${name} must be an absolute path.`);
  return NodePath.normalize(value);
};

const validatePort = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${name} must be an integer between 1 and 65535.`);
  }
  return value;
};

export const validateOptions = (input: BackendDeployOptions): BackendDeployOptions => {
  const candidate = absolute(input.candidate, "--candidate");
  const baseDir = absolute(input.baseDir, "--base-dir");
  const nodePath = absolute(input.nodePath, "--node");
  const oldEntry = absolute(input.oldEntry, "--old-entry");
  const oldNodePath = absolute(input.oldNodePath, "--old-node");
  const backupRoot = absolute(input.backupRoot, "--backup-root");
  const smokeHome = absolute(input.smokeHome, "--smoke-home");
  if (!VALID_SHA.test(input.commit)) fail("--commit must be the full 40-character SHA.");
  if (!VALID_LABEL.test(input.label)) fail("--label contains invalid LaunchAgent characters.");
  if (input.port === input.smokePort) fail("--smoke-port must differ from the live --port.");
  validatePort(input.port, "--port");
  validatePort(input.smokePort, "--smoke-port");
  if (input.expectedOldPid !== undefined && !VALID_PID.test(String(input.expectedOldPid))) {
    fail("--expected-old-pid must be a positive integer.");
  }
  if (!input.dryRun && input.expectedOldPid === undefined) {
    fail("--execute requires --expected-old-pid from the operator's fresh inspection.");
  }
  if (baseDir === "/" || candidate === "/" || backupRoot === "/" || smokeHome === "/") {
    fail("refusing a filesystem root as an operational path.");
  }
  return {
    ...input,
    candidate,
    baseDir,
    nodePath,
    oldEntry,
    oldNodePath,
    backupRoot,
    smokeHome,
    commit: input.commit.toLowerCase(),
  };
};

const optionalLstat = async (path: string): Promise<NodeFS.Stats | undefined> => {
  try {
    return await NodeFSP.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const requireNoSymlink = async (path: string, description: string): Promise<NodeFS.Stats> => {
  const stat = await optionalLstat(path);
  if (!stat) throw new DeploymentGuardError(`${description} is missing: ${path}`);
  if (stat.isSymbolicLink()) fail(`${description} must not be a symlink: ${path}`);
  return stat;
};

const ensurePrivateDirectory = async (path: string, description: string, fresh: boolean) => {
  const existing = await optionalLstat(path);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      fail(`${description} must be a real directory: ${path}`);
    }
    if (fresh) fail(`${description} must not already exist: ${path}`);
    return;
  }
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(path, 0o700);
};

const walkSymlinksInside = async (root: string): Promise<void> => {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = NodePath.join(root, entry.name);
    const stat = await NodeFSP.lstat(path);
    if (stat.isSymbolicLink()) {
      let target: string | undefined;
      try {
        target = await NodeFSP.realpath(path);
      } catch {
        fail(`candidate contains an unresolved symlink: ${path}`);
      }
      if (target === undefined) fail(`candidate symlink target could not be resolved: ${path}`);
      const relative = NodePath.relative(root, target as string);
      if (relative.startsWith("..") || NodePath.isAbsolute(relative))
        fail(`candidate symlink escapes its bundle: ${path}`);
      continue;
    }
    if (stat.isDirectory()) await walkSymlinksInside(path);
  }
};

export const candidateEntryPath = async (candidate: string): Promise<string> => {
  const candidates = [
    NodePath.join(candidate, "dist/bin.mjs"),
    NodePath.join(candidate, "apps/server/dist/bin.mjs"),
  ];
  for (const path of candidates) {
    if (await optionalLstat(path)) return path;
  }
  return fail("candidate is missing dist/bin.mjs.");
};

export const candidateCommitMarkerPaths = (candidate: string): ReadonlyArray<string> => [
  NodePath.join(candidate, ".t3-source-commit"),
  NodePath.join(candidate, "SOURCE_COMMIT"),
];

export const validateCandidate = async (options: BackendDeployOptions): Promise<void> => {
  await requireNoSymlink(options.candidate, "candidate");
  const entry = await candidateEntryPath(options.candidate);
  await requireNoSymlink(entry, "candidate server entry");
  // npm/pnpm dependency trees legitimately contain package-manager symlinks.
  // Only the executable bundle itself is containment-checked; runtime package
  // links are followed below and must still resolve to a directory.
  await walkSymlinksInside(NodePath.dirname(entry));
  const runtimeDependencyCandidates = [
    NodePath.join(options.candidate, "node_modules/node-pty"),
    NodePath.join(options.candidate, "apps/server/node_modules/node-pty"),
  ];
  let hasRuntimeDependency = false;
  for (const path of runtimeDependencyCandidates) {
    const stat = await optionalLstat(path);
    if (!stat) continue;
    let targetStat: NodeFS.Stats | undefined;
    try {
      targetStat = await NodeFSP.stat(path);
    } catch {
      fail(`bundled node-pty dependency is unresolved: ${path}`);
    }
    if (!targetStat || !targetStat.isDirectory())
      fail(`bundled node-pty dependency is unsafe: ${path}`);
    hasRuntimeDependency = true;
    break;
  }
  if (!hasRuntimeDependency) {
    fail("candidate is missing the bundled node-pty runtime dependency.");
  }
  const markers: string[] = [];
  for (const markerPath of candidateCommitMarkerPaths(options.candidate)) {
    const stat = await optionalLstat(markerPath);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      fail(`candidate commit marker is unsafe: ${markerPath}`);
    markers.push((await NodeFSP.readFile(markerPath, "utf8")).trim());
  }
  if (markers.length === 0 || markers.some((marker) => marker !== options.commit)) {
    fail("candidate commit marker does not match --commit; refusing to install an unpinned build.");
  }
};

export const parseLsofListeners = (
  output: string,
  host: string,
  port: number,
): ReadonlyArray<LsofListener> => {
  const listeners: LsofListener[] = [];
  let pid: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = VALID_PID.test(String(parsed)) ? parsed : undefined;
      continue;
    }
    if (!line.startsWith("n") || pid === undefined) continue;
    const name = line.slice(1);
    if (name === `${host}:${port}` || name === `[${host}]:${port}`) listeners.push({ pid, name });
  }
  return listeners;
};

export const assertSingleLoopbackListener = (
  listeners: ReadonlyArray<LsofListener>,
  expectedPid: number,
): void => {
  if (listeners.length !== 1)
    fail(`expected one exact loopback listener, observed ${listeners.length}.`);
  if (listeners[0]?.pid !== expectedPid) {
    fail(
      `listener PID ${String(listeners[0]?.pid ?? "unknown")} does not match expected PID ${expectedPid}.`,
    );
  }
};

export const assertProcessIdentity = (input: ProcessIdentityInput): void => {
  if (input.actualPid !== input.expectedPid)
    fail("the observed listener PID changed; refusing to stop an unowned process.");
  const tokens = input.command.trim().split(/\s+/);
  const oldEntryAlias = NodePath.join(
    NodePath.dirname(NodePath.dirname(input.oldEntry)),
    "..",
    ".bin",
    "t3",
  );
  if (!tokens.includes(input.oldEntry) && !tokens.includes(oldEntryAlias)) {
    fail("old server command is missing its exact T3 entry identity guard.");
  }
  const flags: ReadonlyArray<readonly [string, string]> = [
    ["--base-dir", input.baseDir],
    ["--host", input.host],
    ["--port", String(input.port)],
  ];
  for (const [flag, value] of flags) {
    const index = tokens.indexOf(flag);
    if (index < 0 || tokens[index + 1] !== value)
      fail(`old server command is missing its exact ${flag} identity guard.`);
  }
};

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const renderWrapper = (nodePath: string, installPath: string): string => {
  return [
    "#!/bin/sh",
    WRAPPER_MARKER,
    "set -eu",
    `exec ${shellQuote(nodePath)} ${shellQuote(NodePath.join(installPath, "dist/bin.mjs"))} "$@"`,
    "",
  ].join("\n");
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const renderLaunchAgentPlist = (input: {
  readonly label: string;
  readonly commit: string;
  readonly wrapperPath: string;
  readonly baseDir: string;
  readonly port: number;
  readonly environment: Readonly<Record<string, string>>;
}): string => {
  const safeEnvironment: Record<string, string> = {};
  for (const key of [
    "HOME",
    "PATH",
    "CODEX_HOME",
    "CODEX_BIN",
    "CODEX_APP_SERVER_TRANSPORT",
    "CODEX_APP_SERVER_BIN",
  ]) {
    const value = input.environment[key];
    if (value !== undefined && value !== "") safeEnvironment[key] = value;
  }
  const environment = Object.entries({
    ...safeEnvironment,
    HOME: input.environment.HOME ?? "/Users/millie",
    T3CODE_HOME: input.baseDir,
    T3CODE_HOST: "127.0.0.1",
    T3CODE_PORT: String(input.port),
    T3CODE_NO_BROWSER: "true",
    T3_FORK_DEPLOYMENT_MARKER: DEPLOYMENT_MARKER,
    T3_FORK_DEPLOYMENT_COMMIT: input.commit,
  }).sort(([a], [b]) => a.localeCompare(b));
  const envXml = environment
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  const args = [
    input.wrapperPath,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--base-dir",
    input.baseDir,
  ];
  const argsXml = args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(NodePath.join(input.baseDir, "userdata/logs/t3-fork-backend.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(NodePath.join(input.baseDir, "userdata/logs/t3-fork-backend.error.log"))}</string>
</dict>
</plist>
`;
};

export const isOwnedWrapper = (content: string): boolean =>
  content.startsWith(`#!/bin/sh\n${WRAPPER_MARKER}\n`);

export const isOwnedPlist = (content: string, label: string): boolean =>
  content.includes(`<string>${xml(label)}</string>`) &&
  content.includes(`<string>${DEPLOYMENT_MARKER}</string>`);

export const assertOwnedDestinationContent = (
  content: string,
  kind: "wrapper" | "plist",
  label: string,
): void => {
  const owned = kind === "wrapper" ? isOwnedWrapper(content) : isOwnedPlist(content, label);
  if (!owned) fail(`${kind} destination is not owned by this deployment helper.`);
};

export const assertLaunchAgentState = (
  loaded: boolean,
  plistContent: string | undefined,
  label: string,
): void => {
  if (plistContent !== undefined) assertOwnedDestinationContent(plistContent, "plist", label);
  if (loaded && plistContent === undefined) {
    fail(
      "LaunchAgent label is loaded without a matching on-disk owned plist; refusing to claim it.",
    );
  }
};

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const copyIfPresent = async (source: string, destination: string): Promise<boolean> => {
  const stat = await optionalLstat(source);
  if (!stat) return false;
  if (stat.isSymbolicLink()) fail(`refusing to back up a symlink: ${source}`);
  await NodeFSP.cp(source, destination, {
    recursive: stat.isDirectory(),
    force: false,
    errorOnExist: true,
  });
  return true;
};

const runCommand = async (command: string, args: ReadonlyArray<string>, timeout = 30_000) => {
  try {
    const result = await execFile(command, [...args], {
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (error) {
    const child = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number | null;
    };
    return { stdout: child.stdout ?? "", stderr: child.stderr ?? "", code: child.status ?? 1 };
  }
};

const requireCommandSuccess = async (
  command: string,
  args: ReadonlyArray<string>,
  description: string,
  timeout = 30_000,
) => {
  const result = await runCommand(command, args, timeout);
  if (result.code !== 0) fail(`${description} failed; refusing to continue.`);
  return result.stdout;
};

const inspectListeners = async (
  options: BackendDeployOptions,
  allowEmpty = false,
): Promise<ReadonlyArray<LsofListener>> => {
  const result = await runCommand("lsof", [
    "-nP",
    `-iTCP:${options.port}`,
    "-sTCP:LISTEN",
    "-Fpctn",
  ]);
  if (result.code !== 0) {
    if (allowEmpty && result.stdout.trim() === "" && result.stderr.trim() === "") return [];
    fail("lsof could not inspect the live listener; refusing to claim ownership.");
  }
  const occupiedNames = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter((name) => name.endsWith(`:${options.port}`));
  if (
    occupiedNames.some(
      (name) => name !== `127.0.0.1:${options.port}` && name !== `[127.0.0.1]:${options.port}`,
    )
  ) {
    fail(
      `port ${options.port} has a non-loopback or ambiguous listener; refusing to claim ownership.`,
    );
  }
  return parseLsofListeners(result.stdout, "127.0.0.1", options.port);
};

const assertPortFree = async (port: number): Promise<void> => {
  const result = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpctn"]);
  if (result.code === 0 && result.stdout.trim() !== "")
    fail(`smoke port ${port} is already occupied; refusing to trust smoke health.`);
  if (result.code !== 0 && (result.stdout.trim() !== "" || result.stderr.trim() !== ""))
    fail(`could not prove smoke port ${port} is free.`);
};

const assertSmokeChildOwnsPort = async (
  child: NodeChildProcess.ChildProcess,
  port: number,
): Promise<void> => {
  if (child.pid === undefined)
    fail("candidate smoke process has no PID; refusing to trust smoke health.");
  const result = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpctn"]);
  if (result.code !== 0) fail("could not verify the candidate smoke listener owner.");
  const names = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n") && line.slice(1).endsWith(`:${port}`))
    .map((line) => line.slice(1));
  if (
    names.length !== 1 ||
    (names[0] !== `127.0.0.1:${port}` && names[0] !== `[127.0.0.1]:${port}`)
  ) {
    fail("candidate smoke listener is not an unambiguous loopback listener.");
  }
  const listeners = parseLsofListeners(result.stdout, "127.0.0.1", port);
  assertSingleLoopbackListener(listeners, child.pid as number);
};

const currentCommand = async (pid: number): Promise<string> => {
  const result = await runCommand("ps", ["-p", String(pid), "-o", "command="]);
  if (result.code !== 0 || result.stdout.trim() === "")
    fail(`could not inspect command for PID ${pid}.`);
  return result.stdout.trim() as string;
};

const readEnvironmentId = async (baseDir: string): Promise<string> => {
  const id = (await readText(NodePath.join(baseDir, "userdata/environment-id")))?.trim();
  if (!id) fail("live T3 environment-id is absent; refusing to restart.");
  return id as string;
};

const sqliteQuery = async (dbPath: string, query: string, description: string): Promise<string> => {
  return (await requireCommandSuccess("sqlite3", ["-readonly", dbPath, query], description)).trim();
};

const sqliteColumns = async (dbPath: string, table: string): Promise<ReadonlySet<string>> => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) fail("invalid SQLite table name in idle guard.");
  const rows = await sqliteQuery(dbPath, `PRAGMA table_info(${table});`, `inspect ${table} schema`);
  const columns = new Set<string>();
  for (const row of rows.split(/\r?\n/)) {
    const column = row.split("|")[1];
    if (column) columns.add(column);
  }
  return columns;
};

const requireSqliteColumns = async (
  dbPath: string,
  table: string,
  required: ReadonlyArray<string>,
) => {
  const columns = await sqliteColumns(dbPath, table);
  if (columns.size === 0 || required.some((column) => !columns.has(column))) {
    fail(`SQLite idle guard cannot prove the ${table} schema; refusing to restart.`);
  }
};

export const idleGuardQueries = {
  unknownRuntime:
    "SELECT COUNT(*) FROM provider_session_runtime WHERE status IS NULL OR status NOT IN ('starting','running','stopped','error');",
  activeRuntime:
    "SELECT COUNT(*) FROM provider_session_runtime WHERE status IN ('starting','running');",
  unknownSessions:
    "SELECT COUNT(*) FROM projection_thread_sessions WHERE status IS NULL OR status NOT IN ('idle','starting','running','ready','interrupted','stopped','error');",
  unknownApprovals:
    "SELECT COUNT(*) FROM projection_pending_approvals WHERE status IS NULL OR status NOT IN ('pending','resolved','stale');",
  invalidInputs:
    "SELECT COUNT(*) FROM projection_threads WHERE pending_user_input_count IS NULL OR pending_user_input_count < 0;",
  unaccountedProjectionActivity:
    "SELECT COUNT(*) FROM projection_thread_sessions AS s LEFT JOIN provider_session_runtime AS r ON r.thread_id = s.thread_id WHERE (s.status IN ('starting','running') OR s.active_turn_id IS NOT NULL) AND (r.thread_id IS NULL OR r.status NOT IN ('stopped','error'));",
  pendingApprovals:
    "SELECT COUNT(*) FROM projection_pending_approvals AS a LEFT JOIN provider_session_runtime AS r ON r.thread_id = a.thread_id WHERE a.status = 'pending' AND (r.thread_id IS NULL OR r.status NOT IN ('stopped','error'));",
  pendingInputs:
    "SELECT COUNT(*) FROM projection_threads AS t LEFT JOIN provider_session_runtime AS r ON r.thread_id = t.thread_id WHERE t.pending_user_input_count > 0 AND (r.thread_id IS NULL OR r.status NOT IN ('stopped','error'));",
} as const;

const sqliteCount = async (dbPath: string, query: string, description: string): Promise<number> => {
  const value = await sqliteQuery(dbPath, query, description);
  if (!/^\d+$/.test(value))
    fail(`${description} returned an uncertain count; refusing to restart.`);
  return Number(value);
};

/**
 * The agent snapshot command is intentionally not used here.  On some T3
 * builds it runs migrations before returning its supposedly read-only JSON.
 * This guard only uses sqlite3 -readonly and fails closed on schema drift.
 */
export const assertLiveIdleReadOnly = async (dbPath: string): Promise<void> => {
  await requireNoSymlink(dbPath, "live SQLite database");
  await requireSqliteColumns(dbPath, "projection_thread_sessions", [
    "thread_id",
    "status",
    "active_turn_id",
  ]);
  await requireSqliteColumns(dbPath, "projection_pending_approvals", [
    "request_id",
    "thread_id",
    "status",
  ]);
  await requireSqliteColumns(dbPath, "projection_threads", [
    "thread_id",
    "pending_user_input_count",
  ]);
  await requireSqliteColumns(dbPath, "provider_session_runtime", ["thread_id", "status"]);
  const unknownRuntime = await sqliteCount(
    dbPath,
    idleGuardQueries.unknownRuntime,
    "SQLite provider runtime status guard",
  );
  const activeRuntime = await sqliteCount(
    dbPath,
    idleGuardQueries.activeRuntime,
    "SQLite active provider runtime guard",
  );
  const unknownSessions = await sqliteCount(
    dbPath,
    idleGuardQueries.unknownSessions,
    "SQLite session status guard",
  );
  const unknownApprovals = await sqliteCount(
    dbPath,
    idleGuardQueries.unknownApprovals,
    "SQLite approval status guard",
  );
  const invalidInputs = await sqliteCount(
    dbPath,
    idleGuardQueries.invalidInputs,
    "SQLite pending-input guard",
  );
  // provider_session_runtime is authoritative for live provider work. Older
  // projection rows can retain active_turn_id after a stopped runtime; only
  // an active or unknown runtime, or an unaccounted projection, blocks us.
  const unaccountedProjectionActivity = await sqliteCount(
    dbPath,
    idleGuardQueries.unaccountedProjectionActivity,
    "SQLite projection/runtime reconciliation guard",
  );
  const pendingApprovals = await sqliteCount(
    dbPath,
    idleGuardQueries.pendingApprovals,
    "SQLite pending-approval guard",
  );
  const pendingInputs = await sqliteCount(
    dbPath,
    idleGuardQueries.pendingInputs,
    "SQLite pending-input count guard",
  );
  if (
    unknownRuntime ||
    activeRuntime ||
    unknownSessions ||
    unknownApprovals ||
    invalidInputs ||
    unaccountedProjectionActivity ||
    pendingApprovals ||
    pendingInputs
  ) {
    fail(
      "T3 is not idle (active session, approval, user input, or unknown state); refusing to restart.",
    );
  }
};

const waitForHttp = async (
  port: number,
  expectedEnvironmentId?: string,
  timeoutMs = 60_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as { environmentId?: unknown };
      if (expectedEnvironmentId !== undefined && body.environmentId !== expectedEnvironmentId)
        fail("health identity does not match the preserved T3 environment.");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  void lastError;
  fail(`HTTP health did not pass on loopback port ${port}.`);
};

const spawnServer = (
  nodePath: string,
  entry: string,
  home: string,
  port: number,
  env: NodeJS.ProcessEnv,
) =>
  NodeChildProcess.spawn(
    nodePath,
    [entry, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", home],
    {
      env: {
        ...env,
        HOME: env.HOME ?? NodeOS.homedir(),
        T3CODE_HOME: home,
        T3CODE_HOST: "127.0.0.1",
        T3CODE_PORT: String(port),
        T3CODE_NO_BROWSER: "true",
      },
      stdio: "ignore",
    },
  );

const stopChild = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const runIsolatedSmoke = async (options: BackendDeployOptions): Promise<void> => {
  await ensurePrivateDirectory(options.smokeHome, "smoke home", true);
  await assertPortFree(options.smokePort);
  const child = spawnServer(
    options.nodePath,
    await candidateEntryPath(options.candidate),
    options.smokeHome,
    options.smokePort,
    process.env,
  );
  try {
    await waitForHttp(options.smokePort, undefined, 90_000);
    if (child.exitCode !== null) fail("candidate smoke process exited before health completed.");
    await assertSmokeChildOwnsPort(child, options.smokePort);
  } finally {
    await stopChild(child);
    await NodeFSP.rm(options.smokeHome, { recursive: true, force: true });
  }
};

const ensureOwnedDestination = async (
  path: string,
  kind: "wrapper" | "plist",
  label: string,
): Promise<void> => {
  const stat = await optionalLstat(path);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile())
    fail(`${kind} destination is not a regular file: ${path}`);
  const content = await NodeFSP.readFile(path, "utf8");
  try {
    assertOwnedDestinationContent(content, kind, label);
  } catch (error) {
    if (error instanceof DeploymentGuardError) fail(`${error.message}: ${path}`);
    throw error;
  }
};

const atomicWriteOwned = async (
  path: string,
  content: string,
  mode: number,
  kind: "wrapper" | "plist",
  label: string,
) => {
  await ensureOwnedDestination(path, kind, label);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${NodeCrypto.randomUUID()}`;
  const handle = await NodeFSP.open(temp, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  try {
    await ensureOwnedDestination(path, kind, label);
    await NodeFSP.rename(temp, path);
    await NodeFSP.chmod(path, mode);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true });
    throw error;
  }
};

const backupDatabase = async (dbPath: string, destination: string): Promise<void> => {
  await requireNoSymlink(dbPath, "live SQLite database");
  const escaped = destination.replaceAll("'", "''");
  await requireCommandSuccess(
    "sqlite3",
    ["-readonly", dbPath, `PRAGMA busy_timeout=5000; VACUUM INTO '${escaped}';`],
    "consistent SQLite backup",
    180_000,
  );
  const check = await requireCommandSuccess(
    "sqlite3",
    ["-readonly", destination, "PRAGMA integrity_check;"],
    "SQLite integrity check",
    180_000,
  );
  if (check.trim() !== "ok") fail("SQLite integrity check did not return ok.");
};

const backupConfig = async (baseDir: string, destination: string): Promise<void> => {
  const state = NodePath.join(baseDir, "userdata");
  const files = [
    "settings.json",
    "keybindings.json",
    "environment-id",
    "anonymous-id",
    "server-runtime.json",
  ];
  const directories = ["secrets", "providers", "attachments"];
  await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const relative of files)
    await copyIfPresent(NodePath.join(state, relative), NodePath.join(destination, relative));
  for (const relative of directories) {
    const source = NodePath.join(state, relative);
    const stat = await optionalLstat(source);
    if (!stat) continue;
    await copyIfPresent(source, NodePath.join(destination, relative));
  }
};

const backupPath = async (path: string, destination: string): Promise<void> => {
  const stat = await optionalLstat(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) fail(`refusing to back up symlink ${path}`);
  await NodeFSP.cp(path, destination, {
    recursive: stat.isDirectory(),
    force: false,
    errorOnExist: true,
  });
};

const localEnvironment = (): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of [
    "HOME",
    "PATH",
    "CODEX_HOME",
    "CODEX_BIN",
    "CODEX_APP_SERVER_TRANSPORT",
    "CODEX_APP_SERVER_BIN",
  ]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") result[key] = value;
  }
  const inheritedPath = result.PATH ?? "";
  const preferredPath = [
    "/Users/millie/.local/bin",
    "/Users/millie/.local/lib/node-v24.18.0/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  result.PATH = [
    ...preferredPath,
    ...inheritedPath.split(":").filter((entry) => entry !== "" && !preferredPath.includes(entry)),
  ].join(":");
  result.HOME ??= "/Users/millie";
  return result;
};

const launchAgentPath = (label: string): string =>
  NodePath.join(NodeOS.homedir(), "Library/LaunchAgents", `${label}.plist`);
const wrapperPath = (): string => NodePath.join(NodeOS.homedir(), ".local/bin/t3");
const installPath = (commit: string): string =>
  NodePath.join(NodeOS.homedir(), ".local/lib/t3-fork", commit);

const launchctlPrint = async (uid: number, label: string): Promise<boolean> => {
  const result = await runCommand("launchctl", ["print", `gui/${uid}/${label}`]);
  return result.code === 0;
};

const runPlan = (options: BackendDeployOptions): void => {
  const destination = installPath(options.commit);
  const plist = launchAgentPath(options.label);
  for (const line of [
    `candidate: ${options.candidate}`,
    `commit: ${options.commit}`,
    `install: ${destination}`,
    `wrapper: ${wrapperPath()}`,
    `launch agent: ${plist}`,
    `live backend: 127.0.0.1:${options.port} with base ${options.baseDir}`,
    `smoke validation: fresh ${options.smokeHome} on 127.0.0.1:${options.smokePort}`,
    "PLAN ONLY: no SSH, launchctl, process, database, or filesystem mutation will occur.",
  ])
    console.log(line);
};

const rollbackDeployment = async (input: {
  readonly options: BackendDeployOptions;
  readonly uid: number;
  readonly plist: string;
  readonly wrapper: string;
  readonly oldPlist: string | undefined;
  readonly oldWrapper: string | undefined;
  readonly oldLaunchAgentWasLoaded: boolean;
  readonly environmentId: string;
}): Promise<void> => {
  await runCommand("launchctl", ["bootout", `gui/${input.uid}/${input.options.label}`]);
  await restoreDeploymentFiles(input.plist, input.wrapper, input.oldPlist, input.oldWrapper);
  if (input.oldLaunchAgentWasLoaded) {
    await requireCommandSuccess(
      "launchctl",
      ["bootstrap", `gui/${input.uid}`, input.plist],
      "owned LaunchAgent rollback bootstrap",
    );
  } else {
    const listeners = await inspectListeners(input.options, true);
    if (listeners.length !== 0)
      fail(
        "rollback found a listener after candidate shutdown; refusing to start a second old server.",
      );
    const old = spawnServer(
      input.options.oldNodePath,
      input.options.oldEntry,
      input.options.baseDir,
      input.options.port,
      process.env,
    );
    await waitForHttp(input.options.port, input.environmentId, 60_000);
    if (old.exitCode !== null) fail("rollback old server exited before health completed.");
  }
};

const restoreDeploymentFiles = async (
  plist: string,
  wrapper: string,
  oldPlist: string | undefined,
  oldWrapper: string | undefined,
): Promise<void> => {
  await NodeFSP.rm(plist, { force: true });
  if (oldPlist !== undefined) await NodeFSP.writeFile(plist, oldPlist, { mode: 0o600 });
  await NodeFSP.rm(wrapper, { force: true });
  if (oldWrapper !== undefined) await NodeFSP.writeFile(wrapper, oldWrapper, { mode: 0o700 });
};

const deploy = async (options: BackendDeployOptions): Promise<void> => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone host-side operator has no Effect runtime; the deployment guard requires the real host platform.
  if (process.platform !== "darwin") fail("--execute is restricted to macOS.");
  if (NodeOS.userInfo().username !== "millie" || NodeOS.homedir() !== "/Users/millie")
    fail("--execute must run as the millie user with /Users/millie as HOME.");
  await validateCandidate(options);
  await requireNoSymlink(options.baseDir, "live T3 base directory");
  const environmentId = await readEnvironmentId(options.baseDir);
  const listeners = await inspectListeners(options);
  const pid = options.expectedOldPid!;
  assertSingleLoopbackListener(listeners, pid);
  assertProcessIdentity({
    expectedPid: pid,
    actualPid: pid,
    command: await currentCommand(pid),
    oldEntry: options.oldEntry,
    baseDir: options.baseDir,
    host: "127.0.0.1",
    port: options.port,
  });
  await assertLiveIdleReadOnly(NodePath.join(options.baseDir, "userdata/state.sqlite"));
  await runIsolatedSmoke(options);

  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}-${options.commit.slice(0, 12)}`;
  const runDir = NodePath.join(options.backupRoot, runId);
  await ensurePrivateDirectory(options.backupRoot, "backup root", false);
  await ensurePrivateDirectory(runDir, "backup run directory", true);
  await backupDatabase(
    NodePath.join(options.baseDir, "userdata/state.sqlite"),
    NodePath.join(runDir, "state.sqlite"),
  );
  await backupConfig(options.baseDir, NodePath.join(runDir, "config"));
  const plist = launchAgentPath(options.label);
  const wrapper = wrapperPath();
  const oldPlist = await readText(plist);
  const oldWrapper = await readText(wrapper);
  const uid = Number((await requireCommandSuccess("id", ["-u"], "user identity")).trim());
  const oldLaunchAgentWasLoaded = await launchctlPrint(uid, options.label);
  assertLaunchAgentState(oldLaunchAgentWasLoaded, oldPlist, options.label);
  if (oldWrapper !== undefined) assertOwnedDestinationContent(oldWrapper, "wrapper", options.label);
  await backupPath(plist, NodePath.join(runDir, "previous-launch-agent.plist"));
  await backupPath(wrapper, NodePath.join(runDir, "previous-t3-wrapper"));

  const destination = installPath(options.commit);
  const destinationParent = NodePath.dirname(destination);
  await NodeFSP.mkdir(destinationParent, { recursive: true, mode: 0o700 });
  await requireNoSymlink(destinationParent, "versioned install parent");
  if (await optionalLstat(destination))
    fail(`versioned install already exists; refusing to overwrite ${destination}`);
  const temporaryInstall = NodePath.join(
    destinationParent,
    `.${options.commit}.tmp-${process.pid}-${NodeCrypto.randomUUID()}`,
  );
  await ensurePrivateDirectory(temporaryInstall, "temporary install", true);
  try {
    for (const entry of await NodeFSP.readdir(options.candidate)) {
      await NodeFSP.cp(
        NodePath.join(options.candidate, entry),
        NodePath.join(temporaryInstall, entry),
        { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true },
      );
    }
    if (await optionalLstat(destination))
      fail("versioned install appeared during copy; refusing to replace it.");
    await NodeFSP.rename(temporaryInstall, destination);
  } catch (error) {
    await NodeFSP.rm(temporaryInstall, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  try {
    await atomicWriteOwned(
      wrapper,
      renderWrapper(options.nodePath, destination),
      0o700,
      "wrapper",
      options.label,
    );
    await atomicWriteOwned(
      plist,
      renderLaunchAgentPlist({
        label: options.label,
        commit: options.commit,
        wrapperPath: wrapper,
        baseDir: options.baseDir,
        port: options.port,
        environment: localEnvironment(),
      }),
      0o600,
      "plist",
      options.label,
    );
    await assertLiveIdleReadOnly(NodePath.join(options.baseDir, "userdata/state.sqlite"));
    const secondListeners = await inspectListeners(options);
    assertSingleLoopbackListener(secondListeners, pid);
    assertProcessIdentity({
      expectedPid: pid,
      actualPid: pid,
      command: await currentCommand(pid),
      oldEntry: options.oldEntry,
      baseDir: options.baseDir,
      host: "127.0.0.1",
      port: options.port,
    });
    process.kill(pid, "SIGTERM");
    stopped = true;
    for (let wait = 0; wait < 30; wait += 1) {
      const after = await inspectListeners(options, true);
      if (after.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (wait === 29)
        fail("old server did not release its exact listener; refusing to bootstrap the candidate.");
    }
    const loaded = await launchctlPrint(uid, options.label);
    if (loaded)
      await requireCommandSuccess(
        "launchctl",
        ["bootout", `gui/${uid}/${options.label}`],
        "owned LaunchAgent bootout",
      );
    await requireCommandSuccess(
      "launchctl",
      ["bootstrap", `gui/${uid}`, plist],
      "candidate LaunchAgent bootstrap",
    );
    await waitForHttp(options.port, environmentId, 90_000);
    console.log(`deployment passed for ${options.commit}; backup: ${runDir}`);
  } catch (error) {
    if (!stopped) {
      await restoreDeploymentFiles(plist, wrapper, oldPlist, oldWrapper);
      throw error;
    }
    await rollbackDeployment({
      options,
      uid,
      plist,
      wrapper,
      oldPlist,
      oldWrapper,
      oldLaunchAgentWasLoaded,
      environmentId,
    });
    throw error;
  }
};

export const parseArgs = (argv: ReadonlyArray<string>): BackendDeployOptions => {
  const values = new Map<string, string>();
  let dryRun = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string | undefined;
    if (arg === undefined) fail("missing command-line argument.");
    const currentArg = arg as string;
    if (currentArg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (currentArg === "--execute") {
      dryRun = false;
      continue;
    }
    if (!currentArg.startsWith("--")) fail(`unknown argument ${currentArg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${currentArg} requires a value.`);
    values.set(currentArg.slice(2), value as string);
    index += 1;
  }
  const get = (key: string, fallback?: string): string => {
    const value = values.get(key) ?? fallback;
    if (value === undefined) fail(`--${key} is required.`);
    return value as string;
  };
  const result: BackendDeployOptions = {
    candidate: get("candidate", DEFAULT_CANDIDATE),
    commit: get("commit", ""),
    baseDir: get("base-dir", DEFAULT_BASE_DIR),
    nodePath: get("node", DEFAULT_NODE),
    oldEntry: get("old-entry", DEFAULT_OLD_ENTRY),
    oldNodePath: get("old-node", DEFAULT_NODE),
    backupRoot: get("backup-root"),
    smokeHome: get("smoke-home"),
    port: Number(get("port", String(DEFAULT_PORT))),
    smokePort: Number(get("smoke-port", String(DEFAULT_SMOKE_PORT))),
    label: get("label", DEFAULT_LABEL),
    expectedOldPid: values.has("expected-old-pid") ? Number(get("expected-old-pid")) : undefined,
    dryRun,
  };
  return validateOptions(result);
};

const isEntrypoint =
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]);

if (isEntrypoint) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.dryRun) runPlan(options);
    else void deploy(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "deployment guard failed");
    process.exitCode = 1;
  }
}
