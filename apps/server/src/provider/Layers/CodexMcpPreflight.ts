// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - This is the provider boundary where Codex config and HTTP reachability are inspected.
import * as NodeFSP from "node:fs/promises";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const CODEX_MCP_PREFLIGHT_TIMEOUT_MS = 750;
const CODEX_MCP_PREFLIGHT_MAX_BODY_BYTES = 4_096;
const CODEX_MCP_PREFLIGHT_MAX_HEADER_BYTES = 16_384;
const T3_MCP_SERVER_NAME = "t3-code";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const METADATA_HOSTNAMES = new Set([
  "169.254.169.254",
  "instance-data.ec2.internal",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

export type CodexMcpUnavailableDiagnostic = {
  readonly kind: "codex.mcp.unavailable";
  readonly serverName: string;
  readonly endpoint: string;
  readonly reason: "blocked" | "redirected" | "timeout" | "connection-failed";
  readonly timeoutMs: number;
  readonly detail?: string;
};

export type CodexMcpPreflightResult = {
  readonly disabledServerNames: ReadonlyArray<string>;
  readonly unavailable: ReadonlyArray<CodexMcpUnavailableDiagnostic>;
};

type ConfigText = {
  readonly source: string;
  readonly text: string;
};

type ConfiguredMcpServer = {
  readonly name: string;
  readonly url: string;
};

type ProbeResult =
  | { readonly reachable: true }
  | {
      readonly reachable: false;
      readonly reason: "blocked" | "redirected" | "timeout" | "connection-failed";
      readonly detail?: string;
    };

type EndpointValidation =
  | { readonly allowed: true; readonly url: URL }
  | { readonly allowed: false; readonly detail: string };

export type ResolvedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

type ProbeContext = {
  readonly signal: AbortSignal;
  readonly pinnedAddress: ResolvedAddress;
};

type ResolveHost = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;
type Probe = (url: string, timeoutMs: number, context: ProbeContext) => Promise<ProbeResult>;

export type CodexMcpPreflightInput = {
  readonly homePath?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly configTexts?: ReadonlyArray<ConfigText>;
  readonly probe?: Probe;
  readonly resolveHost?: ResolveHost;
  readonly timeoutMs?: number;
};

const emptyResult = (): CodexMcpPreflightResult => ({
  disabledServerNames: [],
  unavailable: [],
});

function decodeTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(0, trimmed.lastIndexOf('"') + 1));
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end > 0 ? trimmed.slice(1, end) : undefined;
  }
  return trimmed.split(/\s+#/u, 1)[0]?.trim() || undefined;
}

function parseSectionName(line: string): string | undefined {
  const match = line.match(/^\s*\[mcp_servers\.(?:"((?:\\.|[^"])*)"|([A-Za-z0-9_-]+))\]\s*$/u);
  if (!match) return undefined;
  if (match[1] !== undefined) return decodeTomlString(`"${match[1]}"`);
  return match[2];
}

function parseConfiguredServersFromToml(text: string): ReadonlyArray<ConfiguredMcpServer> {
  const servers = new Map<string, { url: string | undefined; enabled: boolean | undefined }>();
  let currentName: string | undefined;

  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) {
      currentName = parseSectionName(line);
      continue;
    }
    if (currentName === undefined) continue;

    const keyValue = line.match(/^\s*(url|enabled)\s*=\s*(.*?)\s*(?:#.*)?$/u);
    if (!keyValue) continue;
    const entry = servers.get(currentName) ?? { url: undefined, enabled: undefined };
    if (keyValue[1] === "url") {
      entry.url = decodeTomlString(keyValue[2] ?? "");
    } else {
      entry.enabled = (keyValue[2] ?? "").trim().toLowerCase() !== "false";
    }
    servers.set(currentName, entry);
  }

  return [...servers.entries()].flatMap(([name, entry]) =>
    entry.url !== undefined && entry.enabled !== false && /^https?:\/\//iu.test(entry.url)
      ? [{ name, url: entry.url }]
      : [],
  );
}

