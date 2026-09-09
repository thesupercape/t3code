# macOS local desktop deployment

This runbook updates the packaged `T3 Code (Alpha).app` on a Mac from a pinned
source checkout. It is the macOS counterpart to
[`scripts/launch-t3-code.ps1`](../../scripts/launch-t3-code.ps1), but it does
not assume a Windows drive layout or a Windows service owner.

## Before deployment

The source checkout must be on the intended branch, at the exact full commit,
and clean. The deployment requires an explicit backup root outside the source
checkout and outside live T3 and Electron data. Confirm that `vp`, `sqlite3`,
`ditto`, `curl`, `lsof`, and `/usr/libexec/PlistBuddy` are available.

The workflow defaults to the Apple Silicon architecture on an arm64 Mac and to
the packaged server's loopback port `3773`. Pass `--arch x64` when building for
an Intel Mac or when the installed app requires the Intel artifact.

## No-write checks

Use the exact source commit you intend to install. This validates the checkout
and prints the build/install plan without creating output, stopping a process,
or reading live data:

```sh
EXPECTED_COMMIT="$(git -C /path/to/t3code rev-parse HEAD)"
bash scripts/launch-t3-code-macos.sh \
  --dry-run \
  --source-root "/path/to/t3code" \
  --expected-branch your-fork-branch \
  --expected-commit "$EXPECTED_COMMIT" \
  --backup-root "/Users/you/_T3_Backups"
```

Replace the source path, fork branch, and backup path with the values for the
checkout being deployed. The commit is deliberately resolved from that
checkout at run time; no historical commit is implied to be the fork's final
commit.

`--prepare-only` installs dependencies with the frozen lockfile, runs the
workspace typecheck and repository checks, and builds the desktop/server
bundles. It never installs or launches the app. `--build-only` packages the
macOS DMG and ZIP and extracts the candidate into its artifact directory; it
also never installs or launches the app. Use `--artifact-dir` to choose a
fresh, empty output directory.

## Deployment

Run during an idle window, with the existing app's work complete:

```sh
EXPECTED_COMMIT="$(git -C /path/to/t3code rev-parse HEAD)"
bash scripts/launch-t3-code-macos.sh \
  --source-root "/path/to/t3code" \
  --expected-branch your-fork-branch \
  --expected-commit "$EXPECTED_COMMIT" \
  --backup-root "/Users/you/_T3_Backups"
```

The script builds a DMG/ZIP artifact, verifies the candidate's embedded source
commit, and backs up the installed app, `~/.t3`, and
`~/Library/Application Support/t3code` under a unique run directory. The T3
SQLite database is snapshotted with `VACUUM INTO` and checked with
`PRAGMA integrity_check`; copied WAL/SHM siblings are removed from the
standalone backup snapshot so a restore cannot accidentally combine files from
different moments. Live data is never replaced by the app update.

Before replacement, the script identifies the exact app executable from
`Info.plist`, validates loopback-port ownership with `lsof`, and captures that
root PID plus its descendants. It sends signals only to those captured PIDs;
there is no `pkill`, `pgrep | kill`, or `killall`. An unrelated process on the
T3 port stops the run without being touched.

The app swap is same-filesystem and recoverable. The old bundle is moved to a
hidden `.previous.<run-id>` sibling, a durable state marker is written, and the
candidate is moved into `/Applications/T3 Code (Alpha).app`. If a process
crash interrupts the swap, a later run restores the previous sibling before it
does anything else. If the new app fails the environment and session API
checks, the candidate is retained under the backup run and the previous app is
restored and health-checked.

The previous app sibling is intentionally retained for manual recovery. The
backup run directory contains the complete app and data backups plus runtime
logs. Do not delete a run directory until its restore files are no longer
needed.

Immediately before each possible stop, the workflow requires an idle gate. It
first reads every page of `t3 agent snapshot --base-dir <T3_HOME>` and refuses
to continue for an active/starting session, running turn, pending approval, or
pending user input. The snapshot's environment identity must match the
identity recorded from `<T3_HOME>/userdata/environment-id`. If an older
desktop server does not support `agent snapshot`, the script uses a documented
read-only SQLite fallback. That fallback requires these schemas and stops on
missing columns, query errors, unknown statuses, or invalid counts:

- `projection_thread_sessions(thread_id, status, active_turn_id)` for active
  and starting turns;
- `projection_pending_approvals(request_id, thread_id, status)` for pending
  approvals; and
- `projection_threads(thread_id, pending_user_input_count)` for pending user
  input.

After launch, the public environment endpoint must return the same identity,
and the authenticated `/api/auth/session` health check must return a non-empty
successful response. A `200` response from an unrelated environment is not
accepted.

## macOS boundaries

This workflow manages a packaged app bundle only. It does not install or update
a `launchd` service, alter Tailscale Serve mappings, or create a remote access
endpoint. The packaged Electron app owns its authenticated local server and
uses the existing `T3CODE_HOME` identity. Remote server updates continue to
use the service launcher described in
[`server-updates.md`](../internals/server-updates.md); app replacement and
service replacement are separate operations on macOS.

macOS does not provide the Windows `A:`/`D:` deployment drives or the Windows
NSIS install path. The macOS artifact is produced by the repository's
`build-desktop-artifact.ts` pipeline and extracted from its ZIP so the app
bundle can be activated without Finder or a DMG mount. Code signing and
notarization remain optional build concerns and require their configured Apple
credentials when requested.
