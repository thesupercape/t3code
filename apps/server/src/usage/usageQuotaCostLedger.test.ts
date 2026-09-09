import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  decodeQuotaCostLedger,
  readQuotaCostLedger,
  upsertQuotaCostLedger,
  writeQuotaCostLedger,
} from "./usageQuotaCostLedger.ts";

const fingerprint = {
  hostId: "desktop",
  provider: "codex" as const,
  resolvedHomePath: "/codex",
  volumeId: "v1",
};
const interval = {
  id: "2026-09-07T00:00:00Z",
  sinceTime: "2026-09-07T00:00:00Z",
  untilTime: "2026-09-07T01:00:00Z",
  firstRemainingPercent: 48,
  lastRemainingPercent: 20,
  resetsAt: "2026-09-07T02:00:00Z",
};
const cost = {
  intervalId: interval.id,
  fingerprint,
  costUsd: 12,
  records: 3,
  unpricedRecords: 0,
  complete: true as const,
};

describe("quota cost ledger", () => {
  it("round trips complete priced rows and rejects malformed or unpriced rows", () => {
    const rows = upsertQuotaCostLedger([], cost, fingerprint, interval, "2026-09-07T02:00:00Z");
    expect(decodeQuotaCostLedger({ version: 1, rows })).toEqual(rows);
    expect(
      upsertQuotaCostLedger(rows, { ...cost, complete: false }, fingerprint, interval, "now"),
    ).toEqual(rows);
    expect(
      upsertQuotaCostLedger(rows, { ...cost, unpricedRecords: 1 }, fingerprint, interval, "now"),
    ).toEqual(rows);
    expect(decodeQuotaCostLedger({ version: 99, rows })).toEqual([]);
    expect(
      decodeQuotaCostLedger({
        version: 1,
        rows: [
          {
            ...rows[0]!,
            recordedAt: "invalid",
            fingerprint: { ...fingerprint, provider: "unknown" },
            models: [{ model: 42 }],
          },
        ],
      }),
    ).toEqual([]);
  });
  it("replaces only the same source and interval key", () => {
    const rows = upsertQuotaCostLedger([], cost, fingerprint, interval, "2026-09-07T02:00:00Z");
    const changed = upsertQuotaCostLedger(
      rows,
      { ...cost, costUsd: 14 },
      fingerprint,
      interval,
      "2026-09-07T03:00:00Z",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.costUsd).toBe(14);
  });
  it("round trips through an atomic temporary disk file", async () => {
    const rows = upsertQuotaCostLedger([], cost, fingerprint, interval, "2026-09-07T02:00:00Z");
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectory({ prefix: "t3-quota-ledger-" });
        const path = `${dir}/ledger.json`;
        yield* writeQuotaCostLedger(path, rows);
        return yield* readQuotaCostLedger(path);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(loaded).toEqual(rows);
  });
});
