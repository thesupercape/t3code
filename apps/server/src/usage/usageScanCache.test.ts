import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCoverage,
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  planTranscriptScan,
  pruneScanCache,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("invalidates pre-cross-home-dedup caches", () => {
    const encoded = encodeScanCache(
      new Map([
        [
          "/codex.jsonl",
          {
            size: 10,
            mtimeMs: 100,
            provider: "codex" as const,
            records: [record({ provider: "codex" })],
          },
        ],
      ]),
    );
    expect(decodeScanCache({ ...JSON.parse(JSON.stringify(encoded)), version: 5 }).size).toBe(0);
  });

  it("restores records unchanged", () => {
    const original = cacheWith([
      ["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5" })]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b", reportedCostUsd: 1.5 })]],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      mtimeMs: 300,
      provider: "opencode",
      records: [
        record({ provider: "opencode", model: "opencode-build", dedupeKey: "s:p:opencode-build" }),
      ],
    });
    original.set("/codex.jsonl", {
      size: 80,
      mtimeMs: 400,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-5.2-codex", dedupeKey: null })],
      codexState: {
        model: "gpt-5.2-codex",
        sessionId: "session-c",
        lastUsageSignature: '{"input_tokens":1}',
        sawSessionMeta: true,
        suppressingForkCopies: false,
        forkCopyAnchorMs: 0,
      },
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.size).toBe(4);
    expect(restored.get("/a.jsonl")).toEqual(original.get("/a.jsonl"));
    expect(restored.get("/b.jsonl")).toEqual(original.get("/b.jsonl"));
    expect(restored.get("/grok.jsonl")).toEqual(original.get("/grok.jsonl"));
    expect(restored.get("/codex.jsonl")).toEqual(original.get("/codex.jsonl"));
  });

  it("drops an entry whose persisted record row is corrupt", () => {
    // A malformed compact row must cold parse rather than silently dropping
    // or fabricating usage.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, r: [[1, 42]] },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose persisted Codex state is corrupt", () => {
    const encoded = encodeScanCache(
      new Map([
        [
          "/codex.jsonl",
          {
            size: 10,
            mtimeMs: 100,
            provider: "codex",
            records: [record({ provider: "codex" })],
            codexState: {
              model: "gpt-5.2-codex",
              sessionId: "session-c",
              lastUsageSignature: null,
              sawSessionMeta: true,
              suppressingForkCopies: false,
              forkCopyAnchorMs: 0,
            },
          },
        ],
      ]),
    );
    const poisoned = {
      ...encoded,
      files: { "/codex.jsonl": { ...encoded.files["/codex.jsonl"]!, c: [42] } },
    };
    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/codex.jsonl")).toBe(false);
  });

  it("drops an entry whose compact row contains invalid intern indexes", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, r: [[1, 99, 0, 1, 1, 1, 1, 0, null, null]] },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("accepts a document from a supported previous cache version", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const previous = { ...encoded, version: 2 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previous))).size).toBe(1);
  });

  it("interns repeated model and session strings", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" }), record()]]]),
    );

    expect(encoded.models).toEqual(["claude-fable-5"]);
    expect(encoded.sessions).toEqual(["session-a"]);
  });

  it("restores provider-root scan coverage", () => {
    const coverage = [
      {
        provider: "codex" as const,
        rootPath: "/home/me/.codex/sessions",
        sinceMs: 100,
        scannedAtMs: 200,
      },
    ];

    const encoded = encodeScanCache(new Map(), coverage);

    expect(decodeScanCoverage(JSON.parse(JSON.stringify(encoded)))).toEqual(coverage);
  });

  it("restores the Codex append parser state", () => {
    const original = cacheWith([["/codex.jsonl", 100, [record({ provider: "codex" })]]]);
    const cached = original.get("/codex.jsonl")!;
    original.set("/codex.jsonl", {
      ...cached,
      codexState: {
        model: "gpt-5.6-sol",
        sessionId: "session-codex",
        lastUsageSignature: '{"input_tokens":10}',
        sawSessionMeta: true,
        suppressingForkCopies: false,
        forkCopyAnchorMs: 123,
      },
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.get("/codex.jsonl")?.codexState).toEqual(
      original.get("/codex.jsonl")?.codexState,
    );
  });

  it("keeps v2 file entries but treats them as uncovered", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const v2 = { ...encoded, version: 2, coverage: undefined };

    expect(decodeScanCache(JSON.parse(JSON.stringify(v2))).size).toBe(1);
    expect(decodeScanCoverage(JSON.parse(JSON.stringify(v2)))).toEqual([]);
  });

  it("keeps v3 coverage while requiring a fresh parser state", () => {
    const coverage = [
      { provider: "codex" as const, rootPath: "/sessions", sinceMs: 100, scannedAtMs: 200 },
    ];
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]), coverage);
    const v3 = { ...encoded, version: 3 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(v3))).get("/a.jsonl")?.codexState).toBe(
      undefined,
    );
    expect(decodeScanCoverage(JSON.parse(JSON.stringify(v3)))).toEqual(coverage);
  });

  it("invalidates old Codex parsing while retaining its coverage", () => {
    const cache = cacheWith([["/codex.jsonl", 100, [record({ provider: "codex" })]]]);
    cache.set("/codex.jsonl", { ...cache.get("/codex.jsonl")!, provider: "codex" });
    cache.set("/ai-studio.json", {
      size: 10,
      mtimeMs: 100,
      provider: "aistudio",
      records: [record({ provider: "aistudio" })],
    });
    const encoded = encodeScanCache(cache, [
      { provider: "codex", rootPath: "/sessions", sinceMs: 100, scannedAtMs: 200 },
      { provider: "aistudio", rootPath: "/imports", sinceMs: 100, scannedAtMs: 200 },
    ]);
    const v4 = { ...encoded, version: 4 };

    expect([...decodeScanCache(JSON.parse(JSON.stringify(v4))).keys()]).toEqual([
      "/ai-studio.json",
    ]);
    expect(decodeScanCoverage(JSON.parse(JSON.stringify(v4)))).toEqual([
      { provider: "codex", rootPath: "/sessions", sinceMs: 100, scannedAtMs: 200 },
    ]);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    // A bad cache should cost one cold scan, never a broken page.
    expect(decodeScanCache(null).size).toBe(0);
    expect(decodeScanCache("nonsense").size).toBe(0);
    expect(decodeScanCache({ version: 999, models: [], sessions: [], files: {} }).size).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)));
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("rejects the whole cache when an intern table holds a non-string", () => {
    // models: [1] would pass the undefined guard, put a number in a record's
    // model, and crash lookupRate at aggregate time.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = { ...encoded, models: [1] };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).size).toBe(0);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    // Keeping the surviving rows under the original (size, mtime) would read
    // as a valid warm hit and the file would never be re-parsed.
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)));
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});

