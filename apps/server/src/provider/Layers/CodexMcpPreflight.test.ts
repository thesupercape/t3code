// @effect-diagnostics nodeBuiltinImport:off - The connector tests use a loopback HTTP server to verify address pinning without external traffic.
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import { describe, it } from "vite-plus/test";

import {
  CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
  codexMcpDisableOverride,
  collectCodexHttpMcpServers,
  createPinnedMcpRequestOptions,
  probeCodexHttpMcp,
  preflightCodexMcpServers,
  sanitizeCodexMcpEndpoint,
  validateCodexMcpEndpoint,
} from "./CodexMcpPreflight.ts";

describe("Codex MCP preflight", () => {
  const inheritedConfig = `
[mcp_servers.healthy]
url = "https://healthy.example.test/mcp"

[mcp_servers.dead]
url = "https://dead.example.test/mcp"

[mcp_servers.slow]
url = "https://slow.example.test/mcp"

[mcp_servers.local]
command = "python"
args = ["server.py"]

[mcp_servers."t3-code"]
url = "http://127.0.0.1:3774/mcp"
`;

  const publicAddresses = async () => [{ address: "93.184.216.34", family: 4 as const }];

  it("probes HTTP MCPs, excludes dead endpoints, and preserves healthy/T3/stdio servers", async () => {
    const configBefore = inheritedConfig;
    const probed: string[] = [];
    const result = await preflightCodexMcpServers({
      configTexts: [{ source: "config.toml", text: inheritedConfig }],
      appServerArgs: ["-c", 'mcp_servers."t3-code".url=http://127.0.0.1:3774/mcp'],
      probe: async (url) => {
        probed.push(url);
        return url.includes("dead")
          ? { reachable: false, reason: "connection-failed" as const }
          : { reachable: true as const };
      },
      resolveHost: publicAddresses,
    });

    NodeAssert.deepStrictEqual(probed.toSorted(), [
      "https://dead.example.test/mcp",
      "https://healthy.example.test/mcp",
      "https://slow.example.test/mcp",
    ]);
    NodeAssert.deepStrictEqual(result.disabledServerNames, ["dead"]);
    NodeAssert.deepStrictEqual(result.unavailable, [
      {
        kind: "codex.mcp.unavailable",
        serverName: "dead",
        endpoint: "https://dead.example.test/mcp",
        reason: "connection-failed",
        timeoutMs: CODEX_MCP_PREFLIGHT_TIMEOUT_MS,
      },
    ]);
    NodeAssert.equal(inheritedConfig, configBefore);
  });

  it("reports a bounded timeout as one named diagnostic", async () => {
    const result = await preflightCodexMcpServers({
      configTexts: [{ source: "config.toml", text: inheritedConfig }],
      probe: async (url, timeoutMs) => {
        NodeAssert.equal(timeoutMs, CODEX_MCP_PREFLIGHT_TIMEOUT_MS);
        return url.includes("slow")
          ? { reachable: false, reason: "timeout" as const }
          : { reachable: true as const };
      },
      resolveHost: publicAddresses,
    });

    NodeAssert.deepStrictEqual(result.disabledServerNames, ["slow"]);
    NodeAssert.equal(result.unavailable[0]?.kind, "codex.mcp.unavailable");
    NodeAssert.equal(result.unavailable[0]?.serverName, "slow");
  });

  it("does not classify local stdio MCPs or the injected T3 endpoint as HTTP servers", () => {
    NodeAssert.deepStrictEqual(
      collectCodexHttpMcpServers({
        configTexts: [{ source: "config.toml", text: inheritedConfig }],
      }),
      [
        { name: "healthy", url: "https://healthy.example.test/mcp" },
        { name: "dead", url: "https://dead.example.test/mcp" },
        { name: "slow", url: "https://slow.example.test/mcp" },
      ],
    );
  });

  it("creates session-scoped disable overrides without changing config.toml", () => {
    NodeAssert.equal(codexMcpDisableOverride("dead"), "mcp_servers.dead.enabled=false");
    NodeAssert.equal(
      codexMcpDisableOverride("server.with.dots"),
      'mcp_servers."server.with.dots".enabled=false',
    );
  });

  it("lets the nearest project config override the global and parent entries", () => {
    NodeAssert.deepStrictEqual(
      collectCodexHttpMcpServers({
        configTexts: [
          {
            source: "CODEX_HOME/config.toml",
            text: '[mcp_servers.audit]\nurl = "https://global.example.test/mcp"',
          },
          {
            source: "repo/.codex/config.toml",
            text: '[mcp_servers.audit]\nurl = "https://parent.example.test/mcp"',
          },
          {
            source: "repo/project/.codex/config.toml",
            text: '[mcp_servers.audit]\nurl = "https://nearest.example.test/mcp"',
          },
        ],
      }),
      [{ name: "audit", url: "https://nearest.example.test/mcp" }],
    );
  });

  it("blocks private, metadata, and DNS-resolved private endpoints before probing", async () => {
    const probed: string[] = [];
    const result = await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: `
[mcp_servers.loopback]
url = "http://127.0.0.1:31001/mcp"

[mcp_servers.metadata]
url = "http://169.254.169.254/latest/meta-data"

[mcp_servers.rebound]
url = "https://rebound.example.test/mcp"
`,
        },
      ],
      probe: async (url) => {
        probed.push(url);
        return { reachable: true };
      },
      resolveHost: async (hostname) =>
        hostname === "rebound.example.test"
          ? [{ address: "10.0.0.8", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
    });

    NodeAssert.deepStrictEqual(probed, []);
    NodeAssert.deepStrictEqual(
      result.unavailable.map(({ serverName, reason }) => ({ serverName, reason })),
      [
        { serverName: "loopback", reason: "blocked" },
        { serverName: "metadata", reason: "blocked" },
        { serverName: "rebound", reason: "blocked" },
      ],
    );
  });

  it("trusts only the exact T3-owned name for local MCP endpoints", async () => {
    NodeAssert.equal(
      validateCodexMcpEndpoint("t3-code", "http://127.0.0.1:3774/mcp").allowed,
      true,
    );
    NodeAssert.equal(validateCodexMcpEndpoint("other", "http://127.0.0.1:3774/mcp").allowed, false);
    NodeAssert.equal(validateCodexMcpEndpoint("other", "http://[::1]:3774/mcp").allowed, false);
    NodeAssert.equal(validateCodexMcpEndpoint("t3-code", "http://[::1]:3774/mcp").allowed, true);
    NodeAssert.equal(
      validateCodexMcpEndpoint("t3-code", "http://127.0.0.1:3774/admin").allowed,
      false,
    );

    let probed = false;
    await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: '[mcp_servers."t3-code"]\nurl = "http://127.0.0.1:3774/mcp"',
        },
      ],
      probe: async () => {
        probed = true;
        return { reachable: true };
      },
    });
    NodeAssert.equal(
      probed,
      false,
      "the injected T3 endpoint is intentionally excluded from inherited probes",
    );
  });

  it("redacts endpoint credentials, queries, and fragments from diagnostics", () => {
    NodeAssert.equal(
      sanitizeCodexMcpEndpoint("https://user:secret@example.test/mcp?token=abc#fragment"),
      "https://example.test/mcp",
    );
  });

  it("applies one deadline to delayed DNS resolution and skips the HTTP probe", async () => {
    let probed = false;
    const result = await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: '[mcp_servers.slow_dns]\nurl = "https://slow-dns.example.test/mcp"',
        },
      ],
      timeoutMs: 20,
      resolveHost: () => new Promise(() => undefined),
      probe: async () => {
        probed = true;
        return { reachable: true };
      },
    });

    NodeAssert.equal(probed, false);
    NodeAssert.deepStrictEqual(result.unavailable, [
      {
        kind: "codex.mcp.unavailable",
        serverName: "slow_dns",
        endpoint: "https://slow-dns.example.test/mcp",
        reason: "timeout",
        timeoutMs: 20,
      },
    ]);
  });

  it("pins the validated address so a second DNS answer cannot rebind the request", async () => {
    let resolutions = 0;
    let pinnedAddress: string | undefined;
    let lookupAddress: string | undefined;
    const result = await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: '[mcp_servers.rebinding]\nurl = "https://rebinding.example.test/mcp"',
        },
      ],
      resolveHost: async () => {
        resolutions += 1;
        return resolutions === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "10.0.0.8", family: 4 }];
      },
      probe: async (rawUrl, _timeoutMs, context) => {
        pinnedAddress = context.pinnedAddress.address;
        const requestOptions = createPinnedMcpRequestOptions(
          new URL(rawUrl),
          context.pinnedAddress,
          context.signal,
        );
        requestOptions.lookup?.(
          "rebinding.example.test",
          { family: 4, all: false },
          (error, address) => {
            NodeAssert.ifError(error);
            lookupAddress = typeof address === "string" ? address : address[0]?.address;
          },
        );
        return { reachable: true };
      },
    });

    NodeAssert.deepStrictEqual(result, { disabledServerNames: [], unavailable: [] });
    NodeAssert.equal(resolutions, 1);
    NodeAssert.equal(pinnedAddress, "93.184.216.34");
    NodeAssert.equal(lookupAddress, "93.184.216.34");
  });

  it("conservatively rejects every inherited IPv6 literal and DNS result", async () => {
    const addresses = [
      ["reserved-3ff0", "3ff0::1"],
      ["reserved-3ffe", "3ffe::1"],
      ["unallocated-2fff", "2fff::1"],
      ["global", "2606:4700:4700::1111"],
      ["multicast", "ff02::1"],
      ["ula", "fd00::1"],
      ["link-local", "fe80::1"],
    ] as const;
    for (const [, address] of addresses) {
      NodeAssert.equal(validateCodexMcpEndpoint("other", `http://[${address}]/mcp`).allowed, false);
    }

    const resolvedAddresses = new Map(
      addresses.map(([name, address]) => [`${name}.example.test`, address]),
    );
    const result = await preflightCodexMcpServers({
      configTexts: [
        {
          source: "config.toml",
          text: addresses
            .map(([name]) => `[mcp_servers.${name}]\nurl = "https://${name}.example.test/mcp"`)
            .join("\n\n"),
        },
      ],
      resolveHost: async (hostname) => {
        const address = resolvedAddresses.get(hostname);
        NodeAssert.ok(address !== undefined);
        return [{ address, family: 6 }];
      },
      probe: async () => {
        NodeAssert.fail("an inherited IPv6 endpoint must not be probed");
      },
    });

    NodeAssert.deepStrictEqual(
      result.unavailable.map(({ serverName, reason }) => ({ serverName, reason })),
      addresses.map(([serverName]) => ({ serverName, reason: "blocked" })),
    );
  });

  it("preserves the original Host and TLS SNI while pinning the connection address", () => {
    const controller = new AbortController();
    const options = createPinnedMcpRequestOptions(
      new URL("https://mcp.example.test:8443/mcp"),
      { address: "93.184.216.34", family: 4 },
      controller.signal,
    );

    NodeAssert.equal(options.hostname, "mcp.example.test");
    NodeAssert.equal(options.servername, "mcp.example.test");
    NodeAssert.equal(
      (options.headers as NodeHttp.OutgoingHttpHeaders).Host,
      "mcp.example.test:8443",
    );
  });

  it("reaches a healthy endpoint through the pinned address and never follows redirects", async () => {
    const receivedPaths: string[] = [];
    const receivedHosts: Array<string | undefined> = [];
    const server = NodeHttp.createServer((request, response) => {
      receivedPaths.push(request.url ?? "");
      receivedHosts.push(request.headers.host);
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "http://127.0.0.1/private" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("x".repeat(8_192));
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    NodeAssert.ok(address !== null && typeof address !== "string");

    try {
      const pinnedAddress = { address: "127.0.0.1", family: 4 as const };
      NodeAssert.deepStrictEqual(
        await probeCodexHttpMcp(`http://healthy.example.test:${address.port}/mcp`, 500, {
          pinnedAddress,
        }),
        { reachable: true },
      );
      NodeAssert.deepStrictEqual(
        await probeCodexHttpMcp(`http://healthy.example.test:${address.port}/redirect`, 500, {
          pinnedAddress,
        }),
        { reachable: false, reason: "redirected", detail: "Redirects are not followed." },
      );
      NodeAssert.deepStrictEqual(receivedPaths, ["/mcp", "/redirect"]);
      NodeAssert.deepStrictEqual(receivedHosts, [
        `healthy.example.test:${address.port}`,
        `healthy.example.test:${address.port}`,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
