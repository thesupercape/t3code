import { describe, expect, it } from "@effect/vitest";

import type { V2GetAccountRateLimitsResponse } from "effect-codex-app-server/schema";

import {
  codexQuotaChildEnvironment,
  isSafeCodexQuotaTransport,
  quotaSampleFromRateLimits,
} from "./CodexQuotaCollector.ts";

const observedAtMs = Date.parse("2026-08-30T12:00:00.000Z");
const resetsAt = Date.parse("2026-09-05T20:00:00.000Z") / 1_000;
const weeklyWindow = { usedPercent: 17, resetsAt, windowDurationMins: 10_080 } as const;

describe("macOS Codex quota collector", () => {
  it("supports both authenticated app-server transports", () => {
    expect(isSafeCodexQuotaTransport("desktop-daemon")).toBe(true);
    expect(isSafeCodexQuotaTransport("stdio")).toBe(true);
  });

  it("maps the named weekly Codex limit to a sanitized sample", () => {
    const response = {
      rateLimits: { primary: { usedPercent: 99, windowDurationMins: 60 } },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: weeklyWindow },
      },
    } satisfies V2GetAccountRateLimitsResponse;

    expect(quotaSampleFromRateLimits(response, observedAtMs)).toEqual({
      observedAt: "2026-08-30T12:00:00.000Z",
      remainingPercent: 83,
      resetsAt: "2026-09-05T20:00:00.000Z",
    });
  });

  it("supports legacy app-server responses without a limit map", () => {
    const response = {
      rateLimits: { limitId: "codex", primary: weeklyWindow },
    } satisfies V2GetAccountRateLimitsResponse;
    expect(quotaSampleFromRateLimits(response, observedAtMs)?.remainingPercent).toBe(83);
  });

  it("selects the weekly window when the API exposes it as secondary", () => {
    const response = {
      rateLimits: {
        primary: { usedPercent: 99, windowDurationMins: 60 },
        secondary: weeklyWindow,
      },
    } satisfies V2GetAccountRateLimitsResponse;
    expect(quotaSampleFromRateLimits(response, observedAtMs)?.remainingPercent).toBe(83);
  });

  it("does not infer a Codex sample from another window or limit", () => {
    const shortWindow = {
      rateLimits: { primary: weeklyWindow },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { ...weeklyWindow, windowDurationMins: 60 } },
      },
    } satisfies V2GetAccountRateLimitsResponse;
    const otherLimit = {
      rateLimits: { limitId: "other", primary: weeklyWindow },
    } satisfies V2GetAccountRateLimitsResponse;
    expect(quotaSampleFromRateLimits(shortWindow, observedAtMs)).toBeNull();
    expect(quotaSampleFromRateLimits(otherLimit, observedAtMs)).toBeNull();
  });

  it("fails closed when a limit map omits Codex, even if the legacy field is usable", () => {
    const response = {
      rateLimits: { primary: weeklyWindow },
      rateLimitsByLimitId: {
        other: { limitId: "other", primary: weeklyWindow },
      },
    } satisfies V2GetAccountRateLimitsResponse;
    expect(quotaSampleFromRateLimits(response, observedAtMs)).toBeNull();
  });

  it("rejects invalid or already-expired readings", () => {
    const expired = {
      rateLimits: {
        primary: { ...weeklyWindow, resetsAt: observedAtMs / 1_000 - 1 },
      },
    } satisfies V2GetAccountRateLimitsResponse;
    const invalid = {
      rateLimits: { primary: { ...weeklyWindow, usedPercent: 101 } },
    } satisfies V2GetAccountRateLimitsResponse;
    expect(quotaSampleFromRateLimits(expired, observedAtMs)).toBeNull();
    expect(quotaSampleFromRateLimits(invalid, observedAtMs)).toBeNull();
  });

  it("allowlists only the Codex child environment and expands a shared home", () => {
    expect(
      codexQuotaChildEnvironment(
        {
          PATH: "/usr/bin",
          HOME: "/Users/tester",
          CODEX_HOME: "/Users/tester/.codex",
        },
        "/Users/tester/.codex-shared",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      CODEX_HOME: "/Users/tester/.codex-shared",
    });
  });
});
