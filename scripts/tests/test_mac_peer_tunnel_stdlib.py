#!/usr/bin/env python3
"""Focused stdlib tests for setup-macos-peer-tunnel.py."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import pathlib
import plistlib
import stat
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "setup-macos-peer-tunnel.py"
SPEC = importlib.util.spec_from_file_location("setup_macos_peer_tunnel", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MacPeerTunnelStdlibTests(unittest.TestCase):
    def make_config(self, root: pathlib.Path, **overrides):
        values = {
            "ssh_alias": "wanda-codex",
            "local_port": 13773,
            "remote_port": 3773,
            "label": "com.example.mac-peer-test",
            "plist_path": root / "LaunchAgents" / "peer.plist",
            "log_path": root / "Logs" / "peer.log",
        }
        values.update(overrides)
        return MODULE.make_config(**values)

    def test_default_forward_is_loopback_only_and_contains_no_key_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            plist = MODULE.build_plist(config)

        self.assertEqual(
            plist["ProgramArguments"],
            [
                "/usr/bin/ssh",
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
                "127.0.0.1:13773:127.0.0.1:3773",
                "wanda-codex",
            ],
        )
        serialized = MODULE.plist_bytes(config).decode("utf-8")
        self.assertNotIn("IdentityFile", serialized)
        self.assertNotIn("authorized_keys", serialized)
        self.assertNotIn("PRIVATE", serialized)
        self.assertTrue(plist["KeepAlive"])
        self.assertTrue(plist["RunAtLoad"])
        self.assertEqual(plist["ThrottleInterval"], 30)

    def test_validation_rejects_shell_and_out_of_range_values(self):
        for alias in ("", "ssh -o BatchMode=no", "../peer", "-peer"):
            with self.subTest(alias=alias):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.validate_alias(alias)

        for value in (0, -1, 65536, "not-a-port"):
            with self.subTest(value=value):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.validate_port(value, "local port")

    def test_atomic_write_uses_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            MODULE.write_plist(config)

            self.assertEqual(stat.S_IMODE(config.plist_path.stat().st_mode), 0o600)
            payload = plistlib.loads(config.plist_path.read_bytes())
            self.assertEqual(payload, MODULE.build_plist(config))

            with self.assertRaises(MODULE.SetupError):
                MODULE.write_plist(config)
            self.assertEqual(payload, plistlib.loads(config.plist_path.read_bytes()))

    def test_different_existing_plist_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            config = self.make_config(root)
            config.plist_path.parent.mkdir(parents=True)
            original = b"<?xml version=\"1.0\"?><plist><dict><key>Owner</key><string>other</string></dict></plist>"
            config.plist_path.write_bytes(original)

            with self.assertRaises(MODULE.SetupError):
                MODULE.check_conflicts(config, loaded=False)
            self.assertEqual(config.plist_path.read_bytes(), original)

    def test_listener_conflict_is_rejected_before_a_new_plist_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            with mock.patch.object(MODULE, "listener_pids", return_value=[4321]):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.check_conflicts(config, loaded=False)
            self.assertFalse(config.plist_path.exists())

    def test_missing_lsof_fails_closed(self):
        with mock.patch.object(MODULE.shutil, "which", return_value=None):
            with self.assertRaises(MODULE.SetupError):
                MODULE.listener_pids(13773)

    def test_launchd_snapshot_parses_current_owner_fields(self):
        output = """gui/501/com.example.mac-peer-test = {
    path = /tmp/peer.plist
    program = /usr/bin/ssh
    arguments = {
        /usr/bin/ssh
        -N
        -T
        -L
        127.0.0.1:13773:127.0.0.1:3773
        wanda-codex
    }
    pid = 4321
}
"""
        completed = mock.Mock(returncode=0, stdout=output, stderr="")
        with (
            mock.patch.object(MODULE.shutil, "which", return_value="/bin/launchctl"),
            mock.patch.object(MODULE.subprocess, "run", return_value=completed),
        ):
            snapshot = MODULE.launchd_job_snapshot("com.example.mac-peer-test", uid=501)

        self.assertEqual(snapshot["path"], "/tmp/peer.plist")
        self.assertEqual(snapshot["program"], "/usr/bin/ssh")
        self.assertEqual(snapshot["pid"], 4321)
        self.assertEqual(snapshot["arguments"][-2:], [
            "127.0.0.1:13773:127.0.0.1:3773",
            "wanda-codex",
        ])

    def test_loaded_label_without_matching_plist_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            expected = MODULE.build_plist(config)
            job = {
                "path": str(config.plist_path),
                "program": MODULE.SSH_PATH,
                "arguments": [str(value) for value in expected["ProgramArguments"]],
                "pid": 4321,
            }
            with mock.patch.object(MODULE, "listener_pids", return_value=[]):
                with self.assertRaisesRegex(MODULE.SetupError, "plist is missing"):
                    MODULE.check_conflicts(config, job=job)

    def test_loaded_job_must_own_plist_command_and_listener_pid(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            config = self.make_config(root)
            MODULE.write_plist(config)
            expected = MODULE.build_plist(config)
            job = {
                "path": str(config.plist_path),
                "program": MODULE.SSH_PATH,
                "arguments": [str(value) for value in expected["ProgramArguments"]],
                "pid": 4321,
            }
            with mock.patch.object(MODULE, "listener_pids", return_value=[4321]):
                self.assertTrue(MODULE.check_conflicts(config, job=job))

            with mock.patch.object(MODULE, "listener_pids", return_value=[9876]):
                with self.assertRaises(MODULE.SetupError):
                    MODULE.check_conflicts(config, job=job)

            wrong_job = dict(job, path=str(root / "other.plist"))
            with mock.patch.object(MODULE, "listener_pids", return_value=[]):
                with self.assertRaisesRegex(MODULE.SetupError, "different plist"):
                    MODULE.check_conflicts(config, job=wrong_job)

    def test_symlinked_plist_and_log_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            config = self.make_config(root)

            target = root / "real-peer.plist"
            target.write_bytes(MODULE.plist_bytes(config))
            config.plist_path.parent.mkdir(parents=True)
            config.plist_path.symlink_to(target)
            with self.assertRaises(MODULE.SetupError):
                MODULE.check_conflicts(config, loaded=False)

            config.plist_path.unlink()
            real_logs = root / "real-logs"
            real_logs.mkdir()
            config.log_path.parent.symlink_to(real_logs, target_is_directory=True)
            with self.assertRaises(MODULE.SetupError):
                MODULE.ensure_log_parent(config)

    def test_custom_log_parent_is_created_only_after_install_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = self.make_config(pathlib.Path(temporary))
            self.assertFalse(config.log_path.parent.exists())
            MODULE.ensure_log_parent(config)
            self.assertTrue(config.log_path.parent.is_dir())
            self.assertEqual(
                stat.S_IMODE(config.log_path.parent.stat().st_mode) & 0o777,
                0o700,
            )

    def test_dry_run_prints_plan_without_writing_or_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            plist_path = root / "LaunchAgents" / "peer.plist"
            log_path = root / "Logs" / "peer.log"
            output = io.StringIO()
            with (
                mock.patch.object(MODULE, "launchd_job_snapshot", return_value=None),
                mock.patch.object(MODULE, "listener_pids", return_value=[]),
                mock.patch.object(MODULE.sys, "platform", "darwin"),
                contextlib.redirect_stdout(output),
            ):
                result = MODULE.main(
                    [
                        "--dry-run",
                        "--ssh-alias",
                        "wanda-codex",
                        "--local-port",
                        "13773",
                        "--remote-port",
                        "3773",
                        "--plist-path",
                        str(plist_path),
                        "--log-path",
                        str(log_path),
                    ]
                )

            self.assertEqual(result, 0)
            self.assertIn("127.0.0.1:13773 -> peer 127.0.0.1:3773", output.getvalue())
            self.assertFalse(plist_path.exists())
            self.assertFalse(log_path.exists())


if __name__ == "__main__":
    unittest.main()
