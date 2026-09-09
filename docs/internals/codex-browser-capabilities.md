# Codex browser and desktop capability boundaries

T3 drives Codex through App Server. Browser automation remains a separate
capability. A Codex model, installed plugin, or connected remote environment does
not by itself give a T3 session browser or desktop control.

## Providers and ownership

| Provider                   | State owner                                                        | T3 integration                                                     |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| T3 managed Chrome          | T3 server, separate persistent Chrome profile                      | T3 `computer_*` MCP toolkit                                        |
| T3 preview                 | T3 collaborative preview                                           | T3 `preview_*` MCP toolkit                                         |
| Codex Chrome               | OpenAI desktop host and browser extension, regular browser profile | Installed skill route; verify its host in the current session      |
| Codex built-in browser     | OpenAI desktop host, separate browser profile                      | Installed skill route; verify its host in the current session      |
| Windows Computer Use       | OpenAI Computer Use host, app approvals, Windows foreground input  | Configured MCP JavaScript runtime and installed Computer Use skill |
| Responses API computer use | The API integrator supplies screenshots and executes model actions | Not used by this integration                                       |

The OpenAI desktop documentation separates the
[built-in browser](https://learn.chatgpt.com/docs/browser),
[browser extension](https://learn.chatgpt.com/docs/chrome-extension), and
[Computer Use](https://learn.chatgpt.com/docs/computer-use). Windows Computer Use
operates on the active desktop. It needs app approvals and cannot share foreground
input with an actively working user.

T3 managed Chrome does not attach to the user's regular browser profile. The
`computer_open_url` tool can open a URL in that browser, but it supplies no
observation, screenshot, or input-control channel afterward. Do not label this
tool as a connected Codex Chrome provider.

## Capability discovery

`CodexDriver.ts` builds the Browser provider choices from routes T3 can provision.
Managed Chrome requires a discovered executable and the registered `computer_*`
toolkit. Preview requires `enableAgentBrowserAccess`, its registered toolkit, and
a connected desktop host in the same environment that supports the core browser
operations.
The driver checks executable paths without launching Chrome or reading its
profile. Provider refresh rechecks discovery. Preview setting changes and desktop
host connections, replacements, and disconnections refresh the choices. If neither
route is available, no browser selector appears.

`CodexBrowserCapabilities.ts` checks tool names for both the provider catalog and
the thread-scoped inventory from `mcpServerStatus/list`. Before each turn, the
runtime follows pagination and checks the tools actually attached to that thread.
Preview has a separate tool check because a session can receive either toolkit
independently. The selector cannot rely only on a previous turn's inventory:
selecting Preview removes the managed Chrome toolkit from that session.

An available toolkit means the agent can attempt those tool calls. It does not
mean Chrome is running, authentication succeeded, or an action has approval.
Use the provider's status and action results for runtime state. Refresh discovery
when the tool catalog changes and before a new turn; do not retain availability
after disconnect or a failed inventory read.

The capability report's `available` field describes catalog-derived selectable
T3 routes, not whether a configured skill's host is reachable. The Codex browser
and Windows entries need session-scoped host verification and are not offered as
selector choices. This does not disable their configured MCP tools or skills.
Advertise a desktop choice only after its host connection, approval, cancellation,
target selection, and observation paths are verified in the relevant runtime.
Do not infer this support from:

- `remoteControl/status/changed`, which reports remote connection identity;
- `browser_use`, `browser_use_external`, or `computer_use` feature flags;
- a plugin name, skill file, or bundled package on disk;
- an MCP JavaScript execution tool being callable;
- app metadata that lacks an effective callable runtime state.

## Supported external tools

[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
supports independently configured tool servers. A browser or OS automation MCP
server can therefore run through the same Codex conversation. Preserve that
server's tool identity and approvals.

The installed Computer Use skill documents the official `@oai/sky` package as
its entry point through `node_repl`. This is a documented skill route, not a
private endpoint or a custom helper protocol. A T3-backed Codex session has
successfully called `sky.list_apps()` through its configured `node_repl` MCP
server. That proves host reachability for that session. It does not prove that
another instance, app, window, or later session is connected or approved.

The same route also delivered the host's `Allow Codex to use notepad?` request
through `mcpServer/elicitation/request`. T3 displayed it as a permission approval
in both local and Tailscale clients. Window capture and input still require the
user's app-permission decision; host discovery alone does not verify either.

Follow the installed skill's initialization, runtime guidance, API reference,
and confirmation policy. Select exactly one returned target window. Observe
before acting and refresh after each action. Coordinate ownership of Windows
foreground input with the user. Honor host app approvals and action-time
confirmations; the skill's prohibited targets and actions still apply. Stop on
cancellation or a locked desktop. Do not launch a helper, extract credentials,
copy browser state, or create a private host client to recover an unavailable
connection.

The [App Server reference](https://learn.chatgpt.com/docs/app-server) documents
thread-scoped MCP inventory, tool calls, progress, results, and elicitation. It
also distinguishes `app/installed` effective runtime state from `app/read`
display-only metadata. The public reference currently marks the plugin
list/read/install/uninstall methods under development and tells production
clients not to use them. T3 must not make capability discovery depend on those
plugin-management methods.

The installed CLI 0.148.0 protocol exposes MCP tool calls but no dedicated
browser-navigation or Windows-input client request. The successful Windows host
check used that MCP path, so absence of a dedicated App Server request does not
establish that Computer Use is unavailable. In the same live verification,
the built-in browser and Codex Chrome skill routes returned `Browser is not
available`. That result does not establish that the Chrome extension is missing,
and it says nothing about Windows Computer Use reachability.

## Model support is not host support

[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) supports
computer use. The
[Responses API computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
requires the integrator to supply an execution environment and return screenshots.
That is a different integration from reusing Codex's desktop host. T3 does not
silently replace its ChatGPT-authenticated Codex session with separately billed
Responses API traffic.

The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) provides another way to
control Codex sessions. Its documented session API is not a contract for attaching
the desktop app's browser or foreground-input host.

## Instructions and approvals

The persisted `computerControl` option retains `preview`, `chrome`, and the legacy
`desktop` value. `desktop` grants the T3 browser toolkit, not Windows access.
Instructions describe its managed Chrome fallback explicitly. The mode selection
does not grant permissions or authorize unrelated consequential actions.
New choices omit `desktop`; the default is managed Chrome when provisionable,
otherwise Preview. Existing selection normalization resolves a saved desktop
value against the available choices without presenting it as Windows control.

`computerControlAvailable` in the instruction builder means the thread inventory
contains T3's managed Chrome toolkit. It defaults to false. The separate
`browserToolsAvailable` argument describes preview availability. Neither flag
should come from a remote-environment connection notification.
The instruction builder permits the documented configured Computer Use skill
route regardless of browser preference. It does not infer a connected Windows
host from either browser flag or from a JavaScript tool name.

Keep Codex tool calls, progress, completion/error results, and approval requests
visible in the normal event path. Image-bearing MCP results belong to the tool
that produced them; do not relabel an arbitrary MCP image as a desktop frame.
Do not acknowledge permission requests automatically because a browser mode is
selected.

Sources and local protocol checked on 2026-08-30. This document describes T3's
implemented integration boundary, not a claim that future OpenAI clients or
versions cannot expose additional host support.
