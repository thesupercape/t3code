import type { ThreadId, ToolScreenshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ChromeAutomationError, type ChromeAutomationScreenshot } from "./ChromeAutomation.ts";

/** Captures the existing attachment store dependencies for authenticated MCP requests. */
export const makeChromeScreenshotStore = Effect.fn("ChromeScreenshotStore.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return Effect.fn("ChromeScreenshotStore.store")(function* (
    threadId: ThreadId,
    screenshot: ChromeAutomationScreenshot,
  ) {
    const invalid = () =>
      new ChromeAutomationError(
        "screenshot",
        "Chrome returned an invalid or oversized PNG screenshot.",
      );
    if (screenshot.mimeType !== "image/png" || screenshot.data.length > 6_990_508)
      return yield* Effect.fail(invalid());
    const png = Buffer.from(screenshot.data, "base64");
    if (
      png.length < 45 ||
      png.length > 5 * 1024 * 1024 ||
      png.toString("base64") !== screenshot.data ||
      png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      png.readUInt32BE(8) !== 13 ||
      png.toString("ascii", 12, 16) !== "IHDR" ||
      png.readUInt32BE(16) !== screenshot.width ||
      png.readUInt32BE(20) !== screenshot.height ||
      !Number.isInteger(screenshot.width) ||
      !Number.isInteger(screenshot.height) ||
      screenshot.width < 1 ||
      screenshot.height < 1 ||
      screenshot.width > 4096 ||
      screenshot.height > 4096
    )
      return yield* Effect.fail(invalid());
    let offset = 8;
    let hasPixels = false;
    let hasEnd = false;
    while (offset + 12 <= png.length) {
      const length = png.readUInt32BE(offset);
      const kind = png.toString("ascii", offset + 4, offset + 8);
      if (length > png.length - offset - 12) return yield* Effect.fail(invalid());
      if (kind === "IDAT") hasPixels = true;
      offset += length + 12;
      if (kind === "IEND") {
        hasEnd = length === 0 && offset === png.length;
        break;
      }
    }
    if (!hasPixels || !hasEnd) return yield* Effect.fail(invalid());
    const attachmentId = createAttachmentId(threadId);
    if (attachmentId === null)
      return yield* Effect.fail(
        new ChromeAutomationError("screenshot", "Screenshot thread ownership is unavailable."),
      );
    const filePath = path.join(config.attachmentsDir, `${attachmentId}.png`);
    yield* fileSystem
      .writeFile(filePath, png, { flag: "wx" })
      .pipe(
        Effect.mapError(
          () => new ChromeAutomationError("screenshot", "The screenshot could not be saved."),
        ),
      );
    return {
      threadId,
      attachmentId,
      mimeType: "image/png",
      width: screenshot.width,
      height: screenshot.height,
    } satisfies ToolScreenshot;
  });
});
