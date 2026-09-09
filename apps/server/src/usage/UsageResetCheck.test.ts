import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type {
  CommunityCheckFinding,
  CommunityCheckState,
  ResetCheckFinding,
  ResetCheckState,
} from "@t3tools/contracts";
import { IDLE_RESET_CHECK, makeResetCheck, ResetResearchFailed } from "./UsageResetCheck.ts";

const result: ResetCheckFinding = {
  outcome: "unavailable",
  confidence: "low",
  summary: "X blocked access.",
  confidenceReason: "Latest posts could not be verified.",
  latestPostsVerified: false,
  accessNote: "No live source.",
  likelyAt: null,
  earliestAt: null,
  latestAt: null,
  sources: [],
};
describe("environment-owned Luna job", () => {
  it.effect("keeps community work and cancellation independent of announcement research", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<CommunityCheckFinding>();
      const saved = yield* Deferred.make<CommunityCheckState>();
      const official = yield* makeResetCheck(() => Effect.never);
      const community = yield* makeResetCheck(
        () => Deferred.await(finish),
        IDLE_RESET_CHECK,
        (state) =>
          state.status === "completed"
            ? Deferred.succeed(saved, state).pipe(Effect.asVoid)
            : Effect.void,
      );
      yield* official.start;
      yield* community.start;
      yield* official.cancel;
      expect((yield* community.read).status).toBe("running");
      const discussion: CommunityCheckFinding = {
        outcome: "unavailable",
        coverage: "unavailable",
        summary: "Current X discussion could not be read.",
        accessNote: "Sign-in required.",
        posts: [],
      };
      yield* Deferred.succeed(finish, discussion);
      expect((yield* Deferred.await(saved)).result).toEqual(discussion);
      expect((yield* official.read).status).toBe("cancelled");
    }).pipe(Effect.scoped),
  );
  it.effect("coalesces simultaneous clicks and publishes one terminal result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const finish = yield* Deferred.make<ResetCheckFinding>();
      const started = yield* Deferred.make<void>();
      const saved = yield* Deferred.make<ResetCheckState>();
      const service = yield* makeResetCheck(
        () =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(finish)),
          ),
        IDLE_RESET_CHECK,
        (state) =>
          state.status === "completed"
            ? Deferred.succeed(saved, state).pipe(Effect.asVoid)
            : Effect.void,
      );
      const replies = yield* Effect.all([service.start, service.start], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(started);
      expect(replies.map((reply) => reply.status)).toEqual(["running", "running"]);
      expect(yield* Ref.get(calls)).toBe(1);
      yield* Deferred.succeed(finish, result);
      expect((yield* Deferred.await(saved)).result).toEqual(result);
      expect((yield* service.read).status).toBe("completed");
    }).pipe(Effect.scoped),
  );
  it.effect("cancels owned work and permits another check", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const service = yield* makeResetCheck(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
        ),
      );
      yield* service.start;
      yield* Deferred.await(entered);
      expect((yield* service.cancel).status).toBe("cancelled");
      yield* Deferred.await(stopped);
      expect((yield* service.start).status).toBe("running");
    }).pipe(Effect.scoped),
  );
  it.effect("ends a stuck check after three minutes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<ResetCheckState>();
      const service = yield* makeResetCheck(
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        IDLE_RESET_CHECK,
        (state) =>
          state.status === "failed"
            ? Deferred.succeed(ended, state).pipe(Effect.asVoid)
            : Effect.void,
      );
      yield* service.start;
      yield* Deferred.await(entered);
      yield* TestClock.adjust("181 seconds");
      expect((yield* Deferred.await(ended)).error).toContain("3 minutes");
    }).pipe(Effect.scoped),
  );
  it.effect("reports failures without leaking process output", () =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<ResetCheckState>();
      const service = yield* makeResetCheck(
        () => Effect.fail(new ResetResearchFailed({ stage: "Private diagnostic" })),
        IDLE_RESET_CHECK,
        (state) =>
          state.status === "failed"
            ? Deferred.succeed(ended, state).pipe(Effect.asVoid)
            : Effect.void,
      );
      yield* service.start;
      expect((yield* Deferred.await(ended)).result).toBeNull();
    }).pipe(Effect.scoped),
  );
});
