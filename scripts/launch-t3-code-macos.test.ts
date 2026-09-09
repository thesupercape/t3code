// @effect-diagnostics nodeBuiltinImport:off - verifies a real shell dry-run and filesystem no-write contract.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const scriptPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "launch-t3-code-macos.sh",
);

const source = NodeFS.readFileSync(scriptPath, "utf8");

describe("launch-t3-code-macos", () => {
  it("is valid bash without executing the deployment", () => {
    NodeChildProcess.execFileSync("/bin/bash", ["-n", scriptPath]);
  });

  it("requires a pinned source and explicit backup boundary", () => {
    assert.include(source, "--expected-commit");
    assert.include(source, "--backup-root");
    assert.include(source, "source commit is $actual, expected $EXPECTED_COMMIT");
    assert.include(source, "source checkout has uncommitted changes");
    assert.include(source, "t3codeCommitHash");
    assert.include(source, "cut -c1-12");
    assert.include(source, "grep -Eo");
    assert.notInclude(source, 'grep -Fq "$EXPECTED_COMMIT"');
    assert.include(source, "backup root is inside source checkout");
    assert.include(source, "source checkout is inside backup root");
  });

  it("uses scoped process ownership and consistent SQLite backup", () => {
    assert.include(source, "ps -axo pid=,command=");
    assert.include(source, 'row="${row#"${row%%[![:space:]]*}"}"');
    assert.include(source, "ps -axo pid=,ppid=");
    assert.include(source, "lsof -nP -t -iTCP:");
    assert.include(source, "VACUUM INTO");
    assert.include(source, "PRAGMA integrity_check");
    assert.include(source, "T3_HOME");
    assert.include(source, "APP_SUPPORT_PATH");
    assert.notMatch(source, /\b(?:pkill|pgrep|killall)\b/);
  });

  it("has recoverable app swap and API health gates", () => {
    assert.include(source, "write_state ready-to-swap");
    assert.include(source, "write_state old-moved");
    assert.include(source, "write_state new-installed");
    assert.include(source, 'new="$app_parent/.$app_name.new.$RUN_ID.app"');
    assert.include(source, "failed-candidate-");
    assert.include(source, "/.well-known/t3/environment");
    assert.include(source, "/api/auth/session");
    assert.include(source, "t3 agent snapshot");
    assert.include(source, "projection_thread_sessions");
    assert.include(source, "projection_pending_approvals");
    assert.include(source, "pending_user_input_count");
    assert.include(source, "EXPECTED_ENVIRONMENT_ID");
    assert.include(source, "dry run complete: no files, processes, app/data");
    assert.include(source, '[[ -f "$STATE_PATH" ]] || return 0');
  });

  it("executes a real dry-run without creating output or deployment state", () => {
    // The launcher is intentionally macOS-only. Run this integration check on
    // the target platform; static tests above still protect the contract on CI.
    if (NodeOS.type() !== "Darwin") return;

    const sourceRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");
    const temporaryRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-macos-dry-run-"),
    );
    const backupRoot = NodePath.join(temporaryRoot, "backup-root");
    const artifactDir = NodePath.join(temporaryRoot, "artifact-output");
    const git = (args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", sourceRoot, ...args], {
        encoding: "utf8",
      }).trim();
    const beforeStatus = git(["status", "--porcelain", "--untracked-files=normal"]);

    try {
      const output = NodeChildProcess.execFileSync(
        "/bin/bash",
        [
          scriptPath,
          "--dry-run",
          "--source-root",
          sourceRoot,
          "--expected-branch",
          git(["branch", "--show-current"]),
          "--expected-commit",
          git(["rev-parse", "HEAD"]),
          "--backup-root",
          backupRoot,
          "--artifact-dir",
          artifactDir,
        ],
        { encoding: "utf8" },
      );

      assert.include(output, "dry run complete");
      assert.isFalse(NodeFS.existsSync(backupRoot));
      assert.isFalse(NodeFS.existsSync(artifactDir));
      assert.equal(git(["status", "--porcelain", "--untracked-files=normal"]), beforeStatus);
    } finally {
      NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
