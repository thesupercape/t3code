// @effect-diagnostics nodeBuiltinImport:off - This test exercises the standalone host-side operator script with temporary filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

import {
  assertProcessIdentity,
  assertLaunchAgentState,
  assertOwnedDestinationContent,
  assertSingleLoopbackListener,
  candidateEntryPath,
  DEPLOYMENT_MARKER,
  DeploymentGuardError,
  idleGuardQueries,
  isOwnedPlist,
  isOwnedWrapper,
  parseArgs,
  parseLsofListeners,
  renderLaunchAgentPlist,
  renderWrapper,
  validateCandidate,
  validateOptions,
} from "./deploy-macos-backend.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

const baseOptions = (overrides: Partial<Parameters<typeof validateOptions>[0]> = {}) =>
  validateOptions({
    candidate: "/tmp/backend-candidate",
    commit,
    baseDir: "/Users/millie/.t3",
    nodePath: "/Users/millie/.local/lib/node-v24.18.0/bin/node",
    oldEntry: "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
    oldNodePath: "/Users/millie/.local/lib/node-v24.18.0/bin/node",
    backupRoot: "/tmp/t3-backups",
    smokeHome: "/tmp/t3-smoke-home",
    port: 3773,
    smokePort: 38773,
    label: "com.christinesmith.t3-fork.backend",
    expectedOldPid: undefined,
    dryRun: true,
    ...overrides,
  });

