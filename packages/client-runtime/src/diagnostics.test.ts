import { describe, expect, it } from "vite-plus/test";
import { isTechnicalRuntimeDiagnostic, normalizeDiagnosticDetail } from "./diagnostics.js";

describe("normalizeDiagnosticDetail", () => {
  it("identifies complete and projected structured runtime logs", () => {
    expect(
      isTechnicalRuntimeDiagnostic(
        '{"timestamp":"2026-08-24T16:47:37Z","level":"WARN","fields":{"message":"streamable HTTP post_message failed"}}',
      ),
    ).toBe(true);
    expect(
      isTechnicalRuntimeDiagnostic(
        '{"timestamp":"2026-08-24T16:47:37Z","level":"ERROR","fields":{"message":"worker quit with fatal...", "endpoin...',
      ),
    ).toBe(true);
    expect(isTechnicalRuntimeDiagnostic("Provider request failed")).toBe(false);
  });

  it("extracts a useful message from serialized diagnostics and preserves the raw payload", () => {
    const result = normalizeDiagnosticDetail(
      '{"timestamp":"2026-08-24T18:17:43Z","level":"WARN","fields":{"message":"http/request send failed"}}',
    );

    expect(result).toEqual({
      preview: "http/request send failed",
      technicalDetail:
        '{"timestamp":"2026-08-24T18:17:43Z","level":"WARN","fields":{"message":"http/request send failed"}}',
      key: "http/request send failed",
    });
  });

  it("names MCP and worker failures instead of exposing transport noise", () => {
    expect(
      normalizeDiagnosticDetail(
        '{"fields":{"message":"ai-game-developer -> http://localhost:27985 request send failed"}}',
      ),
    ).toMatchObject({
      preview: "ai-game-developer unavailable",
      key: "mcp-unavailable:ai-game-developer",
    });
    expect(normalizeDiagnosticDetail("worker quit with fatal: transport closed")).toMatchObject({
      preview: "Worker stopped unexpectedly",
      key: "worker-stopped",
    });
    expect(
      normalizeDiagnosticDetail(
        '{"timestamp":"2026-08-24T18:17:40.502456Z","level":"WARN","fields":{"message":"streamable HTTP post_message failed","endpoint_host":"localhost"}',
      ),
    ).toMatchObject({ preview: "MCP server unavailable", key: "mcp-unavailable" });
  });

  it("extracts the message from a truncated JSON-like diagnostic", () => {
    const result = normalizeDiagnosticDetail(
      '{"timestamp":"2026-08-24T18:17:46.473044Z","level":"ERROR","fields":{"message":"worker quit with fatal: Transport channel closed',
    );

    expect(result).toMatchObject({
      preview: "Worker stopped unexpectedly",
      key: "worker-stopped",
    });
    expect(result?.technicalDetail).toContain('"timestamp":"2026-08-24T18:17:46.473044Z"');
  });

  it("collapses whitespace and truncates the compact preview", () => {
    const result = normalizeDiagnosticDetail("one\n two\t three", { maxPreviewLength: 10 });
    expect(result?.preview).toBe("one two t…");
  });
});
