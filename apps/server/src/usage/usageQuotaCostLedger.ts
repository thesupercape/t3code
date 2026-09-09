import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type { UsageQuotaCostSnapshot } from "@t3tools/contracts";
import { UsageQuotaCost, UsageSourceFingerprint } from "@t3tools/contracts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

export const QUOTA_COST_LEDGER_VERSION = 1 as const;
export const MAX_QUOTA_COST_LEDGER_ROWS = 256;
export const MAX_QUOTA_COST_LEDGER_BYTES = 512 * 1024;

export interface QuotaCostLedgerRow extends UsageQuotaCostSnapshot {
  readonly key: string;
  readonly fingerprint: UsageSourceFingerprint;
  readonly intervalId: string;
  readonly sinceTime: string;
  readonly untilTime: string;
  readonly costUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
}

const LedgerRowSchema = Schema.Struct({
  key: Schema.String,
  intervalId: Schema.String,
  fingerprint: UsageSourceFingerprint,
  sinceTime: Schema.String,
  untilTime: Schema.String,
  costUsd: Schema.Number,
  records: Schema.Number,
  unpricedRecords: Schema.Literal(0),
  recordedAt: Schema.String,
  firstRemainingPercent: Schema.Number,
  lastRemainingPercent: Schema.Number,
  resetsAt: Schema.String,
  models: Schema.optional(UsageQuotaCost.fields.models),
});
const DocumentSchema = Schema.Struct({
  version: Schema.Literal(QUOTA_COST_LEDGER_VERSION),
  rows: Schema.Array(LedgerRowSchema),
});

const keyOf = (fingerprint: UsageSourceFingerprint, intervalId: string) =>
  JSON.stringify([
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
    intervalId,
  ]);

export function quotaCostLedgerKey(
  fingerprint: UsageSourceFingerprint,
  intervalId: string,
): string {
  return keyOf(fingerprint, intervalId);
}

export function decodeQuotaCostLedger(value: unknown): readonly QuotaCostLedgerRow[] {
  if (typeof value !== "object" || value === null) return [];
  const root = value as { version?: unknown; rows?: unknown };
  if (root.version !== QUOTA_COST_LEDGER_VERSION || !Array.isArray(root.rows)) return [];
  return root.rows
    .filter((row): row is QuotaCostLedgerRow => {
      if (typeof row !== "object" || row === null) return false;
      const item = row as Partial<QuotaCostLedgerRow>;
      const records = item.records;
      const unpricedRecords = item.unpricedRecords;
      const fp = item.fingerprint as Partial<UsageSourceFingerprint> | undefined;
      const fingerprintValid =
        typeof fp?.hostId === "string" &&
        typeof fp?.provider === "string" &&
        typeof fp?.resolvedHomePath === "string" &&
        typeof fp?.volumeId === "string";
      const datesValid =
        Date.parse(item.sinceTime ?? "") < Date.parse(item.untilTime ?? "") &&
        Number.isFinite(Date.parse(item.resetsAt ?? ""));
      const percentagesValid =
        typeof item.firstRemainingPercent === "number" &&
        typeof item.lastRemainingPercent === "number" &&
        item.firstRemainingPercent >= 0 &&
        item.firstRemainingPercent <= 100 &&
        item.lastRemainingPercent >= 0 &&
        item.lastRemainingPercent <= 100;
      return (
        typeof item.key === "string" &&
        typeof item.intervalId === "string" &&
        typeof item.sinceTime === "string" &&
        typeof item.untilTime === "string" &&
        typeof item.recordedAt === "string" &&
        Number.isFinite(Date.parse(item.recordedAt)) &&
        typeof item.costUsd === "number" &&
        Number.isFinite(item.costUsd) &&
        item.costUsd >= 0 &&
        typeof records === "number" &&
        Number.isSafeInteger(records) &&
        records >= 0 &&
        typeof unpricedRecords === "number" &&
        Number.isSafeInteger(unpricedRecords) &&
        unpricedRecords === 0 &&
        fingerprintValid &&
        datesValid &&
        percentagesValid &&
        item.key === keyOf(item.fingerprint as UsageSourceFingerprint, item.intervalId)
      );
    })
    .slice(-MAX_QUOTA_COST_LEDGER_ROWS);
}

