const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*[A-Za-z]`, "g");
const CONTROL_CHARACTER_REGEX = new RegExp(
  String.raw`[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]`,
  "g",
);

export const CODEX_APP_SERVER_STDERR_MAX_CHARS = 8_192;

const AUTHORIZATION_KEY_PATTERN = String.raw`(?:["'])?\b(?:proxy[-_ ]?authorization|authorization)\b(?:["'])?`;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    new RegExp(`(${AUTHORIZATION_KEY_PATTERN}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*"`, "giu"),
    '$1"[REDACTED]"',
  ],
  [
    new RegExp(`(${AUTHORIZATION_KEY_PATTERN}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*'`, "giu"),
    "$1'[REDACTED]'",
  ],
  [
    new RegExp(`(${AUTHORIZATION_KEY_PATTERN}\\s*[:=]\\s*)([^"'\\r\\n][^\\r\\n]*)`, "giu"),
    "$1[REDACTED]",
  ],
  [
    /((?:["'])?\b(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|token|cookie|set[-_]?cookie|password|passwd|secret|credential)\b(?:["'])?\s*[:=]\s*)"[^"]*"/giu,
    '$1"[REDACTED]"',
  ],
  [
    /((?:["'])?\b(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|token|cookie|set[-_]?cookie|password|passwd|secret|credential)\b(?:["'])?\s*[:=]\s*)'[^']*'/giu,
    "$1'[REDACTED]'",
  ],
  [
    /((?:["'])?\b(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|token|cookie|set[-_]?cookie|password|passwd|secret|credential)\b(?:["'])?\s*[:=]\s*)([^"'\s,;][^\s,;]*)/giu,
    "$1[REDACTED]",
  ],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
];

export function sanitizeCodexDiagnosticText(value: string): string {
  let sanitized = value
    .replace(ANSI_ESCAPE_REGEX, "")
    .replaceAll(String.fromCharCode(0), "")
    .replace(CONTROL_CHARACTER_REGEX, "");

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

export function appendBoundedCodexDiagnostic(
  current: string,
  chunk: string,
): { readonly value: string; readonly truncated: boolean } {
  const sanitized = sanitizeCodexDiagnosticText(current + chunk);
  if (sanitized.length <= CODEX_APP_SERVER_STDERR_MAX_CHARS) {
    return { value: sanitized, truncated: false };
  }
  return {
    value: sanitized.slice(0, CODEX_APP_SERVER_STDERR_MAX_CHARS),
    truncated: true,
  };
}
