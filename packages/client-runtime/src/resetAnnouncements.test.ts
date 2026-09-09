import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  currentResetAnnouncement,
  decodeResetAnnouncement,
  watchResetAnnouncements,
} from "./resetAnnouncements.ts";

const now = Date.parse("2026-08-30T22:00:00Z");
const post = {
  sourceUrl: "https://x.com/thsottiaux/status/2094144275957350900",
  authorHandle: "thsottiaux",
  publishedAt: "2026-08-30T19:24:37Z",
  quote: "Your Codex and ChatGPT Work reset will land at 6pm PST.",
};
const fixture = () => ({
  calculatedAt: "2026-08-30T21:55:00Z",
  validUntil: "2026-08-30T22:40:00Z",
  publicationState: "announced",
  answer: { state: "scheduled", deadline: "2026-08-31T01:00:00Z", posts: [post] },
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("public Codex reset news", () => {
  it("refreshes immediately and joins a pending request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const response = Promise.withResolvers<Response>();
    const request = vi.fn().mockImplementation(() => response.promise);
    vi.stubGlobal("fetch", request);
    const receive = vi.fn();
    const watcher = watchResetAnnouncements(receive);
    await vi.advanceTimersByTimeAsync(0);
    const first = watcher.refresh();
    expect(watcher.refresh()).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    response.resolve(new Response(JSON.stringify(fixture())));
    await vi.advanceTimersByTimeAsync(0);
    await first;
    request.mockResolvedValue(new Response(JSON.stringify(fixture())));
    const second = watcher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(request).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenCalledTimes(2);
    watcher.stop();
    await watcher.refresh();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not publish a request after the watcher stops", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const receive = vi.fn();
    const watcher = watchResetAnnouncements(receive);
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();
    response.resolve(new Response(JSON.stringify(fixture())));
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).not.toHaveBeenCalled();
  });
  it("accepts a sourced announcement, not a probability or account balance", () => {
    expect(decodeResetAnnouncement(fixture(), now)?.targetAt).toBe("2026-08-31T01:00:00Z");
    expect(decodeResetAnnouncement({ ...fixture(), publicationState: "high" }, now)).toBeNull();
  });
  it("rejects stale, malformed, future-dated and unsourced responses", () => {
    for (const value of [
      null,
      {},
      { ...fixture(), validUntil: "2026-08-30T21:00:00Z" },
      { ...fixture(), calculatedAt: "2026-08-31T00:00:00Z" },
      { ...fixture(), answer: { ...fixture().answer, posts: [] } },
    ]) {
      expect(decodeResetAnnouncement(value, now)).toBeNull();
    }
  });
  it.each([
    { ...post, quote: "Banked reset for Codex" },
    { ...post, authorHandle: "someone" },
    { ...post, sourceUrl: "javascript:alert(1)" },
    { ...post, sourceUrl: "https://x.com.evil.test/thsottiaux/status/1" },
  ])("ignores banked credits and untrusted source links", (candidate) => {
    expect(
      decodeResetAnnouncement(
        { ...fixture(), answer: { ...fixture().answer, posts: [candidate] } },
        now,
      ),
    ).toBeNull();
  });
  it("retires news after expiry or a new account cycle", () => {
    const news = {
      announcement: decodeResetAnnouncement(fixture(), now),
      checkedAt: now,
      status: "ready" as const,
    };
    const sample = {
      observedAt: "2026-08-30T22:00:00Z",
      remainingPercent: 81,
      resetsAt: "2026-09-05T21:21:08Z",
    };
    expect(currentResetAnnouncement(news, sample, now)).not.toBeNull();
    expect(currentResetAnnouncement(news, sample, now + 3_600_000)).toBeNull();
    expect(
      currentResetAnnouncement(news, { ...sample, resetsAt: "2026-09-07T01:00:00Z" }, now),
    ).toBeNull();
  });
  it("polls without credentials or referrer and stops on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture())));
    vi.stubGlobal("fetch", request);
    const receive = vi.fn();
    const { stop } = watchResetAnnouncements(receive);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(request.mock.calls[0]![0])).toBe("https://resetbeacon.com/api/forecast");
    expect(request.mock.calls[0]![1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {},
    });
    expect(Object.keys(request.mock.calls[0]![1].headers)).toHaveLength(0);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("shows failed or stale news as unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ...fixture(), publicationState: "stale" })),
        ),
    );
    const receive = vi.fn();
    const { stop } = watchResetAnnouncements(receive);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(receive).toHaveBeenCalledWith({
      status: "unavailable",
      announcement: null,
      checkedAt: now,
    });
  });
});
