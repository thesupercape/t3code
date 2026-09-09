import type { UsageQuotaSample } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

/** Public reset news is a planning hint, not evidence of an account reset. */
export interface ResetAnnouncement {
  readonly targetAt: string;
  readonly publishedAt: string;
  readonly sourceUrl: string;
  readonly quote: string;
  readonly validUntil: string;
}

export interface ResetNews {
  readonly announcement: ResetAnnouncement | null;
  readonly checkedAt: number | null;
  readonly status: "loading" | "ready" | "unavailable";
}

export function currentResetAnnouncement(
  news: ResetNews | undefined,
  latest: UsageQuotaSample | undefined,
  now: number,
) {
  const announcement = news?.announcement;
  return announcement &&
    latest &&
    Date.parse(announcement.validUntil) > now &&
    Date.parse(latest.resetsAt) - 7 * 86_400_000 < Date.parse(announcement.publishedAt)
    ? announcement
    : null;
}

const endpoint = "https://resetbeacon.com/api/forecast";
const decodeNewsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);
class ResetNewsUnavailable extends Data.TaggedError("ResetNewsUnavailable") {}
const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const instant = (value: unknown): value is string =>
  typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));

export function decodeResetAnnouncement(value: unknown, now: number): ResetAnnouncement | null {
  const root = object(value);
  const answer = object(root?.answer);
  if (
    root?.publicationState !== "announced" ||
    answer?.state !== "scheduled" ||
    !instant(root.validUntil) ||
    Date.parse(root.validUntil) <= now ||
    !instant(root.calculatedAt) ||
    Date.parse(root.calculatedAt) > now + 60_000 ||
    now - Date.parse(root.calculatedAt) > 60 * 60_000 ||
    !instant(answer.deadline) ||
    !Array.isArray(answer.posts)
  )
    return null;
  const post = answer.posts
    .map(object)
    .find(
      (entry) =>
        entry?.authorHandle === "thsottiaux" &&
        typeof entry.sourceUrl === "string" &&
        /^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(entry.sourceUrl) &&
        typeof entry.quote === "string" &&
        entry.quote.length <= 1000 &&
        /codex/i.test(entry.quote) &&
        /reset/i.test(entry.quote) &&
        !/banked/i.test(entry.quote),
    );
  if (!post || !instant(post.publishedAt)) return null;
  const target = Date.parse(answer.deadline);
  if (
    Date.parse(post.publishedAt) > now ||
    target <= Date.parse(post.publishedAt) ||
    target > now + 7 * 86_400_000 ||
    target < now - 60 * 60_000
  )
    return null;
  return {
    targetAt: answer.deadline,
    validUntil: root.validUntil,
    publishedAt: post.publishedAt,
    sourceUrl: post.sourceUrl as string,
    quote: post.quote as string,
  };
}

/** No account data, cookies, or page URL accompany this public news request. */
export function watchResetAnnouncements(onNews: (news: ResetNews) => void) {
  const read = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(endpoint);
    if (response.status < 200 || response.status >= 300) return yield* new ResetNewsUnavailable();
    const body = yield* response.text;
    if (body.length > 256_000) return yield* new ResetNewsUnavailable();
    const document = yield* decodeNewsJson(body);
    const data = object(document);
    const now = yield* Clock.currentTimeMillis;
    if (
      !data ||
      !instant(data.validUntil) ||
      Date.parse(data.validUntil) <= now ||
      data.publicationState === "stale"
    )
      return yield* new ResetNewsUnavailable();
    return {
      announcement: decodeResetAnnouncement(document, now),
      checkedAt: now,
      status: "ready",
    } satisfies ResetNews;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() =>
      Effect.map(
        Clock.currentTimeMillis,
        (now) =>
          ({ announcement: null, checkedAt: now, status: "unavailable" }) satisfies ResetNews,
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
    }),
  );
  let stopped = false;
  let pending: Promise<boolean> | null = null;
  let requestFiber: Fiber.Fiber<ResetNews> | null = null;
  const refresh = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (pending) return pending;
    requestFiber = Effect.runFork(read);
    pending = Effect.runPromise(Fiber.join(requestFiber))
      .then(
        (news) => {
          if (!stopped) onNews(news);
          return !stopped && news.status === "ready";
        },
        () => {
          if (!stopped)
            onNews({
              announcement: null,
              checkedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
              status: "unavailable",
            });
          return false;
        },
      )
      .finally(() => {
        pending = null;
        requestFiber = null;
      });
    return pending;
  };
  const poll = Effect.runFork(
    Effect.promise(refresh).pipe(Effect.repeat(Schedule.spaced("5 minutes"))),
  );
  return {
    refresh,
    stop: () => {
      stopped = true;
      Effect.runFork(Fiber.interrupt(poll));
      if (requestFiber) Effect.runFork(Fiber.interrupt(requestFiber));
    },
  };
}
