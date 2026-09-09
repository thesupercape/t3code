// @effect-diagnostics globalDate:off nodeBuiltinImport:off
/**
 * Parsers for user-requested chat archives.
 *
 * These archives describe subscription/product chats, not API invoices. The
 * records intentionally flow through the normal pricing table so the result is
 * an API-equivalent estimate with the same model and long-context rules as CLI
 * transcripts.
 *
 * @module usageImportedChats
 */
import * as NodeCrypto from "node:crypto";

import type { UsageRecord } from "./usageTranscripts.ts";

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * ChatGPT exports contain text but no token ledger. UTF-8 bytes divided by four
 * is a deliberately simple, stable approximation; the per-message allowance
 * covers role and framing tokens without pretending tokenizer-level precision.
 */
export function estimateChatTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4)) + 4;
}

function stringContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringContent).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (record === null) return "";

  const preferred = [record["text"], record["parts"], record["content"]]
    .map(stringContent)
    .filter(Boolean);
  if (preferred.length > 0) return preferred.join("\n");

  // Structured tool-call arguments are generated tokens too. Retain scalar
  // values while ignoring attachment metadata and URLs that are not prompt text.
  return Object.entries(record)
    .filter(([key]) => !/^(?:asset_pointer|url|metadata|width|height|size)$/i.test(key))
    .map(([, nested]) => stringContent(nested))
    .filter(Boolean)
    .join("\n");
}

function timestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs;
  // ChatGPT exports use Unix seconds; other importers can already carry milliseconds.
  return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function optionalTimestampMs(value: unknown): number | null {
  const sentinel = -1;
  const parsed = timestampMs(value, sentinel);
  return parsed === sentinel ? null : parsed;
}

function normalizeImportedModel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.trim().replace(/^models\//, "");
}

function digest(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

/** Stable billing identity for one exported prompt chunk, excluding display-only branch metadata. */
function aiStudioChunkIdentity(chunk: UnknownRecord): string {
  const attachment = (key: string) => {
    const record = asRecord(chunk[key]);
    return typeof record?.["id"] === "string" ? record["id"] : null;
  };
  const inline = (key: string) => {
    const record = asRecord(chunk[key]);
    const data = typeof record?.["data"] === "string" ? record["data"] : "";
    return data.length === 0
      ? null
      : {
          mimeType: typeof record?.["mimeType"] === "string" ? record["mimeType"] : "",
          digest: digest(data),
        };
  };
  return JSON.stringify({
    role: typeof chunk["role"] === "string" ? chunk["role"] : "",
    text: stringContent(chunk["text"] ?? chunk["parts"]),
    tokenCount: positiveInt(chunk["tokenCount"]),
    isThought: chunk["isThought"] === true,
    driveDocument: attachment("driveDocument"),
    driveImage: attachment("driveImage"),
    driveVideo: attachment("driveVideo"),
    youtubeVideo: attachment("youtubeVideo"),
    inlineFile: inline("inlineFile"),
    inlineImage: inline("inlineImage"),
  });
}

function advanceHistory(history: string, chunk: UnknownRecord): string {
  return digest(`${history}\n${aiStudioChunkIdentity(chunk)}`);
}

function parseAiStudioPrompt(
  runSettings: UnknownRecord,
  systemInstruction: UnknownRecord | null,
  chunks: readonly unknown[],
  input: {
    readonly conversationId: string;
    readonly importedAtMs: number;
    readonly dedupeVariant?: string;
  },
): readonly UsageRecord[] {
  const model = normalizeImportedModel(runSettings["model"], "gemini-unknown");
  const systemText = stringContent(systemInstruction?.["text"]);
  let contextTokens = estimateChatTokens(systemText);
  let history = digest(JSON.stringify({ model, systemText }));
  let responseIndex = 0;
  const records: UsageRecord[] = [];

  for (let index = 0; index < chunks.length;) {
    const chunk = asRecord(chunks[index]);
    if (chunk === null) {
      index += 1;
      continue;
    }
    const role = chunk["role"];
    if (role !== "model") {
      const text = stringContent(chunk["text"] ?? chunk["parts"]);
      contextTokens += positiveInt(chunk["tokenCount"]) || estimateChatTokens(text);
      history = advanceHistory(history, chunk);
      index += 1;
      continue;
    }

    let outputTokens = 0;
    let reasoningTokens = 0;
    let responseTimestampMs: number | null = null;
    let responseHistory = history;
    while (index < chunks.length) {
      const modelChunk = asRecord(chunks[index]);
      if (modelChunk?.["role"] !== "model") break;
      const text = stringContent(modelChunk["text"] ?? modelChunk["parts"]);
      const tokens = positiveInt(modelChunk["tokenCount"]) || estimateChatTokens(text);
      outputTokens += tokens;
      if (modelChunk["isThought"] === true) reasoningTokens += tokens;
      responseTimestampMs = optionalTimestampMs(modelChunk["createTime"]) ?? responseTimestampMs;
      responseHistory = advanceHistory(responseHistory, modelChunk);
      index += 1;
    }
    if (outputTokens === 0) continue;

    responseIndex += 1;
    records.push({
      provider: "aistudio",
      timestampMs: responseTimestampMs ?? input.importedAtMs + responseIndex,
      model,
      sessionId: `aistudio:${input.conversationId}`,
      totals: {
        // This is the complete exported conversation context immediately before
        // this model turn, not the archive total repeated for every response.
        uncachedInputTokens: contextTokens,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens,
        reasoningTokens: Math.min(reasoningTokens, outputTokens),
      },
      reportedCostUsd: null,
      // Branch exports repeat their shared prefix. A content-chain key drops
      // those copied turns globally while keeping each branch's new response.
      dedupeKey:
        input.dedupeVariant === undefined
          ? `aistudio-turn:${responseHistory}`
          : `aistudio-turn:${input.dedupeVariant}:${responseHistory}`,
    });
    contextTokens += outputTokens;
    history = responseHistory;
  }

  return records;
}

/** Converts one Google AI Studio JSON export into one record per model turn. */
export function parseAiStudioExport(
  value: unknown,
  input: {
    readonly conversationId: string;
    /** Used only by older AI Studio exports whose chunks have no `createTime`. */
    readonly importedAtMs: number;
  },
): readonly UsageRecord[] {
  const root = asRecord(value);
  if (root === null) return [];
  const records: UsageRecord[] = [];

  const runSettings = asRecord(root["runSettings"]);
  const chunkedPrompt = asRecord(root["chunkedPrompt"]);
  const chunks = chunkedPrompt?.["chunks"];
  if (runSettings !== null && Array.isArray(chunks)) {
    records.push(
      ...parseAiStudioPrompt(runSettings, asRecord(root["systemInstruction"]), chunks, input),
    );
  }

  // AI Studio's compare mode stores each billed candidate as a separate prompt
  // and may omit the ordinary root prompt entirely.
  const comparison = asRecord(root["comparisonPrompt"]);
  const candidates = comparison?.["data"];
  if (Array.isArray(candidates)) {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = asRecord(candidates[index]);
      const candidateSettings = asRecord(candidate?.["runSettings"]);
      const candidatePrompt = asRecord(candidate?.["chunkedPrompt"]);
      const candidateChunks = candidatePrompt?.["chunks"];
      if (candidateSettings === null || !Array.isArray(candidateChunks)) continue;
      records.push(
        ...parseAiStudioPrompt(
          candidateSettings,
          asRecord(candidate?.["systemInstruction"]),
          candidateChunks,
          {
            ...input,
            conversationId: `${input.conversationId}:comparison:${index}`,
            // Two comparison candidates are two billed requests even if the
            // model happens to return byte-identical output for both.
            dedupeVariant: `comparison:${index}`,
          },
        ),
      );
    }
  }

  return records;
}

