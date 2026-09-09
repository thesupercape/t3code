import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { make, resolveCodexQuotaSettings } from "./UsageService.ts";
import { ServerSettings, UsageDay } from "@t3tools/contracts";
import { readQuotaHistory } from "./usageQuotaHistory.ts";

const testLayer = Layer.mergeAll(
  ServerSettingsService.layerTest(),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-quota-service-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

vi.mock("./usageQuotaHistory.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageQuotaHistory.ts")>()),
  readQuotaHistory: vi.fn(() =>
    Effect.succeed({
      status: "ready" as const,
      source: "fixture",
      samples: [],
      message: null,
    }),
  ),
}));

const decodeServerSettings = Schema.decodeSync(ServerSettings);

describe("history-only usage requests", () => {
  it("resolves the enabled default Codex provider instance before legacy settings", () => {
    const settings = decodeServerSettings({
      providers: { codex: { enabled: false } },
      providerInstances: {
        codex_work: {
          driver: "codex",
          enabled: true,
          config: { useDesktopAppDaemon: false },
        },
        codex: {
          driver: "codex",
          enabled: true,
          config: { useDesktopAppDaemon: true },
        },
      },
    });

    expect(resolveCodexQuotaSettings(settings)?.useDesktopAppDaemon).toBe(true);
  });

  it.effect("manual revalidation bypasses a warm summary and replaces that cache entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const input = {
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
        includeQuotaHistory: true,
      };
      vi.mocked(readQuotaHistory).mockClear();
      yield* service.readSummary(input);
      yield* service.readSummary(input);
      expect(readQuotaHistory).toHaveBeenCalledTimes(1);
      yield* service.readSummary({ ...input, refresh: true });
      expect(readQuotaHistory).toHaveBeenCalledTimes(2);
      yield* service.readSummary(input);
      expect(readQuotaHistory).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
  it.effect("returns saved history without touching transcript caches or model prices", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const readFileString = vi.fn(fs.readFileString);
      const request = vi.fn(() => Effect.die("History must not fetch model prices"));
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fs, readFileString }),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(request)),
      );
      const result = yield* service.readSummary({
        sinceDay: UsageDay.make("2026-07-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
        quotaHistoryOnly: true,
      });
      expect(result.quotaHistory?.status).toBe("ready");
      expect(result.sources).toEqual([]);
      expect(result.buckets).toEqual([]);
      expect(readFileString).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
  it.effect("excludes non-Codex sources from reset-cost queries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Offline fixture")),
        ),
      );
      const result = yield* service.readSummary({
        sinceDay: UsageDay.make("2026-07-01"),
        untilDay: UsageDay.make("2026-08-30"),
        timeZone: "UTC",
        quotaIntervals: [],
      });
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.sources.every((source) => source.fingerprint.provider === "codex")).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
