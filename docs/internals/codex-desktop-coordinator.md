# Codex Desktop coordinator mailbox

T3 Workers and native Codex Desktop chats are separate identities. A T3
server cannot call the Desktop app's private `codex_app` pipe, so the bridge
uses a durable mailbox owned by one native Desktop coordinator thread.

The protocol implementation is
`apps/server/src/worker/CodexDesktopMailbox.ts`. Its root contains six
directories:

- `requests/<job-id>.json` — a new operation.
- `processing/<job-id>.json` — an atomically claimed operation.
- `bindings/<job-id>.json` — the native child thread binding, written
  immediately after `create_thread` succeeds.
- `status/<job-id>.json` — the latest short-lived claimed/started/running
  state while a child is being monitored.
- `results/<job-id>.json` — the final receipt, published atomically.
- `lease/coordinator.json` — the coordinator host lease used for readiness.

`job-id` is a UUID and all paths are derived from the configured mailbox root.
A caller also supplies a stable `requestId`. Replaying the same request ID
with an identical JSON payload is a no-op; reusing it with different data is
rejected.
A request never supplies a result path. If a start request is claimed but has
no binding, recovery reports `uncertain_start`; the coordinator must not create
a duplicate child. A binding is authoritative after a host restart and the
coordinator resumes it with native read/wait operations.

Supported operations are `start`, `send`, `read`, `wait`, `status`, and `list`.
`start` publishes its binding and started state before monitoring continues;
it carries the plain assignment and context as separate fields. `send` targets
a bound child or an explicitly selected existing native thread. `read`, `list`,
and `wait` expose only explicitly requested native thread data. Native
Desktop app tools currently do not expose hard interrupt or close operations;
the coordinator reports those requests as `unsupported` rather than sending a
misleading cancellation message.

The coordinator must run inside Codex Desktop so its native app tools and
browser runtime are available. Start it with the generated prompt:

```powershell
bun apps/server/scripts/codex-desktop-coordinator-prompt.ts <server-base-dir>\\codex-desktop-bridge
```

The Desktop host's configured project and agent permission policy control child
permissions. A saved local project with full access is required for unattended
work; the mailbox request's `permissionMode` cannot override Desktop policy. A
completed native turn becomes idle, so a heartbeat or explicit wake is required
to process later requests. The bridge must never copy credentials or connect
directly to `CODEX_APP_TOOLS_PIPE_PATH`.
