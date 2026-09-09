# macOS peer access for Wanda and Millie

This runbook describes the host-local SSH and T3 connections between the two
Macs. It keeps the two durable peer tunnels separate from CodexDeck and from
any temporary desktop forward.

## Connection layout

Each Mac has its own local loopback port. The durable forwards are:

- Wanda `127.0.0.1:13773` through `millie-codex` to Millie's
  `127.0.0.1:3773`.
- Millie `127.0.0.1:13773` through `wanda-codex` to Wanda's
  `127.0.0.1:3773`.

Install each direction on the host that owns that direction. Each host's
LaunchAgent is independent, so reviewing or installing one direction does not
replace the other.

```text
Wanda 127.0.0.1:13773                  Millie 127.0.0.1:13773
    │  through millie-codex                 │  through wanda-codex
    ▼                                       ▼
Millie 127.0.0.1:3773                 Wanda 127.0.0.1:3773
```

The SSH alias, private key, known-host entry, and authorized key remain in the
host-local `~/.ssh` directories. Nothing in this repository contains a key or
credential.

The durable peer connections are separate from the other local connections:

- Keep each peer forward's current local port and owner unchanged when
  installing or reviewing the other direction.
- CodexDeck uses the existing `com.christine.codexdeck.tunnel` LaunchAgent
  and remote loopback port `8787`. Do not point this installer at `8787` or
  replace that LaunchAgent.

A managed T3 desktop connection was previously observed on port `58929`; its
current port and owner may vary. Start desktop access only through its
existing owner when specifically needed. Do not add it to this LaunchAgent,
reuse an observed desktop port for a peer T3 tunnel, or restart its process
while diagnosing port `13773`.

Do not leave both mechanisms presented as the canonical desktop connection to
the same peer. When the packaged app already owns a healthy SSH connection,
prefer that catalog connection and treat its local port as ephemeral. After
verifying the app-managed endpoint, the redundant peer LaunchAgent can be
unloaded without deleting its plist:

```sh
launchctl bootout "gui/$(id -u)/com.t3tools.macos-peer-tunnel"
```

That is recoverable with:

```sh
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.t3tools.macos-peer-tunnel.plist"
```

If a stable loopback endpoint is required by terminal clients, scripts, or a
non-desktop consumer, keep the LaunchAgent as the canonical owner instead and
remove the duplicate desktop catalog entry through the app's supported
connection settings. Never edit the encrypted connection catalog directly.

## Prerequisites

Before installing the peer tunnel, verify the following on the Mac that will
run the LaunchAgent:

1. macOS is awake and connected to power when the tunnel is needed. `KeepAlive`
   reconnects after a sleep or network interruption, but it cannot connect to
   a powered-off Mac.
2. Tailscale is connected on both Macs.
3. The SSH alias is already configured and its ED25519 host key is present in
   `~/.ssh/known_hosts`. Keep strict host-key checking enabled.
4. The peer T3 server is already running on `127.0.0.1:3773`.

Check the alias before installing:

```sh
# From Wanda to Millie
ssh -o BatchMode=yes -o ConnectTimeout=15 millie-codex 'hostname; whoami'

# From Millie to Wanda
ssh -o BatchMode=yes -o ConnectTimeout=15 wanda-codex 'hostname; whoami'
```

Each command must identify the peer Mac and the expected macOS user. A failed
login, host-key warning, or unexpected identity is a stop condition.

## Install or review the tunnel

Run the installer from a checkout of this repository on the Mac that will own
the direction. Start with a no-write plan. For Wanda-to-Millie:

```sh
python3 scripts/setup-macos-peer-tunnel.py \
  --ssh-alias millie-codex \
  --local-port 13773 \
  --remote-port 3773 \
  --dry-run
```

For Millie-to-Wanda, use the opposite alias from a Millie checkout:

```sh
python3 scripts/setup-macos-peer-tunnel.py \
  --ssh-alias wanda-codex \
  --local-port 13773 \
  --remote-port 3773 \
  --dry-run
```

After reviewing the alias, ports, and LaunchAgent path, run the selected
command without `--dry-run`. It creates
`~/Library/LaunchAgents/com.t3tools.macos-peer-tunnel.plist` with owner-only
permissions and loads it into the current user's launchd domain. It does not
create SSH keys, change `~/.ssh`, or copy data between machines.

The installer refuses to overwrite a different plist at that path. It also
refuses to claim a local port already held by another process. Choose an
explicit unused local port and review the existing owner before retrying.

The generated SSH command uses:

- `BatchMode=yes`, so it cannot hang waiting for a password;
- `ExitOnForwardFailure=yes`, so a half-open forward exits;
- `ConnectTimeout=15`;
- `ServerAliveInterval=30` and `ServerAliveCountMax=3`;
- `RunAtLoad` and `KeepAlive`; and
- `ThrottleInterval=30` to avoid a rapid retry loop.

## Verify the installed service

Inspect the user job and its listener without restarting it:

```sh
launchctl print "gui/$(id -u)/com.t3tools.macos-peer-tunnel"
lsof -nP -iTCP:13773 -sTCP:LISTEN
curl --max-time 5 -sS -w '\nhttp=%{http_code}\n' \
  http://127.0.0.1:13773/.well-known/t3/environment
```

The listener should be owned by the managed SSH process and the request should
reach the peer with HTTP 200. Inspect the response body and confirm that its
peer label and platform/host identity match the expected remote Mac. Record
environment IDs only in private operational evidence. If the peer is asleep
or T3 is stopped, the listener may be absent until launchd reconnects
successfully.

To stop the service deliberately, unload the exact label and then remove the
plist after reviewing it:

```sh
launchctl bootout "gui/$(id -u)/com.t3tools.macos-peer-tunnel"
```

Do not stop the Deck tunnel, a managed desktop forward, or the other peer T3
forward while diagnosing this service.

## SSH, file, and Codex session access

The peer SSH setup supports shell and SFTP access in both directions. Use the
existing aliases and normal host-local keys:

```sh
# From Millie to Wanda
ssh wanda-codex 'hostname; whoami'
sftp wanda-codex

# From Wanda to Millie
ssh millie-codex 'hostname; whoami'
sftp millie-codex
```

For a bounded file transfer, use a task-specific Workroom staging path and
verify the destination before replacing anything. Do not copy the two
workrooms wholesale, and do not copy or edit Codex SQLite databases while
Codex is running.

Codex session metadata can be listed or read remotely without changing the
session store:

```sh
ssh wanda-codex \
  'find ~/.codex/sessions -maxdepth 2 -type d -print | sort | tail -20'
ssh wanda-codex \
  'stat -f "%N size=%z modified=%Sm" -t "%Y-%m-%d %H:%M:%S %z" \
    ~/.codex/session_index.jsonl'
```

Use `ssh millie-codex` for the corresponding Millie metadata. A session listing
does not grant permission to merge, copy, or rewrite session history.

## Failure checks

- `Permission denied`: verify the exact alias, user, key fingerprint, and
  source restriction in `authorized_keys`. Do not switch to password prompts
  or disable `BatchMode`.
- Host-key failure: compare the live ED25519 fingerprint with the machine's
  verified host key, then repair `known_hosts` through the normal SSH workflow.
  Never add `StrictHostKeyChecking=no` to the LaunchAgent.
- Port conflict: inspect the owning process and the existing LaunchAgent
  before selecting a new local port. The installer intentionally stops rather
  than overwriting another owner's plist or listener.
- No response from port `3773`: confirm T3 is running on the peer and that
  Tailscale is connected. Do not restart another agent's T3 process from this
  runbook.
