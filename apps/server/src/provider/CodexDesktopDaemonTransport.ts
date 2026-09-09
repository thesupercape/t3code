import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import WebSocket, { type RawData } from "ws";

export type CodexDesktopDaemonEnvironment =
  | NodeJS.ProcessEnv
  | {
      readonly CODEX_HOME?: string | undefined;
      readonly HOME?: string | undefined;
    };

export const CODEX_DESKTOP_DAEMON_HANDSHAKE_TIMEOUT = "10 seconds" as const;

/** The Unix-domain adapter is only a desktop-daemon transport on macOS. */
export function useCodexDesktopDaemonSocketTransport(
  transport: "stdio" | "desktop-daemon",
  platform: NodeJS.Platform,
): boolean {
  return transport === "desktop-daemon" && platform === "darwin";
}

export function codexDesktopDaemonSocketPath(
  homePath?: string,
  environment: CodexDesktopDaemonEnvironment = process.env,
): string {
  const configuredHome = homePath ?? environment.CODEX_HOME ?? "~/.codex";
  const homeDirectory = environment.HOME ?? NodeOS.homedir();
  const codexHome =
    configuredHome === "~"
      ? homeDirectory
      : configuredHome.startsWith("~/")
        ? `${homeDirectory}${configuredHome.slice(1)}`
        : configuredHome;
  return `${codexHome.replace(/\/+$/, "")}/app-server-control/app-server-control.sock`;
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/**
 * Adapt the managed daemon's Unix-domain WebSocket to the JSONL stdio shape
 * consumed by effect-codex-app-server.
 *
 * `codex app-server proxy` forwards raw WebSocket handshake/frame bytes. It
 * cannot be given JSONL directly because that bypasses the HTTP upgrade.
 */
export const makeCodexDesktopDaemonStdio = Effect.fn("makeCodexDesktopDaemonStdio")(function* (
  homePath?: string,
  environment: CodexDesktopDaemonEnvironment = process.env,
  handshakeTimeout: Duration.Input = CODEX_DESKTOP_DAEMON_HANDSHAKE_TIMEOUT,
) {
  const socketPath = codexDesktopDaemonSocketPath(homePath, environment);
  const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const socket = yield* Effect.callback<WebSocket, CodexErrors.CodexAppServerSpawnError>(
    (resume, signal) => {
      let transportSocket: NodeNet.Socket | undefined;
      const client = new WebSocket("ws://localhost/", {
        perMessageDeflate: false,
        createConnection: () => {
          transportSocket = NodeNet.createConnection(socketPath);
          transportSocket.setTimeout(Duration.toMillis(handshakeTimeout), () =>
            fail(
              new Error(
                `Timed out after ${String(handshakeTimeout)} waiting for the WebSocket handshake`,
              ),
            ),
          );
          return transportSocket;
        },
      });
      let settled = false;
      const closeImmediately = () => {
        if (client.readyState !== WebSocket.CLOSED) {
          // `ws.terminate()` reports a pre-upgrade close through `error` on
          // the next tick. Keep a handler attached while aborting so an
          // interrupted acquisition cannot become an uncaught exception.
          client.once("error", () => undefined);
          client.terminate();
        }
        transportSocket?.destroy();
      };
      const cleanup = () => {
        transportSocket?.setTimeout(0);
        signal.removeEventListener("abort", onAbort);
        client.off("open", onOpen);
        client.off("error", onError);
        client.off("close", onCloseBeforeOpen);
      };
      const fail = (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        closeImmediately();
        resume(
          Effect.fail(
            new CodexErrors.CodexAppServerSpawnError({
              command: `connect to Codex desktop daemon at ${socketPath}`,
              cause,
            }),
          ),
        );
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(Effect.succeed(client));
      };
      const onError = (cause: Error) => fail(cause);
      const onCloseBeforeOpen = () =>
        fail(new Error("Codex desktop daemon closed during handshake"));
      const onAbort = () => {
        cleanup();
        closeImmediately();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      client.once("open", onOpen);
      client.once("error", onError);
      client.once("close", onCloseBeforeOpen);

      return Effect.sync(() => {
        cleanup();
        closeImmediately();
      });
    },
  ).pipe(
    Effect.timeout(handshakeTimeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new CodexErrors.CodexAppServerSpawnError({
          command: `connect to Codex desktop daemon at ${socketPath}`,
          cause: new Error(
            `Timed out after ${String(handshakeTimeout)} waiting for the WebSocket handshake`,
          ),
        }),
      ),
    ),
  );

  socket.on("message", (data: RawData) => {
    const bytes = rawDataToBytes(data);
    const framed = new Uint8Array(bytes.byteLength + 1);
    framed.set(bytes);
    framed[bytes.byteLength] = 10;
    Queue.offerUnsafe(incoming, framed);
  });
  socket.on("close", () => Queue.endUnsafe(incoming));
  socket.on("error", () => Queue.endUnsafe(incoming));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Queue.endUnsafe(incoming);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }),
  );

  const decoder = new TextDecoder();
  let pending = "";
  const stdout = Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const message = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (message.length > 0) socket.send(message);
        newline = pending.indexOf("\n");
      }
    }),
  );

  return Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(incoming),
    stdout: () => stdout,
    stderr: () => Sink.drain,
  });
});