describe("planTranscriptScan", () => {
  const nowMs = 1_000_000;
  const common = {
    windowStartMs: 100_000,
    nowMs,
    lastRecentScanAtMs: 0,
    incrementalScanTtlMs: 15_000,
    recentTranscriptWindowMs: 200_000,
    fullScanIntervalMs: 300_000,
  };

  it("starts with a complete requested-window scan", () => {
    expect(planTranscriptScan({ ...common, coverage: undefined })).toEqual({
      hasCurrentCoverage: false,
      shouldRefresh: true,
      scanStartMs: common.windowStartMs,
    });
  });

  it("refreshes only recent history when a wider persisted scan is fresh", () => {
    expect(
      planTranscriptScan({
        ...common,
        coverage: {
          provider: "codex",
          rootPath: "/sessions",
          sinceMs: 50_000,
          scannedAtMs: nowMs - 10_000,
        },
      }),
    ).toEqual({
      hasCurrentCoverage: true,
      shouldRefresh: true,
      scanStartMs: nowMs - common.recentTranscriptWindowMs,
    });
  });

  it("reuses the last inventory during rapid range switches", () => {
    expect(
      planTranscriptScan({
        ...common,
        lastRecentScanAtMs: nowMs - 1000,
        coverage: {
          provider: "codex",
          rootPath: "/sessions",
          sinceMs: 50_000,
          scannedAtMs: nowMs - 10_000,
        },
      }).shouldRefresh,
    ).toBe(false);
  });

  it("audits the full covered range after coverage expires", () => {
    expect(
      planTranscriptScan({
        ...common,
        coverage: {
          provider: "codex",
          rootPath: "/sessions",
          sinceMs: 50_000,
          scannedAtMs: nowMs - common.fullScanIntervalMs,
        },
      }),
    ).toEqual({
      hasCurrentCoverage: false,
      shouldRefresh: true,
      scanStartMs: 50_000,
    });
  });

  it("widens from the requested start when coverage is too narrow", () => {
    expect(
      planTranscriptScan({
        ...common,
        windowStartMs: 25_000,
        coverage: {
          provider: "codex",
          rootPath: "/sessions",
          sinceMs: 50_000,
          scannedAtMs: nowMs - 10_000,
        },
      }).scanStartMs,
    ).toBe(25_000);
  });
});

describe("pruneScanCache", () => {
  const retentionCutoffMs = 1000;

  it("drops entries older than retention", () => {
    const cache = cacheWith([["/old.jsonl", 500, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 400,
      retentionCutoffMs,
    });

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("drops in-window entries whose file has disappeared", () => {
    const cache = cacheWith([["/gone.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(cache.size).toBe(0);
  });

  it("keeps entries outside the walked window that are still within retention", () => {
    // Viewing 7 days must not evict the 30-day entries, which that walk never
    // looked for and so cannot prove are gone.
    const cache = cacheWith([["/older-but-valid.jsonl", 2000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("keeps entries the walk saw", () => {
    const cache = cacheWith([["/live.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, {
      livePaths: new Set(["/live.jsonl"]),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(cache.size).toBe(1);
  });
});

describe("pruneScanCache with an unwalked root", () => {
  it("keeps in-window entries for a provider whose directory was not walked", () => {
    // A missing provider root or failed settings read leaves livePaths without
    // that provider's files. Its warm entries must survive the pass.
    const cache = cacheWith([["/codex/sessions/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("keeps entries under a sibling path that only shares the walked root prefix", () => {
    const cache = cacheWith([["/claude/projects-copy/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps the first record per dedupe key", () => {
    const kept = dedupeWithinFile([
      record({ totals: { ...record().totals, outputTokens: 1 } }),
      record({ totals: { ...record().totals, outputTokens: 999 } }),
      record({ dedupeKey: "msg_2:" }),
    ]);

    expect(kept).toHaveLength(2);
    expect(kept[0]?.totals.outputTokens).toBe(1);
  });

  it("keeps every record that has no dedupe key", () => {
    expect(
      dedupeWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });
});
