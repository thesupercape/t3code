import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.layer(GitContractLayer)("Git checkpoint restore safeguards", (it) => {
  const makeRepository = Effect.fn("GitVcsDriver.test.makeRepository")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-checkpoint-" });
    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(`${cwd}/README.md`, "v1\n");
    yield* runGit(cwd, ["add", "."]);
    yield* runGit(cwd, ["commit", "-m", "initial"]);
    return cwd;
  });

  it.effect("accepts an unstaged tracked edit captured by the current checkpoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.ok(checkpoints);
      const cwd = yield* makeRepository();
      const checkpointRef = CheckpointRef.make("refs/t3/tests/tracked-current");

      yield* fileSystem.writeFileString(`${cwd}/README.md`, "captured edit\n");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const result = yield* checkpoints.restoreCheckpoint({
        cwd,
        checkpointRef,
        expectedCurrentCheckpointRef: checkpointRef,
      });

      assert.strictEqual(result.restored, true);
      assert.strictEqual(
        (yield* fileSystem.readFileString(`${cwd}/README.md`)).replaceAll("\r\n", "\n"),
        "captured edit\n",
      );
    }),
  );

  it.effect("accepts a new file captured by the current checkpoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.ok(checkpoints);
      const cwd = yield* makeRepository();
      const checkpointRef = CheckpointRef.make("refs/t3/tests/untracked-current");

      yield* fileSystem.writeFileString(`${cwd}/new-file.txt`, "captured\n");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const result = yield* checkpoints.restoreCheckpoint({
        cwd,
        checkpointRef,
        expectedCurrentCheckpointRef: checkpointRef,
      });

      assert.strictEqual(result.restored, true);
      assert.strictEqual(
        (yield* fileSystem.readFileString(`${cwd}/new-file.txt`)).replaceAll("\r\n", "\n"),
        "captured\n",
      );
    }),
  );

  it.effect("rejects tracked and untracked changes made after the current checkpoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.ok(checkpoints);

      const trackedCwd = yield* makeRepository();
      const trackedRef = CheckpointRef.make("refs/t3/tests/tracked-drift");
      yield* checkpoints.captureCheckpoint({ cwd: trackedCwd, checkpointRef: trackedRef });
      yield* fileSystem.writeFileString(`${trackedCwd}/README.md`, "keep tracked change\n");
      const trackedResult = yield* checkpoints.restoreCheckpoint({
        cwd: trackedCwd,
        checkpointRef: trackedRef,
        expectedCurrentCheckpointRef: trackedRef,
      });
      assert.deepStrictEqual(trackedResult, {
        restored: false,
        reason: "current-worktree-dirty",
        detail:
          "The workspace changed after the latest checkpoint; no user changes were overwritten.",
      });
      assert.strictEqual(
        yield* fileSystem.readFileString(`${trackedCwd}/README.md`),
        "keep tracked change\n",
      );

      const untrackedCwd = yield* makeRepository();
      const untrackedRef = CheckpointRef.make("refs/t3/tests/untracked-drift");
      yield* checkpoints.captureCheckpoint({ cwd: untrackedCwd, checkpointRef: untrackedRef });
      yield* fileSystem.writeFileString(`${untrackedCwd}/keep-new-file.txt`, "keep untracked\n");
      const untrackedResult = yield* checkpoints.restoreCheckpoint({
        cwd: untrackedCwd,
        checkpointRef: untrackedRef,
        expectedCurrentCheckpointRef: untrackedRef,
      });
      assert.strictEqual(untrackedResult.restored, false);
      if (!untrackedResult.restored)
        assert.strictEqual(untrackedResult.reason, "current-worktree-dirty");
      assert.strictEqual(
        yield* fileSystem.readFileString(`${untrackedCwd}/keep-new-file.txt`),
        "keep untracked\n",
      );
    }),
  );

  it.effect("accepts a linked worktree from the expected repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.ok(checkpoints);
      const repositoryRoot = yield* makeRepository();
      const worktreeParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-linked-parent-",
      });
      const linkedCwd = `${worktreeParent}/linked`;
      yield* runGit(repositoryRoot, ["worktree", "add", "-b", "checkpoint-linked", linkedCwd]);

      const targetRef = CheckpointRef.make("refs/t3/tests/linked-target");
      const currentRef = CheckpointRef.make("refs/t3/tests/linked-current");
      yield* fileSystem.writeFileString(`${linkedCwd}/README.md`, "linked target\n");
      yield* checkpoints.captureCheckpoint({ cwd: linkedCwd, checkpointRef: targetRef });
      yield* fileSystem.writeFileString(`${linkedCwd}/README.md`, "linked current\n");
      yield* checkpoints.captureCheckpoint({ cwd: linkedCwd, checkpointRef: currentRef });

      const result = yield* checkpoints.restoreCheckpoint({
        cwd: linkedCwd,
        checkpointRef: targetRef,
        expectedRepositoryRoot: repositoryRoot,
        expectedBranch: "checkpoint-linked",
        expectedCurrentCheckpointRef: currentRef,
      });

      assert.strictEqual(result.restored, true, result.restored ? "" : result.detail);
      assert.strictEqual(
        (yield* fileSystem.readFileString(`${linkedCwd}/README.md`)).replaceAll("\r\n", "\n"),
        "linked target\n",
      );
    }),
  );

  it.effect("falls back to HEAD for a missing turn-zero checkpoint without overwriting drift", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.ok(checkpoints);
      const cwd = yield* makeRepository();
      const missingRef = CheckpointRef.make("refs/t3/tests/missing-turn-zero");

      const cleanResult = yield* checkpoints.restoreCheckpoint({
        cwd,
        checkpointRef: missingRef,
        expectedCurrentCheckpointRef: missingRef,
        fallbackToHead: true,
      });
      assert.strictEqual(cleanResult.restored, true);

      yield* fileSystem.writeFileString(`${cwd}/README.md`, "keep fallback drift\n");
      const dirtyResult = yield* checkpoints.restoreCheckpoint({
        cwd,
        checkpointRef: missingRef,
        expectedCurrentCheckpointRef: missingRef,
        fallbackToHead: true,
      });
      assert.strictEqual(dirtyResult.restored, false);
      if (!dirtyResult.restored) assert.strictEqual(dirtyResult.reason, "current-worktree-dirty");
      assert.strictEqual(
        yield* fileSystem.readFileString(`${cwd}/README.md`),
        "keep fallback drift\n",
      );
    }),
  );
});
