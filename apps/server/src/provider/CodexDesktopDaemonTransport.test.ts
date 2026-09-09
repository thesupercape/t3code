// @effect-diagnostics nodeBuiltinImport:off - Uses a real Unix WebSocket peer to exercise the desktop bridge lifecycle.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexClient from "effect-codex-app-server/client";
import { assert, it } from "@effect/vitest";
import WebSocket, { WebSocketServer } from "ws";

import { makeCodexDesktopDaemonStdio } from "./CodexDesktopDaemonTransport.ts";

interface MockDaemon {
  readonly homePath: string;
  readonly socketPath: string;
  readonly server: NodeHttp.Server;
  readonly webSocketServer: WebSocketServer;
  readonly messages: Array<string>;
  readonly connected: Promise<WebSocket>;
  readonly nextMessage: () => Promise<string>;
  readonly close: () => Promise<void>;
}

const makeMockDaemon = async (onMessage?: (socket: WebSocket, message: string) => void) => {
  const homePath = await NodeFSP.mkdtemp("/tmp/t3-codex-daemon-");
  const socketPath = NodePath.join(homePath, "app-server-control", "app-server-control.sock");
  await NodeFSP.mkdir(NodePath.dirname(socketPath), { recursive: true });
  const server = NodeHttp.createServer();
  const webSocketServer = new WebSocketServer({ server });
  const messages: Array<string> = [];
  let connectedResolve: ((socket: WebSocket) => void) | undefined;
  let messageResolve: ((message: string) => void) | undefined;
  const connected = new Promise<WebSocket>((resolve) => {
    connectedResolve = resolve;
  });
  const nextMessage = () =>
    new Promise<string>((resolve) => {
      messageResolve = resolve;
    });
  webSocketServer.on("connection", (socket) => {
    connectedResolve?.(socket);
    socket.on("message", (data) => {
      const message = data.toString();
      messages.push(message);
      messageResolve?.(message);
      messageResolve = undefined;
      onMessage?.(socket, message);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    homePath,
    socketPath,
    server,
    webSocketServer,
    messages,
    connected,
    nextMessage,
    close: async () => {
      for (const socket of webSocketServer.clients) socket.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(homePath, { recursive: true, force: true });
    },
  } satisfies MockDaemon;
};

it.effect("round-trips initialize over the Unix WebSocket adapter", () =>
  Effect.gen(function* () {
    const daemon = yield* Effect.promise(() =>
      makeMockDaemon((socket, message) => {
        const request = JSON.parse(message) as { id: number; method: string };
        if (request.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                codexHome: daemonHomePlaceholder,
                platformFamily: "unix",
                platformOs: "macos",
                userAgent: "mock-daemon",
              },
            }),
          );
        }
      }),
    );
    const daemonHomePlaceholder = daemon.homePath;
    const scope = yield* Scope.make();
    try {
      const stdio = yield* makeCodexDesktopDaemonStdio(daemon.homePath).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const context = yield* Layer.build(CodexClient.layer(stdio)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(context),
      );
      const response = yield* client
        .request("initialize", {
          clientInfo: { name: "transport-test", title: "Transport Test", version: "1" },
          capabilities: { experimentalApi: true },
        })
        .pipe(Effect.timeout("1 second"));
      assert.equal(response.userAgent, "mock-daemon");
      assert.equal(daemon.messages.length, 1);
    } finally {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => daemon.close());
    }
  }),
);

it.effect("fails promptly for a missing daemon socket", () =>
  Effect.gen(function* () {
    const homePath = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-codex-missing-"));
    try {
      const result = yield* Effect.exit(
        Effect.scoped(makeCodexDesktopDaemonStdio(homePath, undefined, "100 millis")),
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.include(String(result.cause), "Codex App Server");
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(homePath, { recursive: true, force: true }));
    }
  }),
);