interface ChatGptNode {
  readonly id: string;
  readonly parent: string | null;
  readonly message: UnknownRecord | null;
}

function chatGptNodes(mapping: unknown): ReadonlyMap<string, ChatGptNode> {
  const root = asRecord(mapping);
  const nodes = new Map<string, ChatGptNode>();
  if (root === null) return nodes;
  for (const [fallbackId, value] of Object.entries(root)) {
    const node = asRecord(value);
    if (node === null) continue;
    const id = typeof node["id"] === "string" ? node["id"] : fallbackId;
    const parent = typeof node["parent"] === "string" ? node["parent"] : null;
    nodes.set(id, { id, parent, message: asRecord(node["message"]) });
  }
  return nodes;
}

function messageText(message: UnknownRecord): string {
  return stringContent(message["content"]);
}

function messageRole(message: UnknownRecord): string {
  return String(asRecord(message["author"])?.["role"] ?? "");
}

function chatGptModel(message: UnknownRecord, conversation: UnknownRecord): string {
  const metadata = asRecord(message["metadata"]);
  return normalizeImportedModel(
    metadata?.["model_slug"] ?? message["model_slug"] ?? conversation["default_model_slug"],
    "chatgpt-unknown",
  );
}

/** Converts a ChatGPT `conversations.json` document into estimated usage records. */
export function parseChatGptExport(
  value: unknown,
  input: { readonly importedAtMs: number },
): readonly UsageRecord[] {
  if (!Array.isArray(value)) return [];
  const records: UsageRecord[] = [];

  for (const rawConversation of value) {
    const conversation = asRecord(rawConversation);
    if (conversation === null) continue;
    const nodes = chatGptNodes(conversation["mapping"]);
    if (nodes.size === 0) continue;
    const conversationId =
      typeof conversation["id"] === "string"
        ? conversation["id"]
        : `created-${String(conversation["create_time"] ?? input.importedAtMs)}`;
    const fallbackTimestamp = timestampMs(
      conversation["create_time"] ?? conversation["update_time"],
      input.importedAtMs,
    );
    const cumulativeTokens = new Map<string, number>();
    const visiting = new Set<string>();

    const tokensThrough = (nodeId: string | null): number => {
      if (nodeId === null) return 0;
      const cached = cumulativeTokens.get(nodeId);
      if (cached !== undefined) return cached;
      if (visiting.has(nodeId)) return 0;
      const node = nodes.get(nodeId);
      if (node === undefined) return 0;
      visiting.add(nodeId);
      const own = node.message === null ? 0 : estimateChatTokens(messageText(node.message));
      const total = tokensThrough(node.parent) + own;
      visiting.delete(nodeId);
      cumulativeTokens.set(nodeId, total);
      return total;
    };

    for (const node of nodes.values()) {
      const message = node.message;
      if (message === null || messageRole(message) !== "assistant") continue;
      const outputTokens = estimateChatTokens(messageText(message));
      if (outputTokens === 0) continue;
      const messageId = typeof message["id"] === "string" ? message["id"] : node.id;
      records.push({
        provider: "chatgpt",
        timestampMs: timestampMs(message["create_time"], fallbackTimestamp),
        model: chatGptModel(message, conversation),
        sessionId: `chatgpt:${conversationId}`,
        totals: {
          uncachedInputTokens: tokensThrough(node.parent),
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        dedupeKey: `chatgpt:${conversationId}:${messageId}`,
      });
    }
  }

  return records;
}
