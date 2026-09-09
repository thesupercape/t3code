#!/usr/bin/env python3
"""Install a narrowly scoped macOS LaunchAgent for an SSH peer tunnel.

The installer deliberately knows only the SSH alias and loopback ports. SSH
keys, host verification, and authentication stay in the host's normal
``~/.ssh`` configuration. The default is the Millie-to-Wanda T3 connection:
local 127.0.0.1:13773 to the peer's 127.0.0.1:3773.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Any, Sequence


DEFAULT_LABEL = "com.t3tools.macos-peer-tunnel"
DEFAULT_SSH_ALIAS = "wanda-codex"
DEFAULT_LOCAL_PORT = 13773
DEFAULT_REMOTE_PORT = 3773
SSH_PATH = "/usr/bin/ssh"

_ALIAS_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")
_LABEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,127}\Z")


class SetupError(RuntimeError):
    """A safe, user-actionable setup failure."""


@dataclass(frozen=True)
class TunnelConfig:
    """Host-local values needed to describe one peer tunnel."""

    ssh_alias: str
    local_port: int
    remote_port: int
    label: str
    plist_path: pathlib.Path
    log_path: pathlib.Path

    @property
    def forward_spec(self) -> str:
        return f"127.0.0.1:{self.local_port}:127.0.0.1:{self.remote_port}"


def validate_alias(value: str) -> str:
    """Validate an SSH config alias without interpreting shell syntax."""

    if not isinstance(value, str) or not _ALIAS_RE.fullmatch(value):
        raise SetupError(
            "SSH alias must be 1-128 characters of letters, numbers, "
            "period, underscore, colon, at-sign, or hyphen."
        )
    return value


def validate_label(value: str) -> str:
    """Validate the launchd label used in the plist filename and job name."""

    if not isinstance(value, str) or not _LABEL_RE.fullmatch(value):
        raise SetupError("LaunchAgent label contains unsupported characters.")
    return value


def validate_port(value: int | str, name: str) -> int:
    """Return a TCP port in the unprivileged and privileged valid range."""

    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise SetupError(f"{name} must be an integer TCP port.") from exc
    if not 1 <= port <= 65535:
        raise SetupError(f"{name} must be between 1 and 65535.")
    return port


def make_config(
    *,
    ssh_alias: str = DEFAULT_SSH_ALIAS,
    local_port: int | str = DEFAULT_LOCAL_PORT,
    remote_port: int | str = DEFAULT_REMOTE_PORT,
    label: str = DEFAULT_LABEL,
    plist_path: str | os.PathLike[str] | None = None,
    log_path: str | os.PathLike[str] | None = None,
) -> TunnelConfig:
    """Build a validated configuration without touching the filesystem."""

    checked_label = validate_label(label)
    home = pathlib.Path.home()
    checked_plist = pathlib.Path(plist_path).expanduser() if plist_path else (
        home / "Library" / "LaunchAgents" / f"{checked_label}.plist"
    )
    checked_log = pathlib.Path(log_path).expanduser() if log_path else (
        home / "Library" / "Logs" / f"{checked_label}.log"
    )
    return TunnelConfig(
        ssh_alias=validate_alias(ssh_alias),
        local_port=validate_port(local_port, "local port"),
        remote_port=validate_port(remote_port, "remote loopback port"),
        label=checked_label,
        plist_path=checked_plist,
        log_path=checked_log,
    )


def build_plist(config: TunnelConfig) -> dict[str, Any]:
    """Return the complete LaunchAgent payload for ``config``."""

    return {
        "Label": config.label,
        "ProgramArguments": [
            SSH_PATH,
            "-N",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-L",
            config.forward_spec,
            config.ssh_alias,
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "StandardOutPath": str(config.log_path),
        "StandardErrorPath": str(config.log_path),
    }


def plist_bytes(config: TunnelConfig) -> bytes:
    """Serialize a deterministic XML plist for review and atomic writing."""

    return plistlib.dumps(build_plist(config), fmt=plistlib.FMT_XML, sort_keys=False)


def reject_symlink_components(path: pathlib.Path) -> None:
    """Reject symlinks in a path before creating or consuming host files."""

    current = pathlib.Path(path)
    while True:
        # macOS exposes /var as the standard /private/var compatibility link;
        # it is part of normal temporary-directory paths and is safe to cross.
        if current.is_symlink() and current != pathlib.Path("/var"):
            raise SetupError(f"refusing symlinked path component: {current}")
        parent = current.parent
        if parent == current:
            return
        current = parent


def validate_paths(config: TunnelConfig) -> None:
    """Ensure installer-owned paths do not traverse symlinks."""

    reject_symlink_components(config.plist_path)
    reject_symlink_components(config.log_path)


def read_existing_plist(path: pathlib.Path) -> dict[str, Any] | None:
    """Read an existing plist, preserving a clear conflict on malformed data."""

    reject_symlink_components(path)
    if not path.exists():
        return None
    try:
        value = plistlib.loads(path.read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError) as exc:
        raise SetupError(f"refusing to replace unreadable LaunchAgent: {path}") from exc
    if not isinstance(value, dict):
        raise SetupError(f"refusing to replace non-dictionary LaunchAgent: {path}")
    return value


def listener_pids(port: int) -> list[int]:
    """Find TCP listeners with lsof, failing closed if inspection is unavailable."""

    lsof = shutil.which("lsof")
    if not lsof:
        raise SetupError("lsof is required to verify local port ownership")
    result = subprocess.run(
        [lsof, "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in (0, 1):
        detail = (result.stderr or result.stdout).strip()
        raise SetupError(f"lsof could not inspect local port {port}: {detail or 'unknown error'}")
    pids: list[int] = []
    for line in result.stdout.splitlines():
        try:
            pids.append(int(line.strip()))
        except ValueError:
            continue
    return sorted(set(pids))


def launchd_job_snapshot(label: str, *, uid: int | None = None) -> dict[str, Any] | None:
    """Return the loaded job's ownership details, or ``None`` if unloaded."""

    launchctl = shutil.which("launchctl")
    if not launchctl:
        return None
    owner_uid = os.getuid() if uid is None else uid
    result = subprocess.run(
        [launchctl, "print", f"gui/{owner_uid}/{label}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None

    snapshot: dict[str, Any] = {
        "path": None,
        "program": None,
        "arguments": [],
        "pid": None,
    }
    in_arguments = False
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if line == "arguments = {":
            in_arguments = True
            continue
        if in_arguments:
            if line == "}":
                in_arguments = False
            elif line:
                snapshot["arguments"].append(line)
            continue
        if line.startswith("path = "):
            snapshot["path"] = line.removeprefix("path = ")
        elif line.startswith("program = "):
            snapshot["program"] = line.removeprefix("program = ")
        elif line.startswith("pid = "):
            try:
                snapshot["pid"] = int(line.removeprefix("pid = "))
            except ValueError:
                snapshot["pid"] = None
    return snapshot


def launchd_loaded(label: str, *, uid: int | None = None) -> bool:
    """Return whether launchd already owns the requested user job."""

    return launchd_job_snapshot(label, uid=uid) is not None


def launchd_job_matches(config: TunnelConfig, job: dict[str, Any]) -> bool:
    """Check that a loaded label currently owns this exact plist and command."""

    loaded_path = job.get("path")
    expected_path = config.plist_path.absolute()
    try:
        path_matches = pathlib.Path(loaded_path).absolute() == expected_path
    except (TypeError, ValueError):
        path_matches = False
    expected_arguments = [str(value) for value in build_plist(config)["ProgramArguments"]]
    return (
        path_matches
        and job.get("program") == SSH_PATH
        and job.get("arguments") == expected_arguments
    )


def check_conflicts(
    config: TunnelConfig,
    *,
    loaded: bool | None = None,
    job: dict[str, Any] | None = None,
) -> bool:
    """Reject a conflicting plist or listener before any write or load.

    ``True`` means the existing plist is byte-for-byte equivalent in meaning
    to this configuration. A matching loaded job may own its local port. A
    listener without that matching loaded job is always treated as a conflict.
    """

    validate_paths(config)
    expected = build_plist(config)
    existing = read_existing_plist(config.plist_path)
    matching = existing == expected
    if existing is not None and not matching:
        raise SetupError(
            f"refusing to overwrite existing LaunchAgent with a different owner: "
            f"{config.plist_path}"
        )

    if job is None and loaded is not False:
        job = launchd_job_snapshot(config.label)
    if loaded is None:
        loaded = job is not None
    if loaded and job is None:
        raise SetupError(
            f"cannot verify ownership of loaded LaunchAgent label: {config.label}"
        )
    if loaded and existing is None:
        raise SetupError(
            f"LaunchAgent label {config.label} is loaded but its expected plist is missing"
        )
    if loaded and not launchd_job_matches(config, job):
        raise SetupError(
            f"loaded LaunchAgent label {config.label} is owned by a different plist or command"
        )
    pids = listener_pids(config.local_port)
    if pids and not (
        matching
        and loaded
        and job is not None
        and launchd_job_matches(config, job)
        and job.get("pid") in pids
    ):
        owners = ", ".join(str(pid) for pid in pids)
        raise SetupError(
            f"local port {config.local_port} is already owned by listener PID(s) "
            f"{owners}; refusing to replace or share it"
        )
    return matching


def write_plist(config: TunnelConfig) -> None:
    """Atomically install a new plist without replacing a raced destination."""

    reject_symlink_components(config.plist_path)
    parent = config.plist_path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    reject_symlink_components(config.plist_path)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{config.plist_path.name}.",
        dir=parent,
        delete=False,
    ) as handle:
        temporary_path = pathlib.Path(handle.name)
        handle.write(plist_bytes(config))
    try:
        os.chmod(temporary_path, 0o600)
        try:
            os.link(temporary_path, config.plist_path)
        except FileExistsError as exc:
            raise SetupError(
                f"LaunchAgent destination appeared during setup; refusing to overwrite: "
                f"{config.plist_path}"
            ) from exc
        except OSError as exc:
            raise SetupError(
                f"could not install LaunchAgent without replacing an existing path: "
                f"{config.plist_path}"
            ) from exc
        temporary_path.unlink()
        os.chmod(config.plist_path, 0o600)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def bootstrap(config: TunnelConfig) -> None:
    """Load a new user LaunchAgent without restarting an existing one."""

    launchctl = shutil.which("launchctl")
    if not launchctl:
        raise SetupError("launchctl is required to install a macOS LaunchAgent.")
    result = subprocess.run(
        [launchctl, "bootstrap", f"gui/{os.getuid()}", str(config.plist_path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise SetupError(f"launchctl bootstrap failed: {detail or 'unknown error'}")


def ensure_log_parent(config: TunnelConfig) -> None:
    """Create the owner-only log directory after dry-run validation."""

    reject_symlink_components(config.log_path)
    try:
        config.log_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise SetupError(f"could not create log directory: {config.log_path.parent}") from exc
    reject_symlink_components(config.log_path)
    if config.log_path.exists() and not config.log_path.is_file():
        raise SetupError(f"refusing non-file log destination: {config.log_path}")


def describe(config: TunnelConfig, *, dry_run: bool, matching: bool) -> str:
    """Return a reviewable, secret-free plan/result summary."""

    state = "already installed" if matching else "would install" if dry_run else "installed"
    action = "would leave launchd unchanged" if dry_run else "loaded with launchd"
    return "\n".join(
        [
            f"state: {state}",
            f"ssh alias: {config.ssh_alias}",
            f"forward: 127.0.0.1:{config.local_port} -> peer 127.0.0.1:{config.remote_port}",
            f"LaunchAgent: {config.plist_path}",
            f"log: {config.log_path}",
            f"action: {action}",
        ]
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install a durable macOS SSH peer tunnel for a loopback T3 server."
    )
    parser.add_argument("--ssh-alias", default=DEFAULT_SSH_ALIAS)
    parser.add_argument("--local-port", default=DEFAULT_LOCAL_PORT, type=int)
    parser.add_argument("--remote-port", default=DEFAULT_REMOTE_PORT, type=int)
    parser.add_argument("--label", default=DEFAULT_LABEL)
    parser.add_argument("--plist-path", type=pathlib.Path)
    parser.add_argument("--log-path", type=pathlib.Path)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and print the plan without writing or loading anything",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    if sys.platform != "darwin":
        print("This installer is only supported on macOS.", file=sys.stderr)
        return 2
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = make_config(
            ssh_alias=args.ssh_alias,
            local_port=args.local_port,
            remote_port=args.remote_port,
            label=args.label,
            plist_path=args.plist_path,
            log_path=args.log_path,
        )
        job = launchd_job_snapshot(config.label)
        loaded = job is not None
        matching = check_conflicts(config, loaded=loaded, job=job)
        if args.dry_run:
            print(describe(config, dry_run=True, matching=matching))
            return 0
        ensure_log_parent(config)
        if not matching:
            write_plist(config)
        if not loaded:
            bootstrap(config)
        print(describe(config, dry_run=False, matching=matching))
        return 0
    except SetupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