it.effect("terminates the socket immediately when the runtime scope closes", () =>
  Effect.gen(function* () {
    const daemon = yield* Effect.promise(() => makeMockDaemon());
    const scope = yield* Scope.make();
    let socket: WebSocket | undefined;
    try {
      yield* makeCodexDesktopDaemonStdio(daemon.homePath).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      socket = yield* Effect.promise(() => daemon.connected);
      const closed = Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            socket?.once("close", () => resolve());
          }),
      );
      yield* Scope.close(scope, Exit.void);
      yield* closed.pipe(Effect.timeout("500 millis"));
      assert.equal(socket.readyState, WebSocket.CLOSED);
    } finally {
      if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate();
      yield* Effect.promise(() => daemon.close());
    }
  }),
);

it.effect("forwards malformed frames and completes the input stream on disconnect", () =>
  Effect.gen(function* () {
    const daemon = yield* Effect.promise(() => makeMockDaemon());
    const scope = yield* Scope.make();
    let socket: WebSocket | undefined;
    try {
      const stdio = yield* makeCodexDesktopDaemonStdio(daemon.homePath).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      socket = yield* Effect.promise(() => daemon.connected);
      const malformed = yield* Stream.runHead(stdio.stdin).pipe(Effect.forkChild);
      socket.send("malformed frame");
      const chunk = yield* Fiber.join(malformed);
      if (Option.isNone(chunk)) throw new Error("expected a malformed frame");
      assert.equal(new TextDecoder().decode(chunk.value), "malformed frame\n");

      const ended = yield* stdio.stdin.pipe(Stream.runDrain, Effect.forkChild);
      socket.terminate();
      yield* Fiber.join(ended).pipe(Effect.timeout("500 millis"));
    } finally {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => daemon.close());
    }
  }),
);

it.effect("cleans up a stalled handshake when acquisition is interrupted", () =>
  Effect.gen(function* () {
    const homePath = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-codex-stalled-"));
    const socketPath = NodePath.join(homePath, "app-server-control", "app-server-control.sock");
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(socketPath), { recursive: true }));
    const scope = yield* Scope.make();
    const sockets = new Set<NodeNet.Socket>();
    let acceptedSocket: NodeNet.Socket | undefined;
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      acceptedSocket = socket;
      socket.once("close", () => sockets.delete(socket));
      // Accept the Unix socket but never answer the HTTP upgrade.
    });
    yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(socketPath, resolve)));
    try {
      const result = yield* Effect.exit(
        makeCodexDesktopDaemonStdio(homePath, undefined, "50 millis").pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.include(String(result.cause), "Codex App Server");
      // The acquisition timeout interrupts the callback and destroys the
      // client-side Unix socket. Destroy the peer in teardown as well because
      // a stalled HTTP upgrade intentionally never completes its close event.
      assert.exists(acceptedSocket);
    } finally {
      yield* Scope.close(scope, Exit.void);
      for (const socket of sockets) socket.destroy();
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
      yield* Effect.promise(() => NodeFSP.rm(homePath, { recursive: true, force: true }));
    }
  }),
);

it.effect("destroys the Unix socket when the handshake fiber is interrupted", () =>
  Effect.gen(function* () {
    const homePath = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-codex-interrupted-"));
    const socketPath = NodePath.join(homePath, "app-server-control", "app-server-control.sock");
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(socketPath), { recursive: true }));
    let acceptedSocket: NodeNet.Socket | undefined;
    let resolveAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    const server = NodeNet.createServer((socket) => {
      acceptedSocket = socket;
      resolveAccepted();
      // Accept the Unix socket but never answer the HTTP upgrade.
    });
    yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(socketPath, resolve)));
    const scope = yield* Scope.make();
    const fiber = yield* Effect.forkChild(
      makeCodexDesktopDaemonStdio(homePath, undefined, "10 seconds").pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    try {
      yield* Effect.promise(() => accepted).pipe(Effect.timeout("500 millis"));
      assert.exists(acceptedSocket);
      const closed = Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            acceptedSocket?.once("close", resolve);
          }),
      );
      yield* Fiber.interrupt(fiber);
      yield* closed.pipe(Effect.timeout("500 millis"));
    } finally {
      yield* Fiber.interrupt(fiber);
      yield* Scope.close(scope, Exit.void);
      acceptedSocket?.destroy();
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
      yield* Effect.promise(() => NodeFSP.rm(homePath, { recursive: true, force: true }));
    }
  }),
);
