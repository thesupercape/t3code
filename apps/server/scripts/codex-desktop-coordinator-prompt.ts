import { buildCodexDesktopCoordinatorInstructions } from "../src/worker/CodexDesktopCoordinatorInstructions.ts";

const mailboxRoot = process.argv[2]?.trim();
if (!mailboxRoot) {
  throw new Error("Usage: codex-desktop-coordinator-prompt <mailbox-root>");
}

process.stdout.write(`${buildCodexDesktopCoordinatorInstructions(mailboxRoot)}\n`);
