import {
  CodexDesktopSendMessageRequest,
  CodexDesktopSendMessageResponse,
  CodexDesktopStatusResponse,
  CodexDesktopThreadHistoryResponse,
  CodexDesktopThreadListResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";
import { primaryEnvironmentHttpLayer } from "./environments/primary/httpLayer";

export class CodexDesktopApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CodexDesktopApiError";
    this.status = status;
  }
}

export interface CodexDesktopApi {
  getStatus(): Promise<CodexDesktopStatusResponse>;
  listThreads(input?: {
    cursor?: string;
    search?: string;
  }): Promise<CodexDesktopThreadListResponse>;
  getThread(
    threadId: string,
    input?: { beforeCursor?: string },
  ): Promise<CodexDesktopThreadHistoryResponse>;
  sendMessage(
    threadId: string,
    input: CodexDesktopSendMessageRequest,
  ): Promise<CodexDesktopSendMessageResponse>;
  getRequest(requestId: string): Promise<CodexDesktopSendMessageResponse>;
}

type FetchLike = typeof globalThis.fetch;

/**
 * The Codex routes are outside the generated environment HTTP API. Route them
 * through the same primary client layer so desktop bearer auth and browser
 * same-origin cookies are applied consistently with the rest of the app.
 */
const primaryEnvironmentFetch: FetchLike = async (input, init) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET") as Parameters<typeof HttpClientRequest.make>[0];
  const headers = new globalThis.Headers(init?.headers);
  const request = HttpClientRequest.make(method)(url, {
    headers: Object.fromEntries(headers.entries()),
    body:
      typeof init?.body === "string"
        ? HttpBody.text(init.body, headers.get("content-type") ?? undefined)
        : undefined,
    acceptJson: true,
  });

  return Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(request);
      const payload = yield* response.json;
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => payload,
      } as Response;
    }).pipe(Effect.provide(primaryEnvironmentHttpLayer)),
  );
};

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function apiUrl(pathname: string, searchParams?: Record<string, string | undefined>): string {
  const url = new URL(resolvePrimaryEnvironmentHttpUrl(pathname));
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function readJson(
  fetchFn: FetchLike,
  requestPath: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(
      requestPath.startsWith("http://") || requestPath.startsWith("https://")
        ? requestPath
        : apiUrl(requestPath),
      {
        credentials: "include",
        ...init,
        headers: {
          Accept: "application/json",
          ...init?.headers,
        },
      },
    );
  } catch (cause) {
    throw new CodexDesktopApiError(
      cause instanceof Error ? cause.message : "Could not reach the Codex host.",
    );
  }

  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const detail =
      typeof payload?.error === "string" ? payload.error : `Request failed (${response.status}).`;
    throw new CodexDesktopApiError(detail, response.status);
  }
  return payload;
}

function decode<A>(schema: Schema.Schema<A>, payload: unknown, endpoint: string): A {
  try {
    return Schema.decodeUnknownSync(schema as never)(payload) as A;
  } catch (cause) {
    throw new CodexDesktopApiError(`Codex host returned an invalid response for ${endpoint}.`);
  }
}

export function createCodexDesktopApi(
  fetchFn: FetchLike = primaryEnvironmentFetch,
): CodexDesktopApi {
  return {
    async getStatus() {
      return decode(
        CodexDesktopStatusResponse,
        await readJson(fetchFn, "/api/codex/status"),
        "/api/codex/status",
      );
    },
    async listThreads(input = {}) {
      const url = apiUrl("/api/codex/threads", {
        cursor: input.cursor,
        search: input.search,
      });
      return decode(
        CodexDesktopThreadListResponse,
        await readJson(fetchFn, url),
        "/api/codex/threads",
      );
    },
    async getThread(threadId, input = {}) {
      const pathname = `/api/codex/threads/${encodePathSegment(threadId)}`;
      const url = apiUrl(pathname, { beforeCursor: input.beforeCursor });
      return decode(CodexDesktopThreadHistoryResponse, await readJson(fetchFn, url), pathname);
    },
    async sendMessage(threadId, input) {
      const pathname = `/api/codex/threads/${encodePathSegment(threadId)}/messages`;
      return decode(
        CodexDesktopSendMessageResponse,
        await readJson(fetchFn, pathname, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
        pathname,
      );
    },
    async getRequest(requestId) {
      const pathname = `/api/codex/requests/${encodePathSegment(requestId)}`;
      return decode(CodexDesktopSendMessageResponse, await readJson(fetchFn, pathname), pathname);
    },
  };
}
