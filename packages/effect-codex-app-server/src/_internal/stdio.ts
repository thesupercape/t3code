import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";
import {
  appendBoundedCodexDiagnostic,
  CODEX_APP_SERVER_STDERR_MAX_CHARS,
  sanitizeCodexDiagnosticText,
} from "./diagnostics.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export interface CodexAppServerStderrDiagnostics {
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export interface CodexAppServerStderrCapture {
  readonly snapshot: Effect.Effect<CodexAppServerStderrDiagnostics>;
  readonly completion: Effect.Effect<void>;
}

const CODEX_APP_SERVER_STDERR_DRAIN_TIMEOUT = "500 millis" as const;
const OMITTED_STDERR_LINE = "[stderr line omitted: exceeds diagnostic limit]";

interface ForwardedStderrState {
  readonly remainder: string;
  readonly omitted: boolean;
}

function takeSanitizedStderrLines(
  state: ForwardedStderrState,
  chunk: string,
): { readonly state: ForwardedStderrState; readonly chunks: ReadonlyArray<string> } {
  let remainder = state.remainder;
  let omitted = state.omitted;
  const chunks: Array<string> = [];
  const segments = chunk.split("\n");

  for (const [index, segment] of segments.entries()) {
    const complete = index < segments.length - 1;
    if (!complete) {
      if (!omitted) {
        const next = remainder + segment;
        if (next.length > CODEX_APP_SERVER_STDERR_MAX_CHARS) {
          remainder = "";
          omitted = true;
        } else {
          remainder = next;
        }
      }
      continue;
    }

    const line = remainder + segment;
    chunks.push(
      `${omitted || line.length > CODEX_APP_SERVER_STDERR_MAX_CHARS ? OMITTED_STDERR_LINE : sanitizeCodexDiagnosticText(line)}\n`,
    );
    remainder = "";
    omitted = false;
  }

  return { state: { remainder, omitted }, chunks };
}

function flushSanitizedStderrLine(state: ForwardedStderrState): string | undefined {
  if (state.omitted) return OMITTED_STDERR_LINE;
  return state.remainder.length > 0 ? sanitizeCodexDiagnosticText(state.remainder) : undefined;
}

export const captureChildStderr = (
  stderr: Stream.Stream<Uint8Array, unknown>,
  onChunk?: (chunk: string) => Effect.Effect<void, never>,
): Effect.Effect<CodexAppServerStderrCapture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<CodexAppServerStderrDiagnostics>({
      stderr: "",
      stderrTruncated: false,
    });
    const completed = yield* Deferred.make<void>();
    const forwardedState = yield* Ref.make<ForwardedStderrState>({
      remainder: "",
      omitted: false,
    });
    const forwardChunk = (chunk: string) =>
      onChunk
        ? Ref.modify(forwardedState, (state) => {
            const next = takeSanitizedStderrLines(state, chunk);
            return [next.chunks, next.state] as const;
          }).pipe(Effect.flatMap((chunks) => Effect.forEach(chunks, onChunk, { discard: true })))
        : Effect.void;
    const finishForwarding = onChunk
      ? Ref.get(forwardedState).pipe(
          Effect.flatMap((state) => {
            const finalChunk = flushSanitizedStderrLine(state);
            return finalChunk === undefined ? Effect.void : onChunk(finalChunk);
          }),
        )
      : Effect.void;
    yield* stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(state, (current) => {
          const next = appendBoundedCodexDiagnostic(current.stderr, chunk);
          return {
            stderr: next.value,
            stderrTruncated: current.stderrTruncated || next.truncated,
          };
        }).pipe(Effect.andThen(forwardChunk(chunk))),
      ),
      Effect.ignore,
      Effect.ensuring(
        finishForwarding.pipe(
          Effect.andThen(Deferred.succeed(completed, undefined)),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped,
    );
    return {
      snapshot: Ref.get(state),
      completion: Deferred.await(completed),
    } satisfies CodexAppServerStderrCapture;
  });

export const readFinalChildStderr = (
  capture: CodexAppServerStderrCapture,
): Effect.Effect<CodexAppServerStderrDiagnostics> =>
  capture.completion.pipe(
    Effect.timeoutOption(CODEX_APP_SERVER_STDERR_DRAIN_TIMEOUT),
    Effect.andThen(capture.snapshot),
  );

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  context: { readonly method?: string; readonly requestId?: string } = {},
  diagnostics: CodexAppServerStderrDiagnostics | Effect.Effect<CodexAppServerStderrDiagnostics> = {
    stderr: "",
    stderrTruncated: false,
  },
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) =>
      (Effect.isEffect(diagnostics) ? diagnostics : Effect.succeed(diagnostics)).pipe(
        Effect.map(
          (snapshot) =>
            new CodexError.CodexAppServerProcessExitedError({
              code,
              pid: handle.pid,
              ...(snapshot.stderr.length > 0 ? snapshot : {}),
              ...(context.method === undefined ? {} : { method: context.method }),
              ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            }),
        ),
      ),
  });
