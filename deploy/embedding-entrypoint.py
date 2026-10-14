#!/usr/bin/env python3
"""Stdlib-only PID 1 supervising the gateway and its private native engine."""
import os
import signal
import subprocess
import sys
import time


GATEWAY_ARGS = (
    "uvicorn", "ams_embedding.app:app_factory", "--factory", "--host", "0.0.0.0",
    "--port", "8080", "--workers", "1", "--no-access-log", "--log-level", "warning",
)
TERMINATE_TIMEOUT = 8.0
KILL_TIMEOUT = 2.0
POLL_INTERVAL = 0.1


def stop_children(children):
    """Signal every live child before a shared, bounded grace period and reap."""
    for child in children:
        if child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + TERMINATE_TIMEOUT
    for child in children:
        try:
            child.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    # Kill ALL remaining children before waiting on any one of them.
    for child in children:
        if child.poll() is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + KILL_TIMEOUT
    for child in children:
        try:
            child.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            # A stuck kernel task must not make PID 1 hang indefinitely.
            pass


def main(gateway_args=GATEWAY_ARGS):
    children = []
    previous_handlers = {}
    stopping = False

    def request_stop(signum, frame):
        nonlocal stopping
        stopping = True

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, request_stop)
        engine_env = dict(os.environ)
        engine_env.update(ENGINE_PORT="8081", ENGINE_BIND="127.0.0.1")
        gateway_env = dict(os.environ)
        # Never use Compose DNS or an externally supplied engine URL.
        gateway_env["EMBEDDING_ENGINE_URL"] = "http://127.0.0.1:8081"
        children.append(subprocess.Popen(
            [sys.executable, "/stack/engine-entrypoint.py"], env=engine_env,
        ))
        if stopping:
            return 0
        children.append(subprocess.Popen(
            [sys.executable, "-m", *gateway_args], env=gateway_env,
        ))
        while not stopping:
            if any(child.poll() is not None for child in children):
                # Even exit 0 is unexpected: never leave a silent orphan service.
                print("Embedding child exited unexpectedly; stopping service.", file=sys.stderr, flush=True)
                return 1
            time.sleep(POLL_INTERVAL)
        return 0
    except Exception:
        # No exception text, argv, environment, URLs or request content in logs.
        print("Embedding service startup or supervision failed.", file=sys.stderr, flush=True)
        return 1
    finally:
        try:
            stop_children(children)
        finally:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)


if __name__ == "__main__":
    sys.exit(main(tuple(sys.argv[1:]) or GATEWAY_ARGS))