function parseConfiguredServersFromArgs(
  appServerArgs: ReadonlyArray<string> | undefined,
): ReadonlyArray<ConfiguredMcpServer> {
  if (appServerArgs === undefined) return [];
  const servers = new Map<string, string>();
  const pattern =
    /mcp_servers\.(?:"((?:\\.|[^"])*)"|([A-Za-z0-9_-]+))\.url\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|(\S+))/u;
  for (const argument of appServerArgs) {
    const match = argument.match(pattern);
    if (!match) continue;
    const name = match[1] !== undefined ? decodeTomlString(`"${match[1]}"`) : match[2];
    const url = match[3] !== undefined ? decodeTomlString(`"${match[3]}"`) : (match[4] ?? match[5]);
    if (name !== undefined && url !== undefined && /^https?:\/\//iu.test(url)) {
      servers.set(name, url);
    }
  }
  return [...servers.entries()].map(([name, url]) => ({ name, url }));
}

function normalizedIp(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

function ipv4IsBlocked(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  const c = parts[2] ?? -1;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && c === 0) || (b === 0 && c === 2) || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6IsBlocked(): boolean {
  // Inherited HTTP MCP preflight intentionally rejects all IPv6 targets. The exact local
  // t3-code endpoint is handled separately; an IPv6 result is accepted only when it is ::1.
  return true;
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  const family = NodeNet.isIP(normalized);
  return family === 4 ? ipv4IsBlocked(normalized) : family === 6 ? ipv6IsBlocked() : true;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  return normalized === "::1" || (NodeNet.isIP(normalized) === 4 && normalized.startsWith("127."));
}

function isTrustedLocalT3Endpoint(serverName: string, url: URL): boolean {
  if (serverName !== T3_MCP_SERVER_NAME || url.protocol !== "http:") return false;
  if (url.pathname !== "/mcp") return false;
  const hostname = normalizedIp(url.hostname);
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    (NodeNet.isIP(hostname) === 4 && hostname.startsWith("127.")) ||
    (NodeNet.isIP(hostname) === 6 && hostname === "::1")
  );
}

export function validateCodexMcpEndpoint(serverName: string, rawUrl: string): EndpointValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, detail: "The endpoint URL is invalid." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, detail: "Only HTTP and HTTPS MCP endpoints are allowed." };
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, detail: "Endpoint credentials are not allowed." };
  }
  if (METADATA_HOSTNAMES.has(normalizedIp(url.hostname))) {
    return { allowed: false, detail: "Metadata service endpoints are not allowed." };
  }
  if (!isTrustedLocalT3Endpoint(serverName, url)) {
    const hostname = normalizedIp(url.hostname);
    if (
      LOOPBACK_HOSTNAMES.has(hostname) ||
      (NodeNet.isIP(hostname) !== 0 && isBlockedAddress(hostname))
    ) {
      return {
        allowed: false,
        detail: "Private, loopback, link-local, or reserved endpoints are not allowed.",
      };
    }
  }
  return { allowed: true, url };
}

export function sanitizeCodexMcpEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid endpoint]";
  }
}

export function collectCodexHttpMcpServers(input: {
  readonly configTexts: ReadonlyArray<ConfigText>;
  readonly appServerArgs?: ReadonlyArray<string>;
}): ReadonlyArray<ConfiguredMcpServer> {
  const servers = new Map<string, ConfiguredMcpServer>();
  for (const server of input.configTexts.flatMap(({ text }) =>
    parseConfiguredServersFromToml(text),
  )) {
    if (server.name !== T3_MCP_SERVER_NAME) servers.set(server.name, server);
  }
  for (const server of parseConfiguredServersFromArgs(input.appServerArgs)) {
    if (server.name !== T3_MCP_SERVER_NAME) servers.set(server.name, server);
  }
  return [...servers.values()];
}

