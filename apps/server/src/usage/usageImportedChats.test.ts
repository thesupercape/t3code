import { describe, expect, it } from "vite-plus/test";

import {
  estimateChatTokens,
  parseAiStudioExport,
  parseChatGptExport,
} from "./usageImportedChats.ts";

describe("parseAiStudioExport", () => {
  it("uses exact chunk counts and cumulative context without double-counting thoughts", () => {
    const records = parseAiStudioExport(
      {
        runSettings: { model: "models/gemini-2.5-pro" },
        systemInstruction: { text: "system" },
        chunkedPrompt: {
          chunks: [
            { role: "user", text: "first", tokenCount: 10 },
            {
              role: "model",
              text: "thinking",
              tokenCount: 3,
              isThought: true,
              createTime: "2026-03-05T17:00:01.000Z",
            },
            {
              role: "model",
              text: "answer",
              tokenCount: 7,
              createTime: "2026-03-05T17:00:02.000Z",
            },
            { role: "user", text: "next", tokenCount: 5 },
            {
              role: "model",
              text: "second",
              tokenCount: 11,
              createTime: "2026-03-06T01:02:03.000Z",
            },
          ],
        },
      },
      { conversationId: "abc", importedAtMs: 1_000 },
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "aistudio",
      model: "gemini-2.5-pro",
      timestampMs: Date.parse("2026-03-05T17:00:02.000Z"),
      totals: { outputTokens: 10, reasoningTokens: 3 },
    });
    expect(records[0]?.dedupeKey).toMatch(/^aistudio-turn:[a-f0-9]{64}$/);
    expect(records[1]?.timestampMs).toBe(Date.parse("2026-03-06T01:02:03.000Z"));
    expect(records[1]?.totals.uncachedInputTokens).toBe(estimateChatTokens("system") + 10 + 10 + 5);
  });

  it("keeps fallback ordering only when an older export has no source dates", () => {
    const records = parseAiStudioExport(
      {
        runSettings: { model: "gemini-2.5-pro" },
        chunkedPrompt: {
          chunks: [
            { role: "user", tokenCount: 4 },
            { role: "model", tokenCount: 7 },
          ],
        },
      },
      { conversationId: "old", importedAtMs: 10_000 },
    );
    expect(records[0]?.timestampMs).toBe(10_001);
  });

  it("gives copied branch-prefix turns the same key and new branch turns different keys", () => {
    const base = {
      runSettings: { model: "gemini-2.5-pro" },
      chunkedPrompt: {
        chunks: [
          { role: "user", text: "shared", tokenCount: 4 },
          { role: "model", text: "shared answer", tokenCount: 7 },
        ],
      },
    };
    const branch = {
      ...base,
      chunkedPrompt: {
        chunks: [
          ...base.chunkedPrompt.chunks,
          { role: "user", text: "branch", tokenCount: 5 },
          { role: "model", text: "branch answer", tokenCount: 8 },
        ],
      },
    };
    const baseRecords = parseAiStudioExport(base, { conversationId: "base", importedAtMs: 1 });
    const branchRecords = parseAiStudioExport(branch, {
      conversationId: "branch",
      importedAtMs: 2,
    });
    expect(branchRecords).toHaveLength(2);
    expect(branchRecords[0]?.dedupeKey).toBe(baseRecords[0]?.dedupeKey);
    expect(branchRecords[1]?.dedupeKey).not.toBe(baseRecords[0]?.dedupeKey);
    expect(branchRecords[1]?.totals.uncachedInputTokens).toBe(4 + 7 + 5);
  });

  it("counts every compare candidate as its own request", () => {
    const records = parseAiStudioExport(
      {
        comparisonPrompt: {
          data: [
            {
              runSettings: { model: "models/gemini-2.5-pro" },
              chunkedPrompt: {
                chunks: [
                  { role: "user", tokenCount: 100 },
                  { role: "model", tokenCount: 20, isThought: true },
                  { role: "model", tokenCount: 30 },
                ],
              },
            },
            {
              runSettings: { model: "models/gemini-2.5-pro" },
              chunkedPrompt: {
                chunks: [
                  { role: "user", tokenCount: 100 },
                  { role: "model", tokenCount: 20, isThought: true },
                  { role: "model", tokenCount: 30 },
                ],
              },
            },
          ],
        },
      },
      { conversationId: "compare", importedAtMs: 1_000 },
    );
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.model)).toEqual(["gemini-2.5-pro", "gemini-2.5-pro"]);
    expect(records[0]?.dedupeKey).not.toBe(records[1]?.dedupeKey);
    expect(records[0]?.totals).toMatchObject({
      uncachedInputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
    });
  });
});

describe("parseChatGptExport", () => {
  it("prices every generated branch once and reconstructs each branch context", () => {
    const records = parseChatGptExport(
      [
        {
          id: "conversation",
          create_time: 100,
          default_model_slug: "gpt-4o",
          mapping: {
            root: { id: "root", parent: null, message: null },
            user: {
              id: "user",
              parent: "root",
              message: { id: "u1", author: { role: "user" }, content: { parts: ["hello"] } },
            },
            answerA: {
              id: "answerA",
              parent: "user",
              message: {
                id: "a1",
                create_time: 101,
                author: { role: "assistant" },
                content: { parts: ["one"] },
                metadata: { model_slug: "gpt-4o" },
              },
            },
            answerB: {
              id: "answerB",
              parent: "user",
              message: {
                id: "a2",
                create_time: 102,
                author: { role: "assistant" },
                content: { parts: ["two"] },
                metadata: { model_slug: "gpt-4o" },
              },
            },
          },
        },
      ],
      { importedAtMs: 999_000 },
    );

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.dedupeKey)).toEqual([
      "chatgpt:conversation:a1",
      "chatgpt:conversation:a2",
    ]);
    expect(records[0]?.timestampMs).toBe(101_000);
    expect(records[0]?.totals.uncachedInputTokens).toBe(estimateChatTokens("hello"));
    expect(records[0]?.totals.outputTokens).toBe(estimateChatTokens("one"));
  });
});
