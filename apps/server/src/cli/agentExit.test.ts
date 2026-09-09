import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { handleAgentCliFailure } from "./agent.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

it.effect("unrelated operation failures remain typed failures", () =>
  Effect.gen(function* () {
    const failure = new Error("Unexpected failure");
    const result = yield* handleAgentCliFailure(Effect.fail(failure)).pipe(Effect.flip);
    expect(result).toBe(failure);
  }),
);

it.effect("expected agent rejection drains pending close callbacks and exits with code 1", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const cwd = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const source = `
      import * as Effect from 'effect/Effect';
      import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
      import { handleAgentCliFailure } from ${encodeString(new URL("./agent.ts", import.meta.url).href)};
      import { AgentCliError } from ${encodeString(new URL("./agentProtocol.ts", import.meta.url).href)};
      const operation = Effect.acquireUseRelease(
        Effect.void,
        () => Effect.fail(new AgentCliError({message:'Expected target rejection'})),
        () => Effect.sync(() => {
          process.stdout.write('released\\n');
          setImmediate(() => process.stdout.write('drained\\n'));
        }),
      );
      NodeRuntime.runMain(operation.pipe(handleAgentCliFailure));
    `;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["--input-type=module", "-e", source], { cwd }),
    );
    const [output, error, code] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (all, text) => all + text,
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (all, text) => all + text,
          ),
        ),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    expect(Number(code)).toBe(1);
    expect(output, error).toContain("released\ndrained\n");
    expect(error).toContain("Expected target rejection");
    expect(error).not.toContain("Assertion failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
