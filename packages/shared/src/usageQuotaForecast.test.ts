import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { quotaForecast } from "./usageQuotaForecast.ts";
import { quotaMonitoringSamples } from "./usageQuota.ts";

const reset = "2026-09-06T00:00:00.000Z";
const sample = (observedAt: string, remainingPercent: number, resetsAt = reset) => ({
  observedAt,
  remainingPercent,
  resetsAt,
});

describe("Codex weekly forecast", () => {
  it("uses the prior completed cycle for early post-reset pace and labels its provenance", () => {
    const at = "2026-08-30T23:10:00.000Z";
    const result = quotaForecast(
      [
        sample("2026-08-30T22:00:00.000Z", 80),
        sample("2026-08-30T23:00:00.000Z", 60),
        sample("2026-08-30T23:10:00.000Z", 100, reset),
        sample(at, 100, reset),
      ],
      Date.parse(at),
    )!;
    expect(result.historicalPace).toMatchObject({ percentPerDay: 480 });
    expect(result.expectedPercentPerDay).toBe(480);
  });
  it("clears historical pace once a one-hour current measurement is available", () => {
    const at = "2026-08-30T23:10:00.000Z";
    const result = quotaForecast(
      [
        sample("2026-08-30T20:00:00.000Z", 80),
        sample("2026-08-30T21:00:00.000Z", 60),
        sample("2026-08-30T21:10:00.000Z", 100, reset),
        sample("2026-08-30T22:10:00.000Z", 99, reset),
        sample(at, 98, reset),
      ],
      Date.parse(at),
    )!;
    expect(result.historicalPace).toBeNull();
    expect(result.expectedPercentPerDay).toBeLessThan(480);
  });
  it("forecasts from the real weekly window even with a single observation", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const result = quotaForecast([sample(at, 80)], Date.parse(at))!;
    expect(result.expectedPercentPerDay).toBe(20);
    expect(result.exhaustionAt).toBe("2026-09-04T00:00:00.000Z");
    expect(result.recommendedPercentPerDay).toBeCloseTo(77 / 6);
    expect(result.paceDelta).toBeCloseTo(20 - 100 / 7);
    expect(result.projectionEndX).toBeCloseTo(4 / 6);
    expect(result.exhaustsBeforeReset).toBe(true);
  });
  it("keeps clock age separate from the percentage measurement", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const a = quotaForecast([sample(at, 80)], Date.parse(at))!;
    const b = quotaForecast([sample(at, 80)], Date.parse(at) + 16 * 60_000)!;
    expect(b.stale).toBe(true);
    expect(b.exhaustionAt).toBe(a.exhaustionAt);
    expect(b.usedPercent).toBe(a.usedPercent);
    expect(b.resetInMs).toBeLessThan(a.resetInMs);
    expect(quotaForecast([sample(at, 80)], Date.parse(reset))!.stale).toBe(true);
  });
  it("does not invent a run-out time at zero burn", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const result = quotaForecast([sample(at, 100)], Date.parse(at))!;
    expect(result.exhaustionAt).toBeNull();
    expect(result.remainingAtReset).toBe(100);
  });
  it("does not treat rounded flat readings as zero burn or a reset as negative usage", () => {
    const at = "2026-08-31T00:05:00.000Z";
    const result = quotaForecast(
      [
        sample("2026-08-30T23:55:00.000Z", 5),
        sample("2026-08-31T00:00:00.000Z", 80),
        sample(at, 80),
      ],
      Date.parse(at),
    )!;
    expect(result.expectedPercentPerDay).toBeGreaterThan(19);
    expect(result.points).toHaveLength(2);
  });
  it("does not let earlier monitoring runs skew current pace", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const result = quotaForecast(
      [
        sample("2026-08-23T00:00:00.000Z", 100, "2026-08-30T00:00:00.000Z"),
        sample("2026-08-24T00:00:00.000Z", 90, "2026-08-30T00:00:00.000Z"),
        sample("2026-08-30T00:00:00.000Z", 100),
        sample(at, 80),
      ],
      Date.parse(at),
    )!;
    expect(result.expectedPercentPerDay).toBe(20);
    expect(result.points).toHaveLength(2);
  });
  it("separates total cycle usage from what the monitor actually saw", () => {
    const at = "2026-08-31T02:00:00.000Z";
    const result = quotaForecast(
      [sample("2026-08-31T00:00:00.000Z", 83), sample(at, 81)],
      Date.parse(at),
    )!;
    expect(result.usedPercent).toBe(19);
    expect(result.monitoredUsedPercent).toBe(2);
    expect(result.usedBeforeMonitoring).toBe(17);
  });
  it("plans to an earlier announcement without changing the account clock or balance", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const announced = "2026-08-31T01:00:00.000Z";
    const result = quotaForecast([sample(at, 81)], Date.parse(at), 3, announced)!;
    expect(result.usesAnnouncement).toBe(true);
    expect(result.planningResetAt).toBe(announced);
    expect(result.latest.resetsAt).toBe(reset);
    expect(result.usedPercent).toBe(19);
    expect(result.latest.remainingPercent).toBe(81);
    expect(result.recommendedPercentPerDay / 24).toBe(78);
    expect(result.remainingAtReset).toBeGreaterThan(80);
    expect(result.exhaustsBeforeReset).toBe(false);
  });
  it.each(["2026-08-30T00:00:00Z", "2026-09-07T00:00:00Z", "invalid"])(
    "ignores an expired, later or invalid announcement: %s",
    (announced) => {
      const at = "2026-08-31T00:00:00.000Z";
      const result = quotaForecast([sample(at, 81)], Date.parse(at), 3, announced)!;
      expect(result.usesAnnouncement).toBe(false);
      expect(result.planningResetAt).toBe(reset);
    },
  );
  it("retains new reset observations but excludes history before a monitoring gap", () => {
    const old = sample("2026-07-21T00:00:00Z", 12, "2026-07-25T00:00:00Z");
    const recent = [
      sample("2026-08-30T20:00:00Z", 83),
      sample("2026-08-30T22:00:00Z", 81),
      sample("2026-08-31T01:00:00Z", 100, "2026-09-07T01:00:00Z"),
    ];
    expect(quotaMonitoringSamples([old, ...recent])).toEqual(recent);
    const result = quotaForecast([old, ...recent], Date.parse(recent[2]!.observedAt))!;
    expect(result.usedPercent).toBe(0);
    expect(result.monitoredUsedPercent).toBe(0);
    expect(result.expectedPercentPerDay).toBe(0);
  });
});