const withTempDirectory = async (run: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backend-helper-test-"));
  try {
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

describe("deploy-macos-backend guards", () => {
  it("requires an exact commit and fresh smoke home for execute mode", () => {
    expect(() =>
      parseArgs([
        "--execute",
        "--commit",
        commit,
        "--backup-root",
        "/tmp/backup",
        "--smoke-home",
        "/tmp/smoke",
      ]),
    ).toThrow("--execute requires --expected-old-pid");
    expect(() => baseOptions({ commit: "short" })).toThrow("full 40-character SHA");
  });

  it("parses only exact loopback listeners and rejects PID drift", () => {
    const listeners = parseLsofListeners(
      "p16658\ncnode\ntIPv4\nn127.0.0.1:3773\np17777\ncother\ntIPv4\nn*:3773\n",
      "127.0.0.1",
      3773,
    );
    expect(listeners).toEqual([{ pid: 16658, name: "127.0.0.1:3773" }]);
    expect(() => assertSingleLoopbackListener(listeners, 16658)).not.toThrow();
    expect(() => assertSingleLoopbackListener(listeners, 17777)).toThrow(
      "does not match expected PID",
    );
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16658,
        command:
          "node /Users/millie/.npm/_npx/b56d26d977534b62/node_modules/.bin/t3 serve --host 127.0.0.1 --port 3773 --base-dir /Users/millie/.t3",
        oldEntry: "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
        baseDir: "/Users/millie/.t3",
        host: "127.0.0.1",
        port: 3773,
      }),
    ).not.toThrow();
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16658,
        command:
          "node /Users/millie/.npm/_npx/b56d26d977534b62/node_modules/.bin/t3 serve --host 127.0.0.1 --port 37730 --base-dir /Users/millie/.t3-wrong",
        oldEntry: "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
        baseDir: "/Users/millie/.t3",
        host: "127.0.0.1",
        port: 3773,
      }),
    ).toThrow("exact --base-dir");
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16659,
        command: "node unrelated --host 127.0.0.1 --port 3773 --base-dir /Users/millie/.t3",
        oldEntry: "/old/t3/dist/bin.mjs",
        baseDir: "/Users/millie/.t3",
        host: "127.0.0.1",
        port: 3773,
      }),
    ).toThrow("listener PID changed");
  });

  it("accepts the real staged bundle layout and an in-bundle dependency symlink", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      await NodeFSP.mkdir(NodePath.join(candidate, "dist"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(candidate, "node_modules/node-pty"), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(candidate, "dist/bin.mjs"), "#!/usr/bin/env node\n");
      await NodeFSP.writeFile(NodePath.join(candidate, ".t3-source-commit"), `${commit}\n`);
      await validateCandidate(baseOptions({ candidate }));
      await expect(candidateEntryPath(candidate)).resolves.toBe(
        NodePath.join(candidate, "dist/bin.mjs"),
      );
    });
  });

  it("rejects a candidate symlink that escapes the bundle and a mismatched stamp", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      await NodeFSP.mkdir(NodePath.join(candidate, "dist"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(candidate, "node_modules/node-pty"), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(candidate, "dist/bin.mjs"), "#!/usr/bin/env node\n");
      await NodeFSP.writeFile(
        NodePath.join(candidate, ".t3-source-commit"),
        "fedcba9876543210fedcba9876543210fedcba98\n",
      );
      const outside = NodePath.join(root, "outside");
      await NodeFSP.writeFile(outside, "outside");
      await NodeFSP.symlink(outside, NodePath.join(candidate, "dist/escape"));
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow(
        "escapes its bundle",
      );
      await NodeFSP.rm(NodePath.join(candidate, "dist/escape"));
      await NodeFSP.writeFile(NodePath.join(candidate, ".t3-source-commit"), "bad\n");
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow("does not match");
    });
  });

  it("renders loopback-only persistent LaunchAgent arguments and owned wrapper", () => {
    const wrapper = renderWrapper(
      "/Users/millie/.local/lib/node-v24.18.0/bin/node",
      `/Users/millie/.local/lib/t3-fork/${commit}`,
    );
    expect(wrapper).toContain("dist/bin.mjs");
    expect(isOwnedWrapper(wrapper)).toBe(true);
    const plist = renderLaunchAgentPlist({
      label: "com.christinesmith.t3-fork.backend",
      commit,
      wrapperPath: "/Users/millie/.local/bin/t3",
      baseDir: "/Users/millie/.t3",
      port: 3773,
      environment: {
        HOME: "/Users/millie",
        CODEX_HOME: "/Users/millie/.codex",
        SECRET_SHOULD_NOT_BE_COPIED: "never",
      },
    });
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<string>3773</string>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain(DEPLOYMENT_MARKER);
    expect(isOwnedPlist(plist, "com.christinesmith.t3-fork.backend")).toBe(true);
    expect(plist).not.toContain("SECRET_SHOULD_NOT_BE_COPIED");
  });

  it("fails closed for unknown wrapper/plist ownership and loaded labels without disk state", () => {
    expect(() =>
      assertOwnedDestinationContent("#!/bin/sh\necho existing\n", "wrapper", "label"),
    ).toThrow("not owned");
    expect(() => assertOwnedDestinationContent("<plist><dict/></plist>", "plist", "label")).toThrow(
      "not owned",
    );
    expect(() => assertLaunchAgentState(true, undefined, "com.example.t3")).toThrow(
      "loaded without a matching",
    );
    expect(() => assertLaunchAgentState(false, "<plist><dict/></plist>", "com.example.t3")).toThrow(
      "not owned",
    );
  });

  it("keeps stopped historical requests while blocking active or unaccounted requests", async () => {
    await withTempDirectory(async (root) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "idle-guard.sqlite"));
      try {
        db.exec(`
          CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, status TEXT);
          CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT, active_turn_id TEXT);
          CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
          CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, pending_user_input_count INTEGER);
          INSERT INTO provider_session_runtime VALUES ('historical', 'stopped'), ('active', 'running');
          INSERT INTO projection_thread_sessions VALUES ('historical', 'running', 'old-turn'), ('active', 'running', 'live-turn'), ('missing', 'running', 'unknown-turn');
          INSERT INTO projection_pending_approvals VALUES ('historical-approval', 'historical', 'pending'), ('active-approval', 'active', 'pending'), ('missing-approval', 'missing', 'pending');
          INSERT INTO projection_threads VALUES ('historical', 1), ('active', 1), ('missing', 1);
        `);
        const count = (query: string) =>
          Number((db.prepare(query).get() as Record<string, unknown>)["COUNT(*)"]);
        expect(count(idleGuardQueries.pendingInputs)).toBe(2);
        expect(count(idleGuardQueries.pendingApprovals)).toBe(2);
        expect(count(idleGuardQueries.unaccountedProjectionActivity)).toBe(2);
        db.exec(
          "UPDATE provider_session_runtime SET status = 'stopped' WHERE thread_id = 'active';",
        );
        expect(count(idleGuardQueries.pendingInputs)).toBe(1);
        expect(count(idleGuardQueries.pendingApprovals)).toBe(1);
        expect(count(idleGuardQueries.unaccountedProjectionActivity)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("keeps dry-run side-effect free by requiring only a plan", () => {
    const options = parseArgs([
      "--dry-run",
      "--commit",
      commit,
      "--backup-root",
      "/tmp/t3-backups",
      "--smoke-home",
      "/tmp/t3-smoke-home",
    ]);
    expect(options.dryRun).toBe(true);
    expect(options.port).toBe(3773);
    expect(DeploymentGuardError).toBeDefined();
  });
});
