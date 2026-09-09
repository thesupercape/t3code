import { describe, expect, it, vi } from "vite-plus/test";

import { createCodexDesktopApi, CodexDesktopApiError } from "./codexDesktopApi";

const resolvePrimaryEnvironmentHttpUrl = vi.hoisted(() =>
  vi.fn((pathname: string) => `https://t3.example.test${pathname}`),
);

vi.mock("./environments/primary", () => ({ resolvePrimaryEnvironmentHttpUrl }));

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as Response;
}

describe("Codex desktop API", () => {
  it("uses the primary environment target and preserves query parameters", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ threads: [], nextCursor: null }));
    const api = createCodexDesktopApi(fetchFn);

    await api.listThreads({ search: "release notes", cursor: "next page" });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://t3.example.test/api/codex/threads?cursor=next+page&search=release+notes",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("encodes a native thread id and sends an idempotent request", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ requestId: "request-1", status: "queued", message: null, error: null }),
      );
    const api = createCodexDesktopApi(fetchFn);

    await api.sendMessage("thread/one", { requestId: "request-1", text: "Check the build" });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://t3.example.test/api/codex/threads/thread%2Fone/messages",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ requestId: "request-1", text: "Check the build" }),
      }),
    );
  });

  it("surfaces transport failures and rejects invalid payloads", async () => {
    const failedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "Codex host is offline" }, false, 503));
    await expect(createCodexDesktopApi(failedFetch).getStatus()).rejects.toMatchObject({
      name: "CodexDesktopApiError",
      status: 503,
    } satisfies Partial<CodexDesktopApiError>);

    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ unexpected: true }));
    await expect(createCodexDesktopApi(invalidFetch).getStatus()).rejects.toThrow(
      "invalid response",
    );
  });
});
