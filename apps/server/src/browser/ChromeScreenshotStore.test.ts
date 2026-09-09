import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { makeChromeScreenshotStore } from "./ChromeScreenshotStore.ts";

const data =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4EAAAAASUVORK5CYII=";
const capture = { tabId: "tab", mimeType: "image/png" as const, data, width: 1, height: 1 };
const TestServices = ServerConfig.layerTest(process.cwd(), { prefix: "t3-screenshot-store-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("stores a bounded PNG under its owning thread without exposing paths or bytes", () =>
  Effect.gen(function* () {
    const store = yield* makeChromeScreenshotStore();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const result = yield* store(ThreadId.make("thread-1"), capture);
    assert.match(result.attachmentId, /^thread-1-[0-9a-f-]{36}$/);
    assert.equal(
      Buffer.from(
        yield* fs.readFile(path.join(config.attachmentsDir, `${result.attachmentId}.png`)),
      ).toString("base64"),
      data,
    );
    assert.deepEqual(Object.keys(result).sort(), [
      "attachmentId",
      "height",
      "mimeType",
      "threadId",
      "width",
    ]);
  }).pipe(Effect.provide(TestServices)),
);

it.effect.each(
  [
    { data: "AQID" },
    { data: data + "!" },
    { data: data.slice(0, -16) },
    { data: "A".repeat(6_990_509) },
    { width: 2 },
    { width: 4097 },
    { height: 0 },
  ].map((patch, index) => ({ patch, index })),
)("rejects invalid screenshot input before writing an attachment: $index", ({ patch }) =>
  Effect.gen(function* () {
    const store = yield* makeChromeScreenshotStore();
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const error = yield* store(ThreadId.make("thread-1"), { ...capture, ...patch }).pipe(
      Effect.flip,
    );
    assert.include(error.detail, "invalid or oversized PNG");
    assert.deepEqual(yield* fs.readDirectory(config.attachmentsDir), []);
  }).pipe(Effect.provide(TestServices)),
);
