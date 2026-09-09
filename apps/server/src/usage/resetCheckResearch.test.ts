import { describe, expect, it } from "vite-plus/test";
import { ResetCheckFinding } from "@t3tools/contracts";
import { toJsonSchemaObject } from "../textGeneration/TextGenerationUtils.ts";
import { resetCheckArgs, resetCheckPrompt, validateResetFinding } from "./resetCheckResearch.ts";
import { ResetPublicFeed, validateResearchFinding } from "./resetCheckResearch.ts";
import * as Schema from "effect/Schema";
const decodePublicFeed = Schema.decodeUnknownSync(ResetPublicFeed);

const now = Date.parse("2026-08-30T23:00:00Z");
const finding: ResetCheckFinding = {
  outcome: "announced",
  confidence: "medium",
  summary: "A broad reset was announced.",
  confidenceReason: "PST may mean Pacific local time.",
  latestPostsVerified: false,
  accessNote: "X blocked access. An archived copy was available.",
  likelyAt: "2026-08-31T01:00:00Z",
  earliestAt: "2026-08-31T01:00:00Z",
  latestAt: "2026-08-31T02:00:00Z",
  sources: [
    {
      url: "https://resetbeacon.com/evidence/969f6ff1-ae02-4b6e-964f-07ffa69b2806/",
      publishedAt: "2026-08-30T19:24:37Z",
      access: "copy",
    },
  ],
};
describe("reset research boundary", () => {
  it("never turns a statistical forecast or banked credit into a broad reset window", () => {
    for (const timingBasis of ["forecast", "banked", "none"] as const) {
      expect(validateResearchFinding({ ...finding, timingBasis }, now)).toMatchObject({
        outcome: "unavailable",
        confidence: "low",
        likelyAt: null,
        earliestAt: null,
        latestAt: null,
      });
    }
    expect(validateResearchFinding({ ...finding, timingBasis: "announcement" }, now)).toEqual(
      finding,
    );
  });
  it("feeds Luna dated posts without statistical forecasts or rolling countdowns", () => {
    const feed = decodePublicFeed({
      calculatedAt: "2026-09-05T00:00:00Z",
      validUntil: "2026-09-05T01:00:00Z",
      probability: 55,
      answer: {
        state: "banked",
        secondLine: "55% within 48 hours",
        posts: [
          {
            sourceUrl: "https://x.com/thsottiaux/status/123",
            quote: "A banked reset",
            publishedAt: "2026-09-04T23:00:00Z",
          },
        ],
      },
    });
    expect(JSON.stringify(feed)).not.toContain("55");
    expect(feed.answer.posts[0]?.quote).toBe("A banked reset");
  });
  it("generates a structured-output schema without unsupported allOf constraints", () => {
    expect(JSON.stringify(toJsonSchemaObject(ResetCheckFinding))).not.toContain('"allOf"');
  });
  it("requires an original current-feed source for latest-post verification", () => {
    expect(
      validateResetFinding({ ...finding, latestPostsVerified: true }, now).latestPostsVerified,
    ).toBe(false);
    expect(
      validateResetFinding(
        {
          ...finding,
          latestPostsVerified: true,
          sources: [
            { url: "https://x.com/thsottiaux/with_replies", access: "original", publishedAt: null },
          ],
        },
        now,
      ).latestPostsVerified,
    ).toBe(true);
  });
  it("bounds text and rejects duplicate sources", () => {
    expect(() => validateResetFinding({ ...finding, summary: "a".repeat(1201) }, now)).toThrow();
    expect(() =>
      validateResetFinding({ ...finding, sources: [finding.sources[0], finding.sources[0]] }, now),
    ).toThrow();
  });
  it("keeps the defensible date/time ambiguity range", () => {
    expect(validateResetFinding(finding, now)).toEqual(finding);
  });
  it("does not give indirect or ambiguous evidence high confidence", () => {
    expect(validateResetFinding({ ...finding, confidence: "high" }, now).confidence).toBe("medium");
  });
  it("does not turn blocked latest-feed access into no upcoming reset", () => {
    expect(
      validateResetFinding(
        { ...finding, outcome: "none", earliestAt: null, latestAt: null, likelyAt: null },
        now,
      ).outcome,
    ).toBe("unavailable");
  });
  it.each([
    "http://x.com/thsottiaux/status/1",
    "https://localhost/",
    "https://x.com.evil.test/thsottiaux/status/1",
    "https://x.com/other/status/1",
    "https://user:secret@x.com/thsottiaux/status/1",
  ])("rejects unsupported source %s", (url) => {
    expect(() =>
      validateResetFinding({ ...finding, sources: [{ ...finding.sources[0], url }] }, now),
    ).toThrow();
  });
  it("rejects dates that are old, inconsistent, unsupported, or beyond the search horizon", () => {
    for (const patch of [
      { latestAt: null },
      { likelyAt: "2026-08-31T03:00:00Z" },
      { earliestAt: "2026-07-30T01:00:00Z" },
      { latestAt: "2026-10-01T01:00:00Z" },
      { sources: [] },
    ])
      expect(() => validateResetFinding({ ...finding, ...patch }, now)).toThrow();
  });
  it("compares timestamps by time, not string formatting", () => {
    expect(
      validateResetFinding({ ...finding, likelyAt: "2026-08-31T01:00:00.000Z" }, now).likelyAt,
    ).toContain(".000Z");
  });
  it("does not call an archived copy an original", () => {
    expect(() =>
      validateResetFinding(
        { ...finding, sources: [{ ...finding.sources[0], access: "original" }] },
        now,
      ),
    ).toThrow();
  });
  it("pins Luna, live search, read-only mode and disables local tools and instructions", () => {
    const args = resetCheckArgs("schema.json", "result.json");
    for (const expected of [
      "gpt-5.6-luna",
      "--search",
      "read-only",
      "--ignore-user-config",
      "features.shell_tool=false",
      "features.multi_agent=false",
      "project_doc_max_bytes=0",
    ])
      expect(args).toContain(expected);
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("danger-full-access");
    expect(resetCheckPrompt("2026-08-30T23:00:00Z")).toContain("latestPostsVerified true only");
  });
});