describe("recent Codex burn projection", () => {
  const now = Date.parse("2026-08-31T02:00:00Z");
  const recent = (remaining: readonly number[], step = 5) =>
    remaining.map((value, index) =>
      sample(
        DateTime.formatIso(
          DateTime.makeUnsafe(now - (remaining.length - index - 1) * step * 60_000),
        ),
        value,
      ),
    );

  it("uses the last drop-to-drop interval without importing an older average", () => {
    const result = quotaForecast(
      [sample("2026-08-30T03:00:00Z", 100), ...recent([90, 89, 88, 87, 86, 85, 84])],
      now,
    )!;
    expect(result.recentPace).toMatchObject({
      lastPercentIntervalMs: 5 * 60_000,
      elapsedSinceDropMs: 0,
      percentIntervalMs: 5 * 60_000,
      percentPerHour: 12,
    });
    expect(result.recentPace!.percentPerHour).not.toBeCloseTo(result.expectedPercentPerDay / 24);
    expect(result.latest.remainingPercent).toBe(84);
    expect(result.usedPercent).toBe(16);
  });

  it("does not invent a drop time or zero burn from an unchanged initial balance", () => {
    const result = quotaForecast(recent([81, 81, 81, 81, 81, 81, 81]), now)!;
    expect(result.recentPace).toBeNull();
    expect(result.expectedPercentPerDay).toBeGreaterThan(0);
    expect(result.usedPercent).toBe(19);
  });

  it("waits for a timed interval after the first drop and ignores duplicate readings", () => {
    const rows = recent([81, 80]);
    expect(quotaForecast(rows, now)!.recentPace).toBeNull();
    expect(quotaForecast([...rows, ...rows, ...rows], now)!.recentPace).toBeNull();
    const timed = recent([82, 81, 81]);
    expect(quotaForecast(timed, now)!.recentPace).toMatchObject({
      lastPercentIntervalMs: null,
      elapsedSinceDropMs: 5 * 60_000,
      percentIntervalMs: 5 * 60_000,
      percentPerHour: 12,
    });
    expect(quotaForecast([...timed, ...timed], now)!.recentPace).toEqual(
      quotaForecast(timed, now)!.recentPace,
    );
  });

  it("slows down when the wait for the next percent exceeds the last interval", () => {
    const rows = [-40, -35, -25, -20, -10, 0].map((minute, index) =>
      sample(
        DateTime.formatIso(DateTime.makeUnsafe(now + minute * 60_000)),
        [95, 94, 93, 93, 93, 93][index]!,
      ),
    );
    const result = quotaForecast(rows, now)!;
    expect(result.recentPace).toMatchObject({
      lastPercentIntervalMs: 10 * 60_000,
      elapsedSinceDropMs: 25 * 60_000,
      percentIntervalMs: 25 * 60_000,
      percentPerHour: 2.4,
    });
    expect(result.latest.remainingPercent).toBe(93);
    expect(result.usedPercent).toBe(7);
    const next = sample(DateTime.formatIso(DateTime.makeUnsafe(now + 5 * 60_000)), 92);
    expect(quotaForecast([...rows, next], Date.parse(next.observedAt))!.recentPace).toMatchObject({
      lastPercentIntervalMs: 30 * 60_000,
      elapsedSinceDropMs: 0,
      percentPerHour: 2,
    });
    const faster = sample(DateTime.formatIso(DateTime.makeUnsafe(now + 10 * 60_000)), 91);
    expect(
      quotaForecast([...rows, next, faster], Date.parse(faster.observedAt))!.recentPace!
        .percentPerHour,
    ).toBe(12);
  });

  it("keeps the last interval while the next drop is not overdue", () => {
    const result = quotaForecast(recent([83, 82, 81, 81], 5), now)!.recentPace!;
    expect(result.lastPercentIntervalMs).toBe(5 * 60_000);
    expect(result.percentPerHour).toBe(12);
    const rows = recent([83, 82, 81]);
    const later = sample(DateTime.formatIso(DateTime.makeUnsafe(now + 2 * 60_000)), 81);
    expect(
      quotaForecast([...rows, later], Date.parse(later.observedAt))!.recentPace!.percentPerHour,
    ).toBe(12);
  });

  it("extends waiting only with fresh readings, not with the client's clock", () => {
    const rows = recent([83, 82, 81]);
    const initial = quotaForecast(rows, now)!.recentPace!;
    const clockOnly = quotaForecast(rows, now + 14 * 60_000)!.recentPace!;
    expect(clockOnly.percentIntervalMs).toBe(initial.percentIntervalMs);
    expect(clockOnly.exhaustionAt).toBe(initial.exhaustionAt);
    const confirmed = sample(DateTime.formatIso(DateTime.makeUnsafe(now + 14 * 60_000)), 81);
    expect(
      quotaForecast([...rows, confirmed], Date.parse(confirmed.observedAt))!.recentPace!
        .percentIntervalMs,
    ).toBe(14 * 60_000);
  });

  it("keeps slowing beyond 30 minutes without turning unchanged percentages into zero burn", () => {
    const rows = recent([83, 82, 81, ...Array<number>(9).fill(81)], 10);
    const result = quotaForecast(rows, now)!.recentPace!;
    expect(result.elapsedSinceDropMs).toBe(90 * 60_000);
    expect(result.percentPerHour).toBeCloseTo(2 / 3);
    expect(result.exhaustionAt).not.toBeNull();
  });

  it("averages multi-point drops per percent without inventing individual drop times", () => {
    const result = quotaForecast(recent([90, 89, 89, 87]), now)!.recentPace!;
    expect(result.lastDropPoints).toBe(2);
    expect(result.lastPercentIntervalMs).toBe(5 * 60_000);
    expect(result.percentPerHour).toBe(12);
  });

  it("does not time drops across stale gaps, resets, or changed reset clocks", () => {
    expect(quotaForecast(recent([85, 84, 83, 82], 16), now)!.recentPace).toBeNull();
    expect(quotaForecast(recent([20, 19, 18, 17, 100, 100, 99]), now)!.recentPace).toBeNull();
    const rows = recent([85, 84, 83, 82, 81, 80, 79]);
    rows[4] = { ...rows[4]!, resetsAt: "2026-09-07T00:00:00Z" };
    rows[5] = { ...rows[5]!, resetsAt: "2026-09-07T00:00:00Z" };
    rows[6] = { ...rows[6]!, remainingPercent: 80, resetsAt: "2026-09-07T00:00:00Z" };
    rows[5] = { ...rows[5]!, remainingPercent: 81 };
    expect(quotaForecast(rows, now)!.recentPace).toBeNull();
  });

  it("withholds a recent forecast when readings are stale or in the future", () => {
    const rows = recent([84, 83, 82, 81]);
    expect(quotaForecast(rows, now + 16 * 60_000)!.recentPace).toBeNull();
    expect(quotaForecast(rows, now - 1)!.recentPace).toBeNull();
    expect(quotaForecast(rows, Date.parse(reset))!.recentPace).toBeNull();
  });

  it("uses the current planning deadline and clamps exhausted usage to zero", () => {
    const deadline = DateTime.formatIso(DateTime.makeUnsafe(now + 3_600_000));
    const result = quotaForecast(recent([84, 83, 82, 81]), now, 3, deadline)!;
    expect(result.recentPace!.remainingAtReset).toBeCloseTo(69);
    expect(result.recentPace!.exhaustsBeforeReset).toBe(false);
    const low = quotaForecast(recent([6, 5, 4, 3]), now, 3, deadline)!.recentPace!;
    expect(low.remainingAtReset).toBe(0);
    expect(low.exhaustionInMs).toBeCloseTo(15 * 60_000);
    expect(low.exhaustsBeforeReset).toBe(true);
    expect(low.projectionEndX).toBeCloseTo(0.4);
  });

  it("uses actual drop timestamps with uneven sampling", () => {
    const rows = [0, 4, 9, 15, 20].map((minute, index) =>
      sample(
        DateTime.formatIso(DateTime.makeUnsafe(now - (20 - minute) * 60_000)),
        [90, 89, 89, 88, 88][index]!,
      ),
    );
    const result = quotaForecast(rows, now)!.recentPace!;
    expect(result.lastPercentIntervalMs).toBe(11 * 60_000);
    expect(result.elapsedSinceDropMs).toBe(5 * 60_000);
    expect(result.percentPerHour).toBeCloseTo(60 / 11);
  });
});
