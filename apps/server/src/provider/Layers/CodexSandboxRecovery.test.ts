// @effect-diagnostics nodeBuiltinImport:off - Tests use an isolated temporary filesystem fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { assert, describe, it } from "@effect/vitest";
import * as CodexErrors from "effect-codex-app-server/errors";

const Fs = NodeFS;
const Os = NodeOS;
const Path = NodePath;

import {
  CODEX_SANDBOX_QUARANTINE_COLLISION_LIMIT,
  codexDenyReadAclQuarantinePath,
  codexDenyReadAclStatePath,
  inspectCodexDenyReadAclState,
  isCorruptDenyReadAclStateBytes,
  isConfirmedCorruptCodexSandboxExit,
  quarantineCorruptCodexDenyReadAclState,
  recoverCodexDenyReadAclState,
  shouldRecoverCodexSandboxExit,
  withCodexSandboxStartupRecovery,
} from "./CodexSandboxRecovery.ts";

const makeHome = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-codex-recovery-"));
const writeState = (home: string, content: Uint8Array) => {
  const path = codexDenyReadAclStatePath(home);
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, content);
  return path;
};

describe("Codex Windows sandbox state recovery", () => {
  it("recognizes only an all-NUL state file as corruption", () => {
    assert.equal(isCorruptDenyReadAclStateBytes(new Uint8Array(22)), true);
    assert.equal(isCorruptDenyReadAclStateBytes(new TextEncoder().encode("{}")), false);
    assert.equal(isCorruptDenyReadAclStateBytes(new Uint8Array()), false);
  });

  it.effect("quarantines the exact state file without deleting its contents", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          const path = writeState(home, new Uint8Array(22));
          assert.deepEqual(inspectCodexDenyReadAclState(home, "win32"), {
            path,
            status: "corrupt",
          });

          const quarantine = yield* quarantineCorruptCodexDenyReadAclState({
            homeDirectory: home,
            platform: "win32",
          });
          assert.exists(quarantine);
          assert.equal(Fs.existsSync(path), false);
          assert.deepEqual(
            [...Fs.readFileSync(quarantine.quarantinedPath)],
            [...new Uint8Array(22)],
          );
          assert.equal(Path.dirname(quarantine.quarantinedPath), Path.dirname(path));
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it.effect("bounds quarantine collisions without overwriting existing files", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          const path = writeState(home, new Uint8Array(22));
          const collisions = Array.from(
            { length: CODEX_SANDBOX_QUARANTINE_COLLISION_LIMIT },
            (_, attempt) => codexDenyReadAclQuarantinePath(path, attempt),
          );
          for (const collision of collisions) Fs.writeFileSync(collision, "preserve-me");

          const recovery = yield* recoverCodexDenyReadAclState({
            homeDirectory: home,
            platform: "win32",
          });

          assert.equal(recovery, undefined);
          assert.equal(inspectCodexDenyReadAclState(home, "win32").status, "corrupt");
          for (const collision of collisions) {
            assert.equal(Fs.readFileSync(collision, "utf8"), "preserve-me");
          }
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it.effect("does not overwrite a destination created after recovery starts", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          const path = writeState(home, new Uint8Array(22));
          const contestedPath = codexDenyReadAclQuarantinePath(path, 0);
          const recoveryFiber = yield* recoverCodexDenyReadAclState({
            homeDirectory: home,
            platform: "win32",
          }).pipe(Effect.forkChild({ startImmediately: true }));

          Fs.writeFileSync(contestedPath, "concurrent-owner", { flag: "wx" });
          const recovery = yield* Fiber.join(recoveryFiber);

          assert.exists(recovery);
          assert.equal(recovery.status, "quarantined");
          assert.notEqual(recovery.quarantinedPath, contestedPath);
          assert.equal(Fs.readFileSync(contestedPath, "utf8"), "concurrent-owner");
          assert.deepEqual(
            [...Fs.readFileSync(recovery.quarantinedPath!)],
            [...new Uint8Array(22)],
          );
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it.effect("coalesces simultaneous recovery and recognizes the quarantined result", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          const path = writeState(home, new Uint8Array(22));
          const [first, second] = yield* Effect.all(
            [
              recoverCodexDenyReadAclState({ homeDirectory: home, platform: "win32" }),
              recoverCodexDenyReadAclState({ homeDirectory: home, platform: "win32" }),
            ],
            { concurrency: "unbounded" },
          );

          assert.exists(first);
          assert.deepEqual(second, first);
          assert.equal(first.status, "quarantined");
          assert.equal(Fs.existsSync(path), false);

          const afterFlight = yield* recoverCodexDenyReadAclState({
            homeDirectory: home,
            platform: "win32",
          });
          assert.equal(afterFlight?.status, "already-recovered");
          assert.equal(afterFlight?.quarantinedPath, first.quarantinedPath);
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it("rejects unsafe and unrelated exits", () => {
    const exit = new CodexErrors.CodexAppServerProcessExitedError({
      code: 1,
      stderr: "configuration rejected",
    });
    assert.equal(isConfirmedCorruptCodexSandboxExit(exit), false);
    assert.equal(shouldRecoverCodexSandboxExit(exit, Os.homedir()), false);
    assert.equal(inspectCodexDenyReadAclState(Os.homedir(), "linux").status, "unsafe");
  });

  it.effect("refuses a sandbox directory junction", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.sync(() => {
          const codexDirectory = Path.join(home, ".codex");
          const redirectedSandbox = Path.join(home, "redirected-sandbox");
          Fs.mkdirSync(codexDirectory, { recursive: true });
          Fs.mkdirSync(redirectedSandbox, { recursive: true });
          const redirectedState = Path.join(redirectedSandbox, "deny_read_acl_state.json");
          Fs.writeFileSync(redirectedState, new Uint8Array(22));
          Fs.symlinkSync(redirectedSandbox, Path.join(codexDirectory, ".sandbox"), "junction");

          assert.equal(inspectCodexDenyReadAclState(home, "win32").status, "unsafe");
          assert.equal(Fs.existsSync(redirectedState), true);
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it("recognizes the confirmed stderr marker before allowing recovery", () => {
    const exit = new CodexErrors.CodexAppServerProcessExitedError({
      code: 1,
      stderr:
        "parse deny-read ACL state deny_read_acl_state.json: expected value at line 1 column 1",
    });
    assert.equal(isConfirmedCorruptCodexSandboxExit(exit), true);
  });

  it.effect("retries exactly once for the confirmed corruption and never for another exit", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          writeState(home, new Uint8Array(22));
          const confirmedExit = new CodexErrors.CodexAppServerProcessExitedError({
            code: 1,
            stderr:
              "parse deny-read ACL state deny_read_acl_state.json: expected value at line 1 column 1",
          });
          let confirmedAttempts = 0;
          const recovered = yield* withCodexSandboxStartupRecovery({
            homeDirectory: home,
            platform: "win32",
            run: () => {
              confirmedAttempts += 1;
              return confirmedAttempts === 1
                ? Effect.fail(confirmedExit)
                : Effect.succeed("recovered");
            },
          });
          assert.equal(recovered, "recovered");
          assert.equal(confirmedAttempts, 2);

          writeState(home, new Uint8Array(22));
          let unrelatedAttempts = 0;
          const unrelatedExit = new CodexErrors.CodexAppServerProcessExitedError({
            code: 1,
            stderr: "configuration rejected",
          });
          const unrelated = yield* withCodexSandboxStartupRecovery({
            homeDirectory: home,
            platform: "win32",
            run: () => {
              unrelatedAttempts += 1;
              return Effect.fail(unrelatedExit);
            },
          }).pipe(Effect.flip);
          assert.strictEqual(unrelated, unrelatedExit);
          assert.equal(unrelatedAttempts, 1);
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it.effect("lets simultaneous startup callers recover and retry once each", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          writeState(home, new Uint8Array(22));
          const confirmedExit = new CodexErrors.CodexAppServerProcessExitedError({
            code: 1,
            stderr:
              "parse deny-read ACL state deny_read_acl_state.json: expected value at line 1 column 1",
          });
          const attempts = [0, 0];
          const startup = (index: number) =>
            withCodexSandboxStartupRecovery({
              homeDirectory: home,
              platform: "win32",
              run: () => {
                attempts[index] = (attempts[index] ?? 0) + 1;
                return attempts[index] === 1
                  ? Effect.fail(confirmedExit)
                  : Effect.succeed(`ready-${index}`);
              },
            });

          const results = yield* Effect.all([startup(0), startup(1)], {
            concurrency: "unbounded",
          });
          assert.deepEqual(results, ["ready-0", "ready-1"]);
          assert.deepEqual(attempts, [2, 2]);
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );

  it.effect("retries when another startup has already regenerated valid state", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeHome),
      (home) =>
        Effect.gen(function* () {
          const path = writeState(home, new Uint8Array(22));
          const confirmedExit = new CodexErrors.CodexAppServerProcessExitedError({
            code: 1,
            stderr:
              "parse deny-read ACL state deny_read_acl_state.json: expected value at line 1 column 1",
          });
          let attempts = 0;
          const result = yield* withCodexSandboxStartupRecovery({
            homeDirectory: home,
            platform: "win32",
            run: () => {
              attempts += 1;
              if (attempts === 1) {
                Fs.writeFileSync(path, "{}");
                return Effect.fail(confirmedExit);
              }
              return Effect.succeed("ready");
            },
          });

          assert.equal(result, "ready");
          assert.equal(attempts, 2);
          assert.equal(inspectCodexDenyReadAclState(home, "win32").status, "valid");
        }),
      (home) => Effect.sync(() => Fs.rmSync(home, { recursive: true, force: true })),
    ),
  );
});
