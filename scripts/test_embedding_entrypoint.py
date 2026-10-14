#!/usr/bin/env python3
"""Offline PID 1 tests: fake children/clock; no downloads, services or GPU."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "embedding-entrypoint.py"
MODULE_SPEC = importlib.util.spec_from_file_location("ams_embedding_entrypoint", MODULE_PATH)
supervisor = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(supervisor)


class Clock:
    def __init__(self):
        self.now = 0.0
        self.on_sleep = None

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.on_sleep:
            self.on_sleep()


class Child:
    def __init__(self, name, clock, events, *, exit_code=None, terminate_exits=True, kill_exits=True):
        self.name = name
        self.clock = clock
        self.events = events
        self.returncode = exit_code
        self.terminate_exits = terminate_exits
        self.kill_exits = kill_exits
        self.wait_timeouts = []

    def poll(self):
        return self.returncode

    def terminate(self):
        self.events.append((self.name, "terminate"))
        if self.terminate_exits:
            self.returncode = -signal.SIGTERM

    def kill(self):
        self.events.append((self.name, "kill"))
        if self.kill_exits:
            self.returncode = -signal.SIGKILL

    def wait(self, timeout):
        self.events.append((self.name, "wait"))
        self.wait_timeouts.append(timeout)
        if self.returncode is None:
            self.clock.now += timeout
            raise subprocess.TimeoutExpired("synthetic-child", timeout)
        return self.returncode


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.events = []
        self.engine = Child("engine", self.clock, self.events)
        self.gateway = Child("gateway", self.clock, self.events)
        self.calls = []
        self.original_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        # Defensive test cleanup even if a handler-restoration assertion fails.
        self.addCleanup(self.restore_handlers)

    def restore_handlers(self):
        for sig, handler in self.original_handlers.items():
            signal.signal(sig, handler)

    def fake_popen(self, command, *, env):
        self.calls.append((command, env))
        return (self.engine, self.gateway)[len(self.calls) - 1]

    def request_signal(self, sig=signal.SIGTERM):
        # Call the installed handler synthetically; never signal a real process.
        signal.getsignal(sig)(sig, None)

    def run_main(self, popen=None):
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {
            "AMS_MASTER_KEY": "aB" * 32,
            "ENGINE_PORT": "65535", "ENGINE_BIND": "0.0.0.0",
            "EMBEDDING_ENGINE_URL": "https://synthetic-secret.example/prompt",
        }, clear=True), mock.patch.object(supervisor.subprocess, "Popen", side_effect=popen or self.fake_popen), mock.patch.object(supervisor.time, "monotonic", self.clock.monotonic), mock.patch.object(supervisor.time, "sleep", self.clock.sleep), contextlib.redirect_stderr(stderr):
            result = supervisor.main()
        for sig, handler in self.original_handlers.items():
            self.assertEqual(signal.getsignal(sig), handler)
        self.assertNotIn("synthetic-secret", stderr.getvalue())
        self.assertNotIn("prompt", stderr.getvalue())
        self.assertNotIn("aB" * 32, stderr.getvalue())
        return result, stderr.getvalue()

    def test_normal_sigterm_and_fixed_local_engine(self):
        self.clock.on_sleep = self.request_signal
        result, log = self.run_main()
        self.assertEqual(result, 0)
        self.assertEqual(log, "")
        self.assertEqual(len(self.calls), 2)
        engine_command, engine_env = self.calls[0]
        gateway_command, gateway_env = self.calls[1]
        self.assertEqual(engine_command, [sys.executable, "/stack/engine-entrypoint.py"])
        self.assertEqual(engine_env["ENGINE_PORT"], "8081")
        self.assertEqual(engine_env["ENGINE_BIND"], "127.0.0.1")
        self.assertEqual(gateway_env["EMBEDDING_ENGINE_URL"], "http://127.0.0.1:8081")
        self.assertEqual(gateway_command, [sys.executable, "-m", *supervisor.GATEWAY_ARGS])
        for flag, value in [("--host", "0.0.0.0"), ("--port", "8080"), ("--workers", "1")]:
            self.assertEqual(gateway_command[gateway_command.index(flag) + 1], value)
        self.assertIn("--no-access-log", gateway_command)
        self.assertEqual(self.events[:2], [("engine", "terminate"), ("gateway", "terminate")])
        self.assertFalse(any(action == "kill" for _, action in self.events))
        self.assertIsNotNone(self.engine.returncode)
        self.assertIsNotNone(self.gateway.returncode)

    def test_normal_sigint_stops_both(self):
        self.clock.on_sleep = lambda: self.request_signal(signal.SIGINT)
        self.assertEqual(self.run_main()[0], 0)
        self.assertIn(("engine", "terminate"), self.events)
        self.assertIn(("gateway", "terminate"), self.events)

    def test_unexpected_zero_or_nonzero_exit_stops_peer(self):
        for exited_name in ("engine", "gateway"):
            for exit_code in (0, 7, -signal.SIGKILL):
                with self.subTest(child=exited_name, exit_code=exit_code):
                    self.calls.clear()
                    self.events.clear()
                    self.engine.returncode = self.gateway.returncode = None
                    exited = self.engine if exited_name == "engine" else self.gateway
                    peer = self.gateway if exited_name == "engine" else self.engine
                    exited.returncode = exit_code
                    result, log = self.run_main()
                    self.assertEqual(result, 1)
                    self.assertIn("unexpectedly", log)
                    self.assertIn((peer.name, "terminate"), self.events)
                    self.assertNotIn((exited.name, "terminate"), self.events)
                    self.assertIsNotNone(peer.returncode)
                    self.assertIn((exited.name, "wait"), self.events)

    def test_missing_gateway_startup_cleans_started_engine(self):
        def start(command, *, env):
            if self.calls:
                raise FileNotFoundError("synthetic-secret prompt URL")
            return self.fake_popen(command, env=env)
        result, log = self.run_main(start)
        self.assertEqual(result, 1)
        self.assertIn("failed", log)
        self.assertEqual(len(self.calls), 1)
        self.assertIn(("engine", "terminate"), self.events)
        self.assertIn(("engine", "wait"), self.events)
        self.assertFalse(any(name == "gateway" for name, _ in self.events))

    def test_missing_engine_startup_has_no_children_to_cleanup(self):
        def fail(command, *, env):
            raise FileNotFoundError("synthetic-secret prompt URL")
        self.assertEqual(self.run_main(fail)[0], 1)
        self.assertEqual(self.events, [])

    def test_signal_during_first_start_does_not_start_gateway(self):
        def start(command, *, env):
            child = self.fake_popen(command, env=env)
            self.request_signal()
            return child
        self.assertEqual(self.run_main(start)[0], 0)
        self.assertEqual(len(self.calls), 1)
        self.assertIn(("engine", "terminate"), self.events)

    def test_force_kill_all_remaining_after_shared_eight_seconds(self):
        self.engine.terminate_exits = self.gateway.terminate_exits = False
        self.clock.on_sleep = self.request_signal
        self.assertEqual(self.run_main()[0], 0)
        self.assertAlmostEqual(self.clock.now, supervisor.POLL_INTERVAL + 8.0)
        self.assertEqual(self.events[:2], [("engine", "terminate"), ("gateway", "terminate")])
        first_kill = self.events.index(("engine", "kill"))
        self.assertEqual(self.events[first_kill:first_kill + 2], [("engine", "kill"), ("gateway", "kill")])
        self.assertEqual(self.engine.returncode, -signal.SIGKILL)
        self.assertEqual(self.gateway.returncode, -signal.SIGKILL)
        self.assertEqual(self.engine.wait_timeouts[0], 8.0)
        self.assertEqual(self.gateway.wait_timeouts[0], 0.0)

    def test_kill_wait_is_bounded_even_for_unreapable_children(self):
        self.engine.terminate_exits = self.gateway.terminate_exits = False
        self.engine.kill_exits = self.gateway.kill_exits = False
        self.clock.on_sleep = self.request_signal
        self.assertEqual(self.run_main()[0], 0)
        self.assertAlmostEqual(self.clock.now, supervisor.POLL_INTERVAL + 10.0)
        self.assertIn(("engine", "kill"), self.events)
        self.assertIn(("gateway", "kill"), self.events)
        self.assertEqual(self.engine.wait_timeouts[-1], 2.0)
        self.assertEqual(self.gateway.wait_timeouts[-1], 0.0)

    def test_startup_failure_force_kills_previously_started_engine(self):
        self.engine.terminate_exits = False
        def start(command, *, env):
            if self.calls:
                raise OSError("synthetic-secret prompt URL")
            return self.fake_popen(command, env=env)
        self.assertEqual(self.run_main(start)[0], 1)
        self.assertIn(("engine", "kill"), self.events)
        self.assertAlmostEqual(self.clock.now, 8.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
