// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Integration test drives the installed app-server process and a local fake Responses endpoint.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { describe, it } from "vite-plus/test";

import { buildCodexAppServerCommandArgs } from "./CodexSessionRuntime.ts";

interface RpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

function installedCodexBinary(): string | undefined {
  const explicit = process.env["T3_CODEX_INTEGRATION_BINARY"];
  if (explicit && NodeFS.existsSync(explicit)) return explicit;
  const appData = process.env["APPDATA"];
  if (!appData) return undefined;
  const binary = NodePath.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  return NodeFS.existsSync(binary) ? binary : undefined;
}

function sse(events: ReadonlyArray<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function completedEvents(id: string): ReadonlyArray<Record<string, unknown>> {
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
}

function closeServer(server: NodeHttp.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("installed Codex Worker isolation", () => {
  const binary = installedCodexBinary();

  it.skipIf(binary === undefined)(
    "removes collaboration from the real request catalog and rejects a forged call",
    async () => {
      NodeAssert.ok(binary);
      const requests: Array<Record<string, unknown>> = [];
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          requests.push(JSON.parse(body) as Record<string, unknown>);
          const events =
            requests.length === 1
              ? [
                  { type: "response.created", response: { id: "response-isolation-call" } },
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "function_call",
                      call_id: "forged-collaboration-call",
                      namespace: "collaboration",
                      name: "spawn_agent",
                      arguments: '{"message":"must not dispatch"}',
                    },
                  },
                  ...completedEvents("response-isolation-call").slice(1),
                ]
              : completedEvents("response-isolation-complete");
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(sse(events));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      NodeAssert.ok(address && typeof address === "object");

      const codexHome = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-codex-worker-isolation-"),
      );
      const sharedCodexHome = process.env["CODEX_HOME"] ?? "D:\\MovedAppData\\Codex\\.codex";
      const modelCache = NodePath.join(sharedCodexHome, "models_cache.json");
      if (NodeFS.existsSync(modelCache)) {
        NodeFS.copyFileSync(modelCache, NodePath.join(codexHome, "models_cache.json"));
      }

      const args = buildCodexAppServerCommandArgs({
        appServerArgs: [
          "-c",
          'model_provider="mock"',
          "-c",
          `model_providers.mock={ name = "mock", base_url = "http://127.0.0.1:${address.port}/v1", env_key = "PATH", wire_api = "responses" }`,
          "-c",
          'model="gpt-5.6-sol"',
          "-c",
          "features.plugins=false",
          "-c",
          "features.apps=false",
        ],
        enableT3Workers: false,
        workerSession: true,
      });
      const child: NodeChildProcess.ChildProcessWithoutNullStreams = NodeChildProcess.spawn(
        binary,
        args,
        {
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: "pipe",
        },
      );
      const pending = new Map<number, (message: RpcMessage) => void>();
      const notifications: Array<RpcMessage> = [];
      let nextId = 1;
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const lines = NodeReadline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line) as RpcMessage;
        if (message.id !== undefined) pending.get(message.id)?.(message);
        else notifications.push(message);
      });
      const request = (method: string, params: unknown): Promise<RpcMessage> =>
        new Promise((resolve) => {
          const id = nextId++;
          pending.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });

      try {
        const initialized = await request("initialize", {
          clientInfo: { name: "t3-worker-isolation-test", version: "0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
        NodeAssert.equal(initialized.error, undefined, stderr);
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);

        const effective = await request("config/read", {
          includeLayers: false,
          cwd: process.cwd(),
        });
        NodeAssert.equal(effective.error, undefined, stderr);
        const config = (effective.result as { config: Record<string, unknown> }).config;
        NodeAssert.deepStrictEqual(config["agents"], {
          enabled: false,
          max_concurrent_threads_per_session: null,
          max_depth: null,
          default_subagent_model: null,
          default_subagent_reasoning_effort: null,
          job_max_runtime_seconds: null,
          interrupt_message: null,
        });

        const started = await request("thread/start", {
          cwd: process.cwd(),
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "danger-full-access",
          model: "gpt-5.6-sol",
        });
        NodeAssert.equal(started.error, undefined, stderr);
        const threadId = (started.result as { thread: { id: string } }).thread.id;
        const turn = await request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Return OK." }],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          model: "gpt-5.6-sol",
          effort: "low",
        });
        NodeAssert.equal(turn.error, undefined, stderr);

        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error(`Timed out waiting for forged-call rejection. ${stderr}`)),
            10_000,
          );
          const poll = setInterval(() => {
            if (requests.length < 2) return;
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
          }, 20);
        });

        const firstRequest = JSON.stringify(requests[0]);
        NodeAssert.doesNotMatch(firstRequest, /"name":"collaboration"/);
        NodeAssert.match(firstRequest, /shell|exec|apply_patch/);
        const secondRequest = JSON.stringify(requests[1]);
        NodeAssert.match(secondRequest, /forged-collaboration-call/);
        NodeAssert.match(secondRequest, /not found|unknown tool|unsupported/i);
        NodeAssert.equal(
          notifications.some((message) => message.method?.startsWith("collabAgent/")),
          false,
        );
      } finally {
        lines.close();
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill();
          await exited;
        }
        await closeServer(server);
        NodeFS.rmSync(codexHome, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
    20_000,
  );
});