export function upsertQuotaCostLedger(
  rows: readonly QuotaCostLedgerRow[],
  cost: UsageQuotaCost,
  fingerprint: UsageSourceFingerprint,
  interval: {
    readonly id: string;
    readonly sinceTime: string;
    readonly untilTime: string;
    readonly firstRemainingPercent: number;
    readonly lastRemainingPercent: number;
    readonly resetsAt: string;
  },
  recordedAt: string,
): readonly QuotaCostLedgerRow[] {
  if (
    cost.intervalId !== interval.id ||
    JSON.stringify(cost.fingerprint) !== JSON.stringify(fingerprint) ||
    !cost.complete ||
    cost.unpricedRecords !== 0 ||
    !Number.isSafeInteger(cost.records) ||
    !Number.isFinite(cost.costUsd) ||
    cost.costUsd < 0 ||
    !Number.isFinite(interval.firstRemainingPercent) ||
    !Number.isFinite(interval.lastRemainingPercent) ||
    interval.firstRemainingPercent < 0 ||
    interval.firstRemainingPercent > 100 ||
    interval.lastRemainingPercent < 0 ||
    interval.lastRemainingPercent > 100 ||
    !Number.isFinite(Date.parse(interval.sinceTime)) ||
    !Number.isFinite(Date.parse(interval.untilTime)) ||
    Date.parse(interval.sinceTime) >= Date.parse(interval.untilTime) ||
    !Number.isFinite(Date.parse(interval.resetsAt)) ||
    !Number.isFinite(Date.parse(recordedAt))
  )
    return rows;
  const key = keyOf(fingerprint, interval.id);
  const existing = rows.find((item) => item.key === key);
  if (
    existing !== undefined &&
    (existing.sinceTime !== interval.sinceTime ||
      Date.parse(existing.untilTime) > Date.parse(interval.untilTime))
  )
    return rows;
  const row: QuotaCostLedgerRow = {
    key,
    fingerprint,
    intervalId: interval.id,
    sinceTime: interval.sinceTime,
    untilTime: interval.untilTime,
    costUsd: cost.costUsd,
    records: cost.records,
    unpricedRecords: 0,
    recordedAt,
    firstRemainingPercent: interval.firstRemainingPercent,
    lastRemainingPercent: interval.lastRemainingPercent,
    resetsAt: interval.resetsAt,
    ...(cost.models === undefined ? {} : { models: cost.models }),
  };
  return [...rows.filter((item) => item.key !== row.key), row].slice(-MAX_QUOTA_COST_LEDGER_ROWS);
}

export const readQuotaCostLedger = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (info === null || Number(info.size) > MAX_QUOTA_COST_LEDGER_BYTES) return [] as const;
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (Buffer.byteLength(raw, "utf8") > MAX_QUOTA_COST_LEDGER_BYTES) return [] as const;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DocumentSchema))(raw).pipe(
      Effect.map((document) => decodeQuotaCostLedger(document)),
      Effect.orElseSucceed(() => [] as const),
    );
  });

export const writeQuotaCostLedger = (filePath: string, rows: readonly QuotaCostLedgerRow[]) =>
  Effect.gen(function* () {
    const encode = (kept: readonly QuotaCostLedgerRow[]) =>
      Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
        version: QUOTA_COST_LEDGER_VERSION,
        rows: kept,
      });
    let kept = rows.slice(-MAX_QUOTA_COST_LEDGER_ROWS);
    let contents = yield* encode(kept);
    while (kept.length > 0 && Buffer.byteLength(contents, "utf8") > MAX_QUOTA_COST_LEDGER_BYTES) {
      kept = kept.slice(1);
      contents = yield* encode(kept);
    }
    if (kept.length === 0 && rows.length > 0) return false;
    yield* writeFileStringAtomically({ filePath, contents });
    return true;
  });
