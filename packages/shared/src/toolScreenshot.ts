import { ToolScreenshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { toSafeThreadAttachmentSegment } from "./attachmentIds.ts";

const decodeScreenshot = Schema.decodeUnknownOption(ToolScreenshot);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const isChromeScreenshotTool = (name: unknown): boolean =>
  typeof name === "string" &&
  (name === "computer_screenshot" || name.endsWith("_computer_screenshot"));

/** Reads only bounded metadata from an MCP result, including already projected results. */
export function readToolScreenshot(result: unknown, threadId?: string): ToolScreenshot | null {
  const source = record(result);
  const candidates = [source?.screenshot, record(source?.structuredContent)?.screenshot];
  if (Array.isArray(source?.content)) {
    for (const entry of source.content.slice(0, 8)) {
      const block = record(entry);
      if (block?.type !== "text" || typeof block.text !== "string" || block.text.length > 4096)
        continue;
      const decoded = decodeJson(block.text);
      if (Option.isSome(decoded)) candidates.push(record(decoded.value)?.screenshot);
    }
  }
  for (const candidate of candidates) {
    const decoded = decodeScreenshot(candidate);
    if (Option.isNone(decoded)) continue;
    const screenshot = decoded.value;
    const segment = toSafeThreadAttachmentSegment(screenshot.threadId);
    if (segment === null || screenshot.attachmentId.slice(0, -37) !== segment) continue;
    if (threadId !== undefined && screenshot.threadId !== threadId) continue;
    return screenshot;
  }
  return null;
}

export function toolScreenshotFromItem(item: unknown, threadId?: string): ToolScreenshot | null {
  const source = record(item);
  return isChromeScreenshotTool(source?.tool ?? source?.toolName)
    ? readToolScreenshot(source?.result, threadId)
    : null;
}
