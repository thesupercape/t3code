# Operate T3 without desktop automation

Use `t3 agent` to inspect and operate a running T3 environment through its
authenticated APIs. It does not need a browser, screenshots, mouse input,
window focus, or Computer Use permission.

Actions use the same orchestration commands as T3 clients. They change server
state, not the selection or layout of a particular client. For example, reading
a thread does not open it in somebody else's browser. Backend readback verifies
persisted state; it does not verify that a client rendered that state.

## Select the running environment

Pass the environment's T3 home explicitly. In a development worktree, this is
usually its `.t3` directory. Do not point a test at your daily-use environment.

```sh
t3 agent capabilities --base-dir /path/to/worktree/.t3
t3 agent snapshot --base-dir /path/to/worktree/.t3
```

From a source checkout, replace `t3` with `node apps/server/src/bin.ts`.

The CLI reads that home's runtime record and checks the running server's
environment identity. It does not launch a server or fall back to an offline
engine. A missing runtime or mismatched identity is an error.

This adapter accepts only a bare loopback HTTP origin from that runtime record.
It refuses redirects. It does not send local credentials to a remote URL.

Actions recheck the observed environment and runtime before dispatch. This is a
local preflight check, not an atomic server-side concurrency guard. State may
change after observation; retain exact turn and request IDs when acting.

Inspection uses a short-lived orchestration-read session. Actions also require
orchestration-operate. These scopes cover the environment, not a single thread.
The CLI retains the credential in memory and revokes its session on normal
exit. A session expires after two minutes even if cleanup cannot finish.

## Inspect a thread before acting

Use the thread ID from the snapshot, not its title or sidebar position.

```sh
t3 agent snapshot --base-dir /path/to/worktree/.t3 --thread THREAD_ID
```

Use `--turn-limit` from 1 through 5 to bound loaded turns. Pass the returned
cursor with `--before-cursor` to inspect earlier history. Pending requests are
retained independently of the selected turn window.

The project and thread lists each contain up to 25 entries. Continue with
`--offset` set to `listPage.nextOffset` until it is null. Pages are separate
observations, not a transaction. Compare `shellSequence` between pages if
concurrent changes matter to the task.

Keep the returned environment and runtime identity with the operation you intend
to perform. Read the reported session, latest turn, and pending requests before
sending a turn-control or approval command. A compact history window is not a
claim that older messages or activities do not exist.

Selected-thread output keeps the latest eight messages and 20 activities, plus
up to 20 open-request records separately. Omission counts and truncated-question
flags identify incomplete evidence. Do not answer a request whose choices have
been truncated. Action files are limited to 256 KiB and JSON output to 192 KiB;
these limits do not cap the HTTP response's memory use before compaction.
The environment and action identifiers needed for a receipt must fit 96 KiB
of encoded JSON. This is checked before dispatch so an oversized identifier
cannot hide a receipt for an action that has already run.

## Submit an explicit action

The action file contains the expected environment, observed runtime, and a typed
T3 command. Copy identities from a current snapshot. Use a new `commandId` for
each distinct operation, and retain the exact file until its outcome is known.

Ask the CLI for a command's schema instead of reconstructing its fields from a
button label:

```sh
t3 agent capabilities --base-dir /path/to/worktree/.t3 --command thread.pin
```

The following shape pins an existing thread:

```json
{
  "environmentId": "ENVIRONMENT_ID",
  "runtime": {
    "pid": 12345,
    "startedAt": "SERVER_START_TIME_FROM_SNAPSHOT"
  },
  "command": {
    "type": "thread.pin",
    "commandId": "UNIQUE_COMMAND_ID",
    "threadId": "THREAD_ID"
  }
}
```

Review the target and action before confirming:

```sh
t3 agent act --base-dir /path/to/worktree/.t3 --file action.json --confirm
```

An accepted command is not proof that the provider finished its work. Preserve
the receipt sequence and inspect the exact thread, turn, message, or request
named by the operation. Do not treat an idle thread or a disappeared approval
as proof of success.

Check the JSON `status`, not just the process exit code. `accepted` includes the
server receipt; `rejected` means the server refused dispatch; `unknown` means
delivery could not be confirmed. A failed or oversized readback does not discard
an accepted receipt. The CLI performs one readback; it does not wait for provider
completion.

If delivery or readback fails, inspect current state before taking another
action. The CLI does not replay mutations automatically. Never reuse a
`commandId` with different content. The server's receipt deduplication does not
compare the complete command payload.

Approval commands require the exact thread ID, request ID, and decision. Neither
snapshot reads nor reconnects answer requests. `--confirm` confirms the supplied
CLI action; it does not change provider sandbox settings or approve future tools.

## Keep unsupported operations explicit

Run `capabilities` for the commands this adapter accepts. A supported command is
not proof that every provider implements it or that its target is currently
ready. Provider errors remain visible in thread state and activity.

The HTTP dispatch path does not implement the client's combined thread and
worktree bootstrap flow. Create a thread in an existing project before starting
its turn. The adapter rejects bootstrap requests rather than silently omitting
worktree setup. It does not expose arbitrary scripts, desktop input, or a
general-purpose HTTP proxy.

## Architecture

The control path is CLI, authenticated environment HTTP API, existing
orchestration engine, then the existing provider reactor. Snapshots come from
the same projections that T3 clients read. There is no second conversation store
or agent scheduler.

This follows the workspace harness's observation-and-action pattern without
copying its game-runtime core. T3 already owns authentication, command IDs,
receipts, typed actions, and conversation state. The CLI is an adapter to those
owners, not a new source of authority. It does not claim the generic harness's
signed runtime or lease guarantees.

Use browser DOM inspection only when the question concerns client rendering,
navigation, or interaction. Operating T3's server does not require Windows
Computer Use.
