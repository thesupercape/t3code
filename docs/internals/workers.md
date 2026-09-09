# T3 Workers

T3 Workers are server-owned, provider-neutral worker identities. A Worker has
one parent thread and can contain multiple persistent activations. Each
activation receives an explicit assignment and context package; it does not
inherit the parent transcript.

## Runtime wiring

The server composes `WorkerStoreLive`, `CodexLinkedWorkerBackendLive`,
`WorkerObserverLive`, and `WorkerServiceLive` into the runtime layer. Worker
state, activations, messages, wait leases, approvals, and raw provider-event
references are persisted by the existing SQLite persistence service.

The first backend is a linked Codex provider session. Codex CLI/app-server
0.148.0 does not expose a server-side spawn, resume, or close API for the
native collaboration tools. T3 therefore owns the Worker identity and links
each activation to a provider thread through `ProviderService`. The backend
boundary remains separate so a future native adapter can replace this link
without changing MCP, WebSocket, or persistence contracts.

Worker-linked provider thread IDs use the reserved `t3-worker-` namespace.
`WorkerService` persists and checks the exact linked IDs for lifecycle, usage,
approvals, and wake behavior. Normal `ProviderRuntimeIngestion` skips only
those persisted Worker-linked IDs, so existing native V1/V2 child-thread
ingestion remains intact.

## Parent interfaces

When `enableT3Workers` is enabled, the provider-scoped MCP credential grants
the `workers` capability and the MCP catalog registers:

- `worker_start`, `worker_list`, `worker_wait`, and `worker_status`;
- `worker_observe`, `worker_send`, `worker_interrupt`, `worker_close`, and
  `worker_approval_respond`.

Every MCP handler re-checks the capability and verifies that the target
Worker's persisted `parentThreadId` matches the invocation scope. Disabling
the setting removes the capability and the Worker toolkit from the catalog at
server startup. Because the Effect MCP server builds one catalog at startup,
changing the setting requires a server restart to rebuild the catalog; newly
issued credentials still reflect the current setting.

The WebSocket transport exposes the corresponding Worker RPCs and a filtered
subscription using the existing authorization and RPC observation layers.

## Worker inbox

The Worker inbox reads persisted Worker state. It does not render raw provider
events or chain-of-thought. The desktop layout places the Worker list beside
the selected Worker's details. The list shows status, unread direct messages,
model, elapsed time, and token usage. The detail pane shows the assignment,
explicit context, direct messages, approval requests, and observer reports.

After the Worker list loads, the inbox selects the first available Worker. If
that Worker disappears during a refresh, the inbox selects the next available
Worker and loads the matching details.

The start form accepts an explicit note, references, and snippets. Each
reference uses `path:start-end#symbol`; the line range and symbol are optional.
Each nonempty snippet line becomes one entry in the context package. The form
does not create a transcript or history field.

At 390 by 844 pixels, the list and detail panes use one column. The controls
remain at least 44 pixels high, and the panel clips horizontal overflow. The
extra context fields stay collapsed until the user opens them.

## Observer reports

The observer uses a new ephemeral provider session for each report. The session
uses a read-only sandbox and an approval policy of `never`. The observer cannot
message or interrupt the target Worker. Its prompt forbids state changes, raw
provider logs, hidden instructions, and chain-of-thought.

Before the observer returns a report, it applies the installed `unslop` skill.
The prompt tells the observer to use the installed skill instructions instead
of copying them into T3. Luna High remains the preferred observer model. The
live provider catalog controls model resolution, with the existing fallback
when Luna High is unavailable.

## Native collaboration boundary

T3 can control its own MCP catalog and parent instructions, but codex-cli
0.148.0 does not provide a stable server-side API for removing model-only
native collaboration tools from an app-server session. T3 must not claim that
those native names have been removed. The linked backend and Worker MCP
catalog are authoritative for T3-managed Workers; native child events remain
available for compatibility and are still ingested by the normal provider
pipeline.

## Recovery and limitations

Startup recovery checks persisted Worker bindings against live provider
sessions. A Worker is marked `lost` only when its binding cannot be reconciled;
an expired wait lease does not change Worker state. `worker_wait` is currently
a long-lived non-polling server call backed by a persisted lease. A future
orchestration scheduler can use the same lease and wake-event contracts to
recall a parent activity without changing the public Worker tools.