function resolveCodexHomePath(
  input: Pick<CodexMcpPreflightInput, "homePath" | "environment">,
): string {
  const configured = input.homePath?.trim() || input.environment?.CODEX_HOME?.trim();
  if (!configured) return NodePath.join(NodeOS.homedir(), ".codex");
  return configured.startsWith("~")
    ? NodePath.join(NodeOS.homedir(), configured.slice(2))
    : NodePath.resolve(configured);
}

async function readConfigTexts(input: CodexMcpPreflightInput): Promise<ReadonlyArray<ConfigText>> {
  if (input.configTexts !== undefined) return input.configTexts;
  const paths = [NodePath.join(resolveCodexHomePath(input), "config.toml")];
  const projectPaths: string[] = [];
  if (input.cwd !== undefined) {
    let current = NodePath.resolve(input.cwd);
    while (true) {
      projectPaths.push(NodePath.join(current, ".codex", "config.toml"));
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  paths.push(...projectPaths.toReversed());

  return Promise.all(
    paths.map(async (path): Promise<ConfigText | undefined> => {
      try {
        return { source: path, text: await NodeFSP.readFile(path, "utf8") };
      } catch {
        return undefined;
      }
    }),
  ).then((texts) => texts.flatMap((text) => (text === undefined ? [] : [text])));
}

async function resolveHostAddresses(hostname: string): Promise<ReadonlyArray<ResolvedAddress>> {
  const normalized = normalizedIp(hostname);
  const literalFamily = NodeNet.isIP(normalized);
  if (literalFamily !== 0) {
    return [{ address: normalized, family: literalFamily === 4 ? 4 : 6 }];
  }
  const addresses = await NodeDnsPromises.lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );
}

function abortError(): Error {
  const error = new Error("The MCP preflight deadline expired.");
  error.name = "AbortError";
  return error;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createPinnedMcpRequestOptions(
  endpoint: URL,
  pinnedAddress: ResolvedAddress,
  signal: AbortSignal,
): NodeHttps.RequestOptions {
  const originalHostname = normalizedIp(endpoint.hostname);
  const lookup: NodeNet.LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [pinnedAddress]);
      return;
    }
    callback(null, pinnedAddress.address, pinnedAddress.family);
  };
  return {
    protocol: endpoint.protocol,
    hostname: originalHostname,
    ...(endpoint.port === "" ? {} : { port: endpoint.port }),
    path: `${endpoint.pathname}${endpoint.search}`,
    method: "GET",
    headers: {
      Accept: "application/json, text/event-stream",
      Connection: "close",
      Host: endpoint.host,
    },
    lookup,
    family: pinnedAddress.family,
    agent: false,
    signal,
    maxHeaderSize: CODEX_MCP_PREFLIGHT_MAX_HEADER_BYTES,
    ...(endpoint.protocol === "https:" && NodeNet.isIP(originalHostname) === 0
      ? { servername: originalHostname }
      : {}),
  };
}

