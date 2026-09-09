import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import * as ServerSettings from "../serverSettings.ts";
import { makeResetResearch } from "./UsageResetCheck.ts";

it.live.skipIf(process.env.T3_RESET_CHECK_LIVE !== "1")(
  "runs the real Luna research process",
  () =>
    Effect.gen(function* () {
      const research = yield* makeResetResearch;
      const now = yield* DateTime.now;
      const result = yield* research(DateTime.formatIso(now));
      expect(["announced", "possible", "none", "unavailable"]).toContain(result.outcome);
      yield* Effect.log("Live Luna reset finding:", result);
    }).pipe(
      Effect.provide([ServerSettings.layerTest(), NodeServices.layer]),
      Effect.timeout("190 seconds"),
    ),
  200_000,
);
