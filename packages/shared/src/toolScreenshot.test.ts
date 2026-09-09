import { describe, expect, it } from "vite-plus/test";
import { readToolScreenshot, toolScreenshotFromItem } from "./toolScreenshot.ts";

const screenshot = {
  threadId: "thread-1",
  attachmentId: "thread-1-12345678-1234-1234-1234-123456789abc",
  mimeType: "image/png",
  width: 1280,
  height: 720,
};
describe("tool screenshots", () => {
  it("reads MCP structured metadata, text fallback, and projected metadata", () => {
    for (const result of [
      { screenshot },
      { structuredContent: { screenshot } },
      {
        content: [
          { type: "image", data: "pixels" },
          { type: "text", text: JSON.stringify({ screenshot }) },
        ],
      },
    ])
      expect(readToolScreenshot(result, "thread-1")).toEqual(screenshot);
  });
  it("rejects cross-thread pointers and mismatched attachment ownership", () => {
    expect(readToolScreenshot({ screenshot }, "thread-2")).toBeNull();
    expect(
      readToolScreenshot({
        screenshot: {
          ...screenshot,
          attachmentId: screenshot.attachmentId.replace("thread-1", "thread-2"),
        },
      }),
    ).toBeNull();
  });
  it("rejects paths, invalid dimensions, non-PNG content, and oversized text", () => {
    for (const patch of [
      { attachmentId: "../image.png" },
      { width: 4097 },
      { height: 0 },
      { mimeType: "image/svg+xml" },
    ])
      expect(readToolScreenshot({ screenshot: { ...screenshot, ...patch } })).toBeNull();
    expect(
      readToolScreenshot({
        content: [{ type: "text", text: " ".repeat(4096) + JSON.stringify({ screenshot }) }],
      }),
    ).toBeNull();
  });
  it("only previews screenshot tool results and drops untrusted extra fields", () => {
    expect(toolScreenshotFromItem({ tool: "other_tool", result: { screenshot } })).toBeNull();
    expect(
      toolScreenshotFromItem({
        tool: "mcp__t3__computer_screenshot",
        result: { screenshot: { ...screenshot, data: "pixels", path: "C:/secret" } },
      }),
    ).toEqual(screenshot);
  });
});
