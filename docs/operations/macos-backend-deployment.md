# Millie T3 backend deployment

`scripts/deploy-macos-backend.ts` is the guarded operator path for installing a
built T3 backend on Millie. It is deliberately separate from the native Codex
app, the existing CodexDeck tunnel on port 8787, and any Tailscale service.

The helper is a plan by default. It never SSHes, runs `launchctl`, reads the
live database, or changes a process unless `--execute` is supplied. The helper
must be run as `millie` on macOS with `HOME=/Users/millie`.

## Candidate contract

The candidate directory is a private, host-local staging directory with this
shape:

```text
backend-candidate/
  .t3-source-commit       # exactly the requested full 40-character SHA
  dist/bin.mjs
  node_modules/node-pty/
  ...other bundled runtime dependencies
```

The helper accepts in-bundle package-manager symlinks only when they resolve
inside the candidate. It rejects unresolved or escaping symlinks, an unpinned
commit, missing `dist/bin.mjs`, missing `node-pty`, and a pre-existing versioned
install directory.

Before deployment, build and copy the candidate, then stamp it with the exact
source commit without printing any environment or credential values:

```sh
printf '%s\n' "$FULL_COMMIT" > /Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/backend-candidate/.t3-source-commit
chmod 600 /Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/backend-candidate/.t3-source-commit
```

The four runtime dependencies, including `node-pty@1.1.0`, must be present in
the candidate before the helper is invoked. The helper runs the candidate once
against a fresh isolated smoke home and a separate loopback port, then removes
that smoke home after the process exits.

## Dry run and deployment

Use a new private backup root and a new private smoke-home path for every
attempt. The dry run is safe to execute from an SSH shell and does not create
either path:

```sh
cd /Users/millie/Codex_Workroom
/Users/millie/.local/lib/node-v24.18.0/bin/node \
  /path/to/deploy-macos-backend.ts \
  --dry-run \
  --commit "$FULL_COMMIT" \
  --backup-root "/Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/backend-backups" \
  --smoke-home "/Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/smoke-$FULL_COMMIT"
```

Immediately before `--execute`, inspect the current listener and command. The
operator must pass the exact listener PID observed in that inspection. The
current known process was PID 16658, but that value is never reused without a
fresh check. The process must be the old T3 entry (`t3/dist/bin.mjs` or its
`.bin/t3` symlink), use `--host 127.0.0.1`, `--port 3773`, and
`--base-dir /Users/millie/.t3`.

```sh
/Users/millie/.local/lib/node-v24.18.0/bin/node \
  /path/to/deploy-macos-backend.ts \
  --execute \
  --commit "$FULL_COMMIT" \
  --expected-old-pid 16658 \
  --backup-root "/Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/backend-backups" \
  --smoke-home "/Users/millie/Codex_Workroom/staging/t3-two-macs-20260905/smoke-$FULL_COMMIT"
```

The helper uses the fixed live paths and defaults:

- T3 home: `/Users/millie/.t3`
- SQLite database: `/Users/millie/.t3/userdata/state.sqlite`
- node: `/Users/millie/.local/lib/node-v24.18.0/bin/node`
- live endpoint: `127.0.0.1:3773`
- old entry: `~/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs`
- new install: `~/.local/lib/t3-fork/<full-commit>`
- stable wrapper: `~/.local/bin/t3`
- LaunchAgent: `~/Library/LaunchAgents/com.christinesmith.t3-fork.backend.plist`

The LaunchAgent always passes explicit loopback host, port, and base directory,
uses `RunAtLoad`, `KeepAlive`, and `ThrottleInterval=30`, and logs only to the
T3 userdata log directory. It carries only the allow-listed non-secret runtime
environment needed by native Codex (`HOME`, `PATH`, `CODEX_HOME`, and the
Codex binary/transport path settings when present). It does not copy arbitrary
shell variables or credentials.

## Safety and rollback

Before stopping the old process, the helper:

1. checks the exact loopback listener with `lsof` and the exact PID command with
   `ps`; missing `lsof`, a second listener, PID drift, or command drift fails
   closed;
2. checks the SQLite schema and counts with `sqlite3 -readonly`; active or
   starting sessions, active turns, pending approvals, pending user input, or
   unknown statuses fail closed;
3. runs the isolated candidate smoke test; and
4. creates a fresh mode-700 backup run containing a consistent `VACUUM INTO`
   SQLite copy, `PRAGMA integrity_check`, settings/identity files, provider
   configuration, secrets, attachments, and any existing owned wrapper or
   LaunchAgent.

The helper never invokes the candidate's `agent snapshot` for the live home:
that command can run migrations before returning on some builds. The SQLite
gate is the read-only pre-stop check. `provider_session_runtime` is the
authoritative live-runtime table: unknown or starting/running provider rows
block deployment. Historical projection activity is accepted only when it is
joined to an explicit stopped/error runtime row; unaccounted activity still
blocks.

The versioned install is copied through a private temporary directory and is
renamed only when the destination remains absent. Unknown existing wrappers,
LaunchAgents, symlinks, or a loaded label without a matching owned plist are
rejected. A failed health check boots out the candidate, restores the owned
wrapper/plist bytes, and starts the known old entry against the preserved home.
The backup run is retained for audit and manual recovery.

After a successful deployment, verify the loopback environment endpoint and
the exact listener identity. Do not change the existing Deck 8787 or 58929
tunnels, Tailscale mappings, the native Codex app, or the billing environment.
