// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeFS from "node:fs/promises";
import * as NodeWatch from "node:fs";
import * as NodePath from "node:path";

import {
  assertMailboxJobId,
  claimCodexDesktopRequest,
  createCodexDesktopMailboxLayout,
  inspectCodexDesktopRecovery,
  publishCodexDesktopBinding,
  publishCodexDesktopRequest,
  publishCodexDesktopResult,
  publishCodexDesktopStatus,
  readCodexDesktopCoordinatorLease,
  readCodexDesktopResult,
  readCodexDesktopStatus,
  renewCodexDesktopCoordinatorLease,
} from "../src/worker/CodexDesktopMailbox.ts";

const [command, mailboxRoot, argument] = process.argv.slice(2);
if (!command || !mailboxRoot) {
  throw new Error(
    "Usage: codex-desktop-mailbox <init|next|claim|inspect|status|publish-request|publish-binding|publish-status|publish-result|heartbeat|ready|result> <mailbox-root> [argument]",
  );
}

const layout = createCodexDesktopMailboxLayout(mailboxRoot);
const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const readPayload = async (filePath: string): Promise<unknown> =>
  JSON.parse(await NodeFS.readFile(NodePath.resolve(filePath), "utf8"));

const nextJob = async (timeoutMs: number): Promise<void> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("next timeout must be a finite non-negative number");
  }
  await NodeFS.mkdir(layout.requestDirectory, { recursive: true });
  const claimNext = async (): Promise<boolean> => {
    const names = (await NodeFS.readdir(layout.requestDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const jobId = name.slice(0, -".json".length);
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) continue;
      const claimed = await claimCodexDesktopRequest(layout, jobId);
      if (claimed !== undefined) {
        output({ request: claimed.request, processingPath: claimed.processingPath });
        return true;
      }
    }
    return false;
  };
  await new Promise<void>((resolve) => {
    let settled = false;
    let draining: Promise<boolean> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = (): Promise<boolean> => {
      if (draining !== undefined) return draining;
      draining = claimNext().finally(() => {
        draining = undefined;
      });
      return draining;
    };
    const finish = (claimed: boolean): void => {
      if (settled || !claimed) return;
      settled = true;
      watcher.close();
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const watcher = NodeWatch.watch(layout.requestDirectory, () => {
      void drain()
        .then(finish)
        .catch(() => undefined);
    });
    timer = setTimeout(() => {
      if (settled) return;
      if (draining !== undefined) {
        void draining.then((claimed) => {
          if (claimed) {
            finish(true);
            return;
          }
          if (settled) return;
          settled = true;
          watcher.close();
          output({ status: "timeout" });
          resolve();
        });
        return;
      }
      settled = true;
      watcher.close();
      output({ status: "timeout" });
      resolve();
    }, timeoutMs);
    // Register the watcher before scanning so a request arriving between the
    // initial scan and watch registration cannot be missed.
    void drain().then(finish, (cause) => {
      if (settled) return;
      settled = true;
      watcher.close();
      if (timer !== undefined) clearTimeout(timer);
      output({ status: "error", error: cause instanceof Error ? cause.message : String(cause) });
      resolve();
    });
  });
};

switch (command) {
  case "init":
    await Promise.all([
      NodeFS.mkdir(layout.requestDirectory, { recursive: true }),
      NodeFS.mkdir(layout.processingDirectory, { recursive: true }),
      NodeFS.mkdir(layout.bindingDirectory, { recursive: true }),
      NodeFS.mkdir(layout.resultDirectory, { recursive: true }),
      NodeFS.mkdir(layout.statusDirectory, { recursive: true }),
      NodeFS.mkdir(layout.leaseDirectory, { recursive: true }),
    ]);
    output(layout);
    break;
  case "next":
    await nextJob(argument === undefined ? 25_000 : Number(argument));
    break;
  case "claim": {
    const claimed = await claimCodexDesktopRequest(layout, assertMailboxJobId(argument ?? ""));
    output(claimed ?? { status: "already_claimed_or_absent" });
    break;
  }
  case "inspect":
    output(await inspectCodexDesktopRecovery(layout, assertMailboxJobId(argument ?? "")));
    break;
  case "status":
    output(await readCodexDesktopStatus(layout, assertMailboxJobId(argument ?? "")));
    break;
  case "publish-request":
    await publishCodexDesktopRequest(
      layout,
      (await readPayload(argument ?? "")) as Parameters<typeof publishCodexDesktopRequest>[1],
    );
    output({ status: "published" });
    break;
  case "publish-binding":
    await publishCodexDesktopBinding(
      layout,
      (await readPayload(argument ?? "")) as Parameters<typeof publishCodexDesktopBinding>[1],
    );
    output({ status: "published" });
    break;
  case "publish-result":
    await publishCodexDesktopResult(
      layout,
      (await readPayload(argument ?? "")) as Parameters<typeof publishCodexDesktopResult>[1],
    );
    output({ status: "published" });
    break;
  case "publish-status":
    await publishCodexDesktopStatus(
      layout,
      (await readPayload(argument ?? "")) as Parameters<typeof publishCodexDesktopStatus>[1],
    );
    output({ status: "published" });
    break;
  case "heartbeat": {
    const coordinatorThreadId = argument;
    if (!coordinatorThreadId) throw new Error("heartbeat requires coordinatorThreadId");
    const now = new Date();
    await renewCodexDesktopCoordinatorLease(layout, {
      schemaVersion: 1,
      coordinatorThreadId,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    output({ status: "ready", observedAt: now.toISOString() });
    break;
  }
  case "ready": {
    const lease = await readCodexDesktopCoordinatorLease(layout);
    output({
      status: lease && Date.parse(lease.expiresAt) > Date.now() ? "ready" : "unavailable",
      lease,
    });
    break;
  }
  case "result":
    output(await readCodexDesktopResult(layout, assertMailboxJobId(argument ?? "")));
    break;
  default:
    throw new Error(`Unknown mailbox command: ${command}`);
}
