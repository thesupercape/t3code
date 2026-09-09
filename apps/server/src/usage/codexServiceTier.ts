import type { UsageRecord } from "./usageTranscripts.ts";

export const CODEX_TIER_JOURNAL = "usage-codex-service-tiers.jsonl";
export const CODEX_FAST_WINDOWS = "usage-codex-fast-windows.json";

export interface CodexTierObservation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly serviceTier: string;
}

export interface CodexFastWindow {
  readonly sinceTime: string;
  readonly untilTime: string;
  readonly note: string;
}

export function normalizeServiceTier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0"))
    return undefined;
  const tier = value.trim().toLowerCase();
  return tier === "fast" ? "priority" : tier;
}

/** Only native session/turn identity can match a recorded T3 request. */
export function parseCodexTierJournal(text: string): ReadonlyMap<string, string> {
  const tiers = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Partial<CodexTierObservation>;
    const tier = normalizeServiceTier(entry.serviceTier);
    if (typeof entry.sessionId === "string" && typeof entry.turnId === "string" && tier) {
      tiers.set(`${entry.sessionId}\0${entry.turnId}`, tier);
    }
  }
  return tiers;
}

/** Explicit local corrections, never inferred from today's global setting. */
export function parseCodexFastWindows(text: string): readonly CodexFastWindow[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length > 128)
    throw new Error("Expected up to 128 Fast Mode windows");
  return rows.map((row: unknown) => {
    if (typeof row !== "object" || row === null) throw new Error("Invalid Fast Mode window");
    const value = row as Partial<CodexFastWindow>;
    if (
      typeof value.sinceTime !== "string" ||
      typeof value.untilTime !== "string" ||
      typeof value.note !== "string" ||
      !value.note.trim() ||
      !Number.isFinite(Date.parse(value.sinceTime)) ||
      !Number.isFinite(Date.parse(value.untilTime)) ||
      Date.parse(value.sinceTime) >= Date.parse(value.untilTime)
    )
      throw new Error("Invalid Fast Mode window");
    return { sinceTime: value.sinceTime, untilTime: value.untilTime, note: value.note };
  });
}

export function applyCodexServiceTier(
  record: UsageRecord,
  tiers: ReadonlyMap<string, string>,
  windows: readonly CodexFastWindow[],
): UsageRecord {
  if (record.provider !== "codex" || record.serviceTier !== undefined) return record;
  const observed =
    record.turnId === undefined ? undefined : tiers.get(`${record.sessionId}\0${record.turnId}`);
  if (observed !== undefined)
    return { ...record, serviceTier: observed, serviceTierSource: "t3Request" };
  if (
    !/^(?:openai\/)?gpt-5\.(?:[45]|6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/i.test(
      record.model,
    )
  )
    return record;
  if (
    windows.some(
      (window) =>
        record.timestampMs >= Date.parse(window.sinceTime) &&
        record.timestampMs < Date.parse(window.untilTime),
    )
  ) {
    return { ...record, serviceTier: "priority", serviceTierSource: "userReported" };
  }
  return record;
}
