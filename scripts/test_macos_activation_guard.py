"""Synthetic tests only. No real database, socket, process, or deployment."""
import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("guard", pathlib.Path(__file__).with_name("macos-activation-guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.db = self.root / "state.sqlite"
        with sqlite3.connect(self.db) as db:
            db.executescript("""
                CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,adapter_key TEXT,status TEXT,resume_cursor_json TEXT);
                CREATE TABLE projection_thread_sessions(thread_id TEXT,status TEXT,active_turn_id TEXT);
                CREATE TABLE projection_pending_approvals(request_id TEXT,thread_id TEXT,status TEXT);
                CREATE TABLE projection_threads(thread_id TEXT,pending_user_input_count INTEGER,latest_turn_id TEXT,deleted_at TEXT);
                CREATE TABLE projection_thread_messages(thread_id TEXT,role TEXT,is_streaming INTEGER,turn_id TEXT);
                CREATE TABLE projection_thread_activities(activity_id TEXT,thread_id TEXT,kind TEXT,payload_json TEXT);
                INSERT INTO provider_session_runtime VALUES('t3','codex','codex','running','{"threadId":"native"}');
                INSERT INTO projection_thread_sessions VALUES('t3','ready',NULL);
                INSERT INTO projection_pending_approvals VALUES('approval','t3','pending');
                INSERT INTO projection_threads VALUES('t3',1,'last',NULL);
                INSERT INTO projection_threads VALUES('t4',2,'last2',NULL);
                INSERT INTO projection_thread_activities VALUES('1','t3','user-input.requested','{}');
                INSERT INTO projection_thread_activities VALUES('2','t3','user-input.resolved','{}');
                INSERT INTO projection_thread_activities VALUES('3','t3','user-input.requested','{}');
                INSERT INTO projection_thread_activities VALUES('4','t4','user-input.requested','{}');
                INSERT INTO projection_thread_activities VALUES('5','t4','user-input.resolved','{}');
                INSERT INTO projection_thread_activities VALUES('6','t4','user-input.requested','{}');
            """)
        self.m = {"baseline_file": str(self.root / "baseline.json"), "database": str(self.db),
                  "_manifest_sha256": "fresh", "environment_id": "synthetic"}
        self.native = {"idle": True, "bindings_checked": 1, "fingerprint": "idle"}

    def tearDown(self):
        self.temp.cleanup()

    def sql(self, sql):
        with sqlite3.connect(self.db) as db:
            db.execute(sql)

    def safe(self):
        return patch.multiple(guard, check_pins=lambda m: None, native_snapshot=lambda m, bindings: self.native)

    def test_idle_preserves_millie_pending_requests_and_gate_has_no_writes(self):
        with self.safe():
            state = guard.admit(self.m, capture=True)
            baseline = pathlib.Path(self.m["baseline_file"])
            before = baseline.stat()
            self.assertEqual(state["state"]["pending"]["approvals_count"], 1)
            self.assertEqual(state["state"]["pending"]["input_threads_count"], 2)
            self.assertEqual(state["state"]["pending"]["input_events_count"], 6)
            guard.admit(self.m)
            self.assertEqual(before.st_mtime_ns, baseline.stat().st_mtime_ns)
            with self.assertRaises(guard.Hold):
                guard.admit(self.m, capture=True)

    def test_active_elora_native_turn_cannot_capture(self):
        with patch.object(guard, "check_pins"), patch.object(guard, "native_snapshot", side_effect=guard.Busy("active native turn")):
            with self.assertRaises(guard.Busy):
                guard.admit(self.m, capture=True)
        self.assertFalse(pathlib.Path(self.m["baseline_file"]).exists())

    def test_pending_change_between_idle_capture_observations(self):
        observations = [self.native, self.native]
        def native(m, bindings):
            if len(observations) == 1:
                self.sql("UPDATE projection_pending_approvals SET status='resolved'")
            return observations.pop()
        with patch.object(guard, "check_pins"), patch.object(guard, "native_snapshot", side_effect=native):
            with self.assertRaises(guard.Hold):
                guard.admit(self.m, capture=True)
        self.assertFalse(pathlib.Path(self.m["baseline_file"]).exists())

    def test_pending_payload_change_after_capture_holds(self):
        with self.safe():
            guard.admit(self.m, capture=True)
            self.sql("UPDATE projection_thread_activities SET payload_json='changed' WHERE activity_id='4'")
            with self.assertRaises(guard.Hold):
                guard.admit(self.m)

    def test_native_union_change_between_capture_observations_holds(self):
        changed = {**self.native, "fingerprint": "loaded-union-changed"}
        with patch.object(guard, "check_pins"), patch.object(guard, "native_snapshot", side_effect=[self.native, changed]):
            with self.assertRaisesRegex(guard.Hold, "idle observations changed"):
                guard.admit(self.m, capture=True)
        self.assertFalse(pathlib.Path(self.m["baseline_file"]).exists())

    def test_native_union_change_after_capture_holds_gate(self):
        with self.safe():
            guard.admit(self.m, capture=True)
            self.native = {**self.native, "fingerprint": "loaded-union-changed"}
            with self.assertRaisesRegex(guard.Hold, "native state changed"):
                guard.admit(self.m)

    def test_process_change_and_shutdown_refuse_before_native_probe(self):
        for reason in ("exact process changed", "process shut down"):
            with patch.object(guard, "check_pins", side_effect=guard.Hold(reason)), patch.object(guard, "native_snapshot") as native:
                with self.assertRaises(guard.Hold):
                    guard.admit(self.m, capture=True)
                native.assert_not_called()

    def test_mapping_unknown_holds(self):
        self.sql("UPDATE provider_session_runtime SET resume_cursor_json='{}'")
        with self.assertRaises(guard.Hold):
            guard.database_snapshot(str(self.db))

    def test_projection_running_streaming_and_unknown_hold(self):
        for sql in (
            "UPDATE projection_thread_sessions SET active_turn_id='active'",
            "INSERT INTO projection_thread_messages VALUES('t3','assistant',1,'last')",
            "UPDATE provider_session_runtime SET status='unrecognized'",
        ):
            with self.subTest(sql=sql):
                with sqlite3.connect(self.db) as db:
                    db.execute("SAVEPOINT fixture")
                    db.execute(sql)
                    db.commit()
                with self.assertRaises(guard.Hold):
                    guard.database_snapshot(str(self.db))
                self.sql("UPDATE projection_thread_sessions SET active_turn_id=NULL")
                self.sql("DELETE FROM projection_thread_messages")
                self.sql("UPDATE provider_session_runtime SET status='running'")

    def test_ready_provider_is_not_itself_an_active_turn(self):
        state = guard.database_snapshot(str(self.db))
        self.assertEqual(state["bindings"], [{"thread_id": "t3", "native_id": "native"}])

    def test_finite_wait_expires_and_does_not_retry_identity_failure(self):
        now = [0]
        def pause(seconds):
            now[0] += seconds
        with patch.object(guard, "admit", side_effect=guard.Busy("active")) as admission:
            with self.assertRaisesRegex(guard.Hold, "expired"):
                guard.finite_wait(self.m, 20, clock=lambda: now[0], pause=pause)
            self.assertEqual(admission.call_count, 3)
        with patch.object(guard, "admit", side_effect=guard.Hold("process changed")) as admission:
            with self.assertRaisesRegex(guard.Hold, "process changed"):
                guard.finite_wait(self.m, 20, clock=lambda: 0, pause=pause)
            self.assertEqual(admission.call_count, 1)

    def test_finite_wait_returns_after_one_successful_capture(self):
        with patch.object(guard, "admit", side_effect=[guard.Busy("active"), {"ok": True}]) as admission:
            self.assertEqual(guard.finite_wait(self.m, 20, pause=lambda seconds: None), {"ok": True})
            self.assertEqual(admission.call_count, 2)


if __name__ == "__main__":
    unittest.main()
