import { describe, expect, it } from "vite-plus/test";
import type { CommunityCheckFinding } from "@t3tools/contracts";
import { communityCheckPrompt, validateCommunityFinding } from "./communityCheckResearch.ts";

const now = Date.parse("2026-08-31T02:00:00Z");
const finding: CommunityCheckFinding = {
  outcome: "found",
  coverage: "partial",
  summary: "Some people are asking about the timing.",
  accessNote: "Only indexed posts were available.",
  posts: [
    {
      url: "https://x.com/example/status/12345",
      author: "@example",
      publishedAt: "2026-08-31T01:20:00Z",
      access: "index",
      kind: "question",
      summary: "Asks when the reset will arrive.",
    },
  ],
};

describe("community research evidence", () => {
  it("keeps indexed discussion visibly partial", () => {
    expect(validateCommunityFinding({ ...finding, coverage: "live" }, now).coverage).toBe(
      "partial",
    );
  });
  it("requires a dated original for claims that someone reset or is still waiting", () => {
    for (const kind of ["reset_reported", "still_waiting"]) {
      expect(() =>
        validateCommunityFinding({ ...finding, posts: [{ ...finding.posts[0], kind }] }, now),
      ).toThrow();
      expect(() =>
        validateCommunityFinding(
          {
            ...finding,
            posts: [{ ...finding.posts[0], kind, access: "original", publishedAt: null }],
          },
          now,
        ),
      ).toThrow();
      expect(
        validateCommunityFinding(
          { ...finding, posts: [{ ...finding.posts[0], kind, access: "original" }] },
          now,
        ).posts[0]?.kind,
      ).toBe(kind);
    }
  });
  it("rejects unsupported URLs, spoofed authors, duplicates and stale dates", () => {
    for (const patch of [
      { url: "https://x.com.evil.test/example/status/12345" },
      { url: "javascript:alert(1)" },
      { url: "https://x.com/example/status/12345?redirect=bad" },
      { author: "@somebodyelse" },
      { url: "https://x.com/thsottiaux/status/12345", author: "@thsottiaux" },
      { publishedAt: "2026-08-28T01:00:00Z" },
      { publishedAt: "2026-09-01T01:00:00Z" },
    ])
      expect(() =>
        validateCommunityFinding({ ...finding, posts: [{ ...finding.posts[0], ...patch }] }, now),
      ).toThrow();
    expect(() =>
      validateCommunityFinding(
        {
          ...finding,
          posts: [
            finding.posts[0],
            { ...finding.posts[0], url: "https://twitter.com/example/status/12345" },
          ],
        },
        now,
      ),
    ).toThrow();
  });
  it("does not turn blocked access into no discussion", () => {
    expect(validateCommunityFinding({ ...finding, outcome: "none", posts: [] }, now).outcome).toBe(
      "unavailable",
    );
    expect(() => validateCommunityFinding({ ...finding, posts: [] }, now)).toThrow();
  });
  it("keeps community reports separate from official announcements and account data", () => {
    const prompt = communityCheckPrompt("2026-08-31T02:00:00Z", null);
    expect(prompt).toContain("COMMUNITY");
    expect(prompt).toContain("Community posts cannot confirm this user's reset");
    expect(prompt).toContain("Do not read local files");
    expect(prompt).toContain("No Reddit posts or official Tibo posts");
  });
});
