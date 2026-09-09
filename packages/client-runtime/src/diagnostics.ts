const DEFAULT_PREVIEW_LIMIT = 120;

export interface DiagnosticPresentation {
  readonly preview: string;
  readonly technicalDetail: string | null;
  readonly key: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compact(value: string, limit: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function decodePartialJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\([\\"\\/bfnrt])/g, (_match, escaped: string) => {
      const decoded: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      return escaped === "\\" ? "\\" : (decoded[escaped] ?? escaped);
    });
  }
}

function extractPartialMessage(raw: string): string | null {
  const match = /["']message["']\s*:\s*["']((?:\\.|[^"'\\])*)/.exec(raw);
  return match?.[1] ? decodePartialJsonString(match[1]) : null;
}

function parseDiagnosticValue(raw: string): { message: string; technicalDetail: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { message: trimmed, technicalDetail: trimmed };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const root = asRecord(parsed);
    const fields = asRecord(root?.fields);
    const error = asRecord(root?.error);
    const message = firstString(fields?.message, root?.message, error?.message, root?.detail);
    if (message) {
      return { message, technicalDetail: trimmed };
    }
  } catch {
    const partialMessage = extractPartialMessage(trimmed);
    if (partialMessage) {
      return { message: partialMessage, technicalDetail: trimmed };
    }
  }

  return {
    message: extractPartialMessage(trimmed) ?? trimmed,
    technicalDetail: trimmed,
  };
}

export function isTechnicalRuntimeDiagnostic(rawValue: unknown): boolean {
  if (typeof rawValue !== "string") return false;
  const value = rawValue.trim();
  return (
    value.startsWith("{") &&
    /["']timestamp["']\s*:/u.test(value) &&
    /["']level["']\s*:\s*["'](?:TRACE|DEBUG|INFO|WARN|ERROR)["']/u.test(value) &&
    /["']fields["']\s*:/u.test(value)
  );
}

function endpointName(value: string): string | null {
  const arrowMatch = /(?:mcp|rmcp)?\s*([a-z0-9][a-z0-9_-]{2,})\s*[-=]>\s*https?:\/\//i.exec(value);
  if (arrowMatch?.[1]) return arrowMatch[1];

  const namedMatch = /(?:mcp\s+(?:server|endpoint)|server)\s+["']?([a-z0-9][a-z0-9_-]{2,})/i.exec(
    value,
  );
  return namedMatch?.[1] ?? null;
}

function namedMessage(message: string): { preview: string; key: string } | null {
  const normalized = message.toLowerCase();
  const name = endpointName(message);
  if (normalized.includes("worker quit with fatal") || normalized.includes("worker stopped")) {
    return { preview: "Worker stopped unexpectedly", key: "worker-stopped" };
  }

  if (
    (normalized.includes("mcp") || normalized.includes("rmcp") || name !== null) &&
    /(failed|unavailable|not listening|connection refused|request send failed|could not)/.test(
      normalized,
    )
  ) {
    return {
      preview: name ? `${name} unavailable` : "MCP server unavailable",
      key: name ? `mcp-unavailable:${name.toLowerCase()}` : "mcp-unavailable",
    };
  }

  if (
    /(streamable http|post_message|mcp initialize|handshaking with mcp)/.test(normalized) &&
    /(failed|error|refused|unavailable|retrying)/.test(normalized)
  ) {
    return {
      preview: name ? `${name} unavailable` : "MCP server unavailable",
      key: name ? `mcp-unavailable:${name.toLowerCase()}` : "mcp-unavailable",
    };
  }

  if (normalized.includes("provider") && /(failed|unavailable|exited|error)/.test(normalized)) {
    return { preview: "Provider request failed", key: "provider-request-failed" };
  }

  return null;
}

export function normalizeDiagnosticDetail(
  rawValue: unknown,
  options?: { readonly maxPreviewLength?: number },
): DiagnosticPresentation | null {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return null;
  }

  const raw = rawValue.trim();
  const parsed = parseDiagnosticValue(raw);
  const named = namedMessage(parsed.message);
  const preview = compact(
    named?.preview ?? parsed.message,
    options?.maxPreviewLength ?? DEFAULT_PREVIEW_LIMIT,
  );
  if (preview.length === 0) return null;

  return {
    preview,
    technicalDetail: parsed.technicalDetail === preview ? null : parsed.technicalDetail,
    key: named?.key ?? preview.toLowerCase(),
  };
}
