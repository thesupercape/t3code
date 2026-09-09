import { describe, expect, it } from "@effect/vitest";
import { selectTranscriptFilesForScan, type TranscriptFile } from "./usageTranscriptReader.ts";

const file = (path: string, size: number, mtimeMs: number): TranscriptFile => ({
  path,
  size,
  mtimeMs,
});

describe("selectTranscriptFilesForScan", () => {
  it("selects newest cold files within the byte budget", () => {
    const selection = selectTranscriptFilesForScan(
      [file("old", 40, 1), file("new", 60, 3), file("middle", 50, 2)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["new", "old"]);
    expect(selection.coldBytes).toBe(100);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(50);
  });

  it("always includes warm files without charging the cold budget", () => {
    const selection = selectTranscriptFilesForScan(
      [file("warm", 500, 3), file("cold", 100, 2)],
      ({ path, size }) => (path === "warm" ? 0 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["warm", "cold"]);
    expect(selection.coldBytes).toBe(100);
    expect(selection.deferredFiles).toBe(0);
  });

  it("only charges the changed transcript when the rest are warm", () => {
    const selection = selectTranscriptFilesForScan(
      [file("unchanged-a", 500, 3), file("edited", 60, 2), file("unchanged-b", 400, 1)],
      ({ path, size }) => (path !== "edited" ? 0 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual([
      "unchanged-a",
      "edited",
      "unchanged-b",
    ]);
    expect(selection.coldBytes).toBe(60);
    expect(selection.deferredFiles).toBe(0);
  });

  it("selects one oversized transcript so it cannot be deferred forever", () => {
    const selection = selectTranscriptFilesForScan(
      [file("oversized", 1_000, 3), file("small", 50, 2)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["oversized"]);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(50);
    expect(selection.coldBytes).toBe(1_000);
  });

  it("selects a formerly oversized transcript after newer files become warm", () => {
    const selection = selectTranscriptFilesForScan(
      [file("new", 60, 3), file("oversized", 1_000, 2)],
      ({ path, size }) => (path === "new" ? 0 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["new", "oversized"]);
    expect(selection.deferredFiles).toBe(0);
  });

  it("budgets only appended bytes so growing large chats do not starve other files", () => {
    const selection = selectTranscriptFilesForScan(
      [
        { ...file("active-large", 200_000_000, 3), startByte: 199_960_000 },
        { ...file("active-small", 70_000_000, 2), startByte: 69_900_000 },
        { ...file("cold", 50_000_000, 1), startByte: 0 },
      ],
      ({ size, startByte }) => size - startByte,
      128 * 1024 * 1024,
    );
    expect(selection.files.map(({ path }) => path)).toEqual([
      "active-large",
      "active-small",
      "cold",
    ]);
    expect(selection.coldBytes).toBe(50_140_000);
    expect(selection.deferredFiles).toBe(0);
  });
});