export async function probeCodexHttpMcp(
  rawUrl: string,
  timeoutMs: number,
  options: {
    readonly pinnedAddress: ResolvedAddress;
    readonly signal?: AbortSignal;
  },
): Promise<ProbeResult> {
  const ownedController = options.signal === undefined ? new AbortController() : undefined;
  const signal = options.signal ?? ownedController!.signal;
  const timeout =
    ownedController === undefined
      ? undefined
      : setTimeout(() => ownedController.abort(), timeoutMs);
  try {
    const endpoint = new URL(rawUrl);
    const request = endpoint.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
    return await new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const finish = (result: ProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const clientRequest = request(
        createPinnedMcpRequestOptions(endpoint, options.pinnedAddress, signal),
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finish({
              reachable: false,
              reason: "redirected",
              detail: "Redirects are not followed.",
            });
            response.destroy();
            return;
          }
          let bytesRead = 0;
          response.on("data", (chunk: Buffer | string) => {
            bytesRead += Buffer.byteLength(chunk);
            if (bytesRead >= CODEX_MCP_PREFLIGHT_MAX_BODY_BYTES) {
              finish({ reachable: true });
              response.destroy();
            }
          });
          response.once("end", () => finish({ reachable: true }));
          response.once("error", (error) => {
            finish({
              reachable: false,
              reason: error.name === "AbortError" ? "timeout" : "connection-failed",
            });
          });
        },
      );
      clientRequest.once("error", (error) => {
        finish({
          reachable: false,
          reason: error.name === "AbortError" ? "timeout" : "connection-failed",
        });
      });
      clientRequest.end();
    });
  } catch (error) {
    return {
      reachable: false,
      reason:
        error instanceof Error && error.name === "AbortError" ? "timeout" : "connection-failed",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function preflightCodexMcpServers(
  input: CodexMcpPreflightInput,
): Promise<CodexMcpPreflightResult> {
  const servers = collectCodexHttpMcpServers({
    configTexts: await readConfigTexts(input),
    ...(input.appServerArgs !== undefined ? { appServerArgs: input.appServerArgs } : {}),
  });
  if (servers.length === 0) return emptyResult();

  const probe = input.probe ?? probeCodexHttpMcp;
  const timeoutMs = input.timeoutMs ?? CODEX_MCP_PREFLIGHT_TIMEOUT_MS;
  const results = await Promise.all(
    servers.map(async (server) => ({
      server,
      result: await (async (): Promise<ProbeResult> => {
        const endpoint = validateCodexMcpEndpoint(server.name, server.url);
        if (!endpoint.allowed)
          return { reachable: false, reason: "blocked", detail: endpoint.detail };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resolveHost = input.resolveHost ?? resolveHostAddresses;
          let addresses: ReadonlyArray<ResolvedAddress>;
          try {
            addresses = await withAbort(
              resolveHost(normalizedIp(endpoint.url.hostname)),
              controller.signal,
            );
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              return { reachable: false, reason: "timeout" };
            }
            return {
              reachable: false,
              reason: "connection-failed",
              detail: "DNS resolution failed.",
            };
          }
          const trustedLocal = isTrustedLocalT3Endpoint(server.name, endpoint.url);
          if (
            addresses.length === 0 ||
            addresses.some(({ address }) =>
              trustedLocal ? !isLoopbackAddress(address) : isBlockedAddress(address),
            )
          ) {
            return {
              reachable: false,
              reason: "blocked",
              detail: trustedLocal
                ? "The trusted local T3 endpoint did not resolve to a local address."
                : "The endpoint resolved to a private, loopback, link-local, or reserved address.",
            };
          }
          const pinnedAddress = addresses[0];
          if (pinnedAddress === undefined) {
            return {
              reachable: false,
              reason: "connection-failed",
              detail: "DNS returned no addresses.",
            };
          }
          return await withAbort(
            probe(server.url, timeoutMs, { signal: controller.signal, pinnedAddress }),
            controller.signal,
          ).catch((error: unknown): ProbeResult => ({
            reachable: false,
            reason:
              error instanceof Error && error.name === "AbortError"
                ? "timeout"
                : "connection-failed",
          }));
        } finally {
          clearTimeout(timeout);
        }
      })(),
    })),
  );
  const unavailable = results.flatMap(({ server, result }) =>
    result.reachable
      ? []
      : [
          {
            kind: "codex.mcp.unavailable" as const,
            serverName: server.name,
            endpoint: sanitizeCodexMcpEndpoint(server.url),
            reason: result.reason,
            timeoutMs,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
          },
        ],
  );
  return {
    disabledServerNames: unavailable.map((diagnostic) => diagnostic.serverName),
    unavailable,
  };
}

export function codexMcpDisableOverride(serverName: string): string {
  const key = /^[A-Za-z0-9_-]+$/u.test(serverName) ? serverName : JSON.stringify(serverName);
  return `mcp_servers.${key}.enabled=false`;
}
