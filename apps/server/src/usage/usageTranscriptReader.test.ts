// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  readTranscriptRecords,
  listTranscriptFiles,
  selectTranscriptFilesForScan,
  transcriptCursorIsLineBoundary,
  type TranscriptFile,
} from "./usageTranscriptReader.ts";

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

  it("returns smaller files before an oversized transcript", () => {
    const selection = selectTranscriptFilesForScan(
      [file("oversized", 1_000, 3), file("small", 50, 2)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["small"]);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(1_000);
    expect(selection.coldBytes).toBe(50);
  });

  it("selects one oversized transcript when it is the only cold work", () => {
    const selection = selectTranscriptFilesForScan(
      [file("oversized", 1_000, 3)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["oversized"]);
    expect(selection.deferredFiles).toBe(0);
    expect(selection.deferredBytes).toBe(0);
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

  it("does not starve oversized history while active rollouts only append", () => {
    const selection = selectTranscriptFilesForScan(
      [file("active", 2_000, 3), file("oversized", 1_000, 2), file("oversized-2", 900, 1)],
      ({ path, size }) => (path === "active" ? 40 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["active", "oversized"]);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(900);
    expect(selection.coldBytes).toBe(1_040);
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

describe("incremental transcript reads", () => {
  it("lists nested recent transcripts with bounded metadata batches and excludes other files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-list-"));
    const nested = NodePath.join(directory, "nested");
    try {
      await NodeFSP.mkdir(nested);
      await Promise.all(
        Array.from({ length: 70 }, (_, index) =>
          NodeFSP.writeFile(NodePath.join(nested, `${index}.jsonl`), "{}\n"),
        ),
      );
      await NodeFSP.writeFile(NodePath.join(directory, "ignore.txt"), "text");
      const old = NodePath.join(directory, "old.jsonl");
      await NodeFSP.writeFile(old, "{}\n");
      await NodeFSP.utimes(old, 1, 1);
      const files = await listTranscriptFiles(directory, 2_000, "codex");
      expect(files).toHaveLength(70);
      expect(files.every((file) => file.path.startsWith(nested) && file.size === 3)).toBe(true);
      expect(await listTranscriptFiles(NodePath.join(directory, "missing"), 0, "codex")).toEqual(
        [],
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("resumes a growing Codex JSONL file without rereading its prefix", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-append-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const first =
      [
        JSON.stringify({
          timestamp: "2026-08-29T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "session-a" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 },
            },
          },
        }),
      ].join("\n") + "\n";
    const second =
      JSON.stringify({
        timestamp: "2026-08-29T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 },
          },
        },
      }) + "\n";

    try {
      await NodeFSP.writeFile(path, first);
      const initial = await readTranscriptRecords(path, "codex", { endByte: first.length - 1 });
      expect(initial?.records).toHaveLength(1);
      expect(await transcriptCursorIsLineBoundary(path, first.length)).toBe(true);
      const codexState = initial?.codexState;
      if (codexState === undefined) throw new Error("Codex parser state was not returned");

      await NodeFSP.appendFile(path, second);
      const appended = await readTranscriptRecords(path, "codex", {
        startByte: first.length,
        endByte: first.length + second.length - 1,
        codexState,
      });

      expect(appended?.records).toHaveLength(1);
      expect(appended?.records[0]?.model).toBe("gpt-5.6-sol");
      expect(appended?.records[0]?.sessionId).toBe("session-a");
      expect(appended?.records[0]?.totals.outputTokens).toBe(4);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
