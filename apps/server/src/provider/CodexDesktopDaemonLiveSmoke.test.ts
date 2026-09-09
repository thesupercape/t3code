// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Explicit opt-in smoke test for the parent-owned local daemon.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as CodexClient from "effect-codex-app-server/client";
import { assert, it } from "@effect/vitest";

import { makeCodexDesktopDaemonStdio } from "./CodexDesktopDaemonTransport.ts";

const enabled = process.env.CODEX_DESKTOP_DAEMON_LIVE_SMOKE === "1";

it.effect.skipIf(!enabled)("reads thread and model listings from the local daemon", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    try {
      const stdio = yield* makeCodexDesktopDaemonStdio().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const context = yield* Layer.build(CodexClient.layer(stdio)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(context),
      );
      yield* client.request("initialize", {
        clientInfo: { name: "t3-live-smoke", title: "T3 live smoke", version: "0" },
        capabilities: { experimentalApi: true },
      });
      const threads = yield* client.request("thread/list", { limit: 1 });
      const models = yield* client.request("model/list", { limit: 1 });
      assert.isAtMost(threads.data.length, 1);
      assert.isAtMost(models.data.length, 1);
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
  }),
);
