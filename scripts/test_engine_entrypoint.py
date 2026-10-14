#!/usr/bin/env python3
"""Offline entrypoint tests: only synthetic fixtures and isolated temp dirs."""
import contextlib
import hashlib
import importlib.util
import io
import multiprocessing
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest import mock

sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "engine-entrypoint.py"
MODULE_SPEC = importlib.util.spec_from_file_location("ams_engine_entrypoint", MODULE_PATH)
engine = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = engine
MODULE_SPEC.loader.exec_module(engine)

DATA = b"synthetic model fixture\x00\xff"
SPEC = engine.ModelSpec(filename="fixture.gguf", size=len(DATA), sha256=hashlib.sha256(DATA).hexdigest())
MASTER = "aB" * 32


class Response(io.BytesIO):
    def __init__(self, data=DATA, *, length=None, url="https://cdn.example/model", status=200):
        super().__init__(data)
        self.headers = {} if length is None else {"Content-Length": length}
        self.url = url
        self.status = status

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, response=None, error=None):
        self.response = response if response is not None else Response()
        self.error = error
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.model = self.directory / SPEC.filename
        self.log = io.StringIO()
        self.log_context = contextlib.redirect_stdout(self.log)
        self.log_context.__enter__()
        self.addCleanup(self.log_context.__exit__, None, None, None)

    def prepare(self, opener=None, **kwargs):
        return engine.prepare_model(str(self.directory), SPEC, opener=opener or Opener(), **kwargs)

    def assert_no_temps(self):
        self.assertEqual(list(self.directory.glob(".ams-download-*")), [])

    def test_production_pin(self):
        self.assertEqual(engine.MODEL.size, 639150592)
        self.assertEqual(engine.MODEL.sha256, "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439")
        self.assertEqual(engine.MODEL.url, "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf")

    def test_download_atomic_reuse_and_fsync(self):
        opener = Opener(Response(length=str(len(DATA))))
        original_link = os.link
        def publish(source, target, **kwargs):
            self.assertFalse(self.model.exists())
            original_link(source, target, **kwargs)
            self.assertEqual(self.model.read_bytes(), DATA)
        with mock.patch.object(engine.os, "link", side_effect=publish), mock.patch.object(engine.os, "fsync", wraps=os.fsync) as sync:
            self.assertEqual(self.prepare(opener), str(self.model))
            self.assertGreaterEqual(sync.call_count, 2)
        ino = self.model.stat().st_ino
        self.prepare(Opener(error=AssertionError("must not download")))
        self.assertEqual(self.model.stat().st_ino, ino)
        request, timeout = opener.calls[0]
        self.assertEqual(request.header_items(), [])
        self.assertEqual(timeout, 30)
        self.assert_no_temps()

    def test_existing_checksum_checked_every_start(self):
        self.prepare()
        self.model.write_bytes(b"x" * len(DATA))
        opener = Opener()
        with self.assertRaises(engine.PreparationError):
            self.prepare(opener)
        self.assertEqual(opener.calls, [])
        self.assertEqual(self.model.read_bytes(), b"x" * len(DATA))

    def test_existing_wrong_size_preserved(self):
        self.model.write_bytes(b"user data")
        with self.assertRaises(engine.PreparationError):
            self.prepare()
        self.assertEqual(self.model.read_bytes(), b"user data")

    def test_partial_oversize_checksum_and_content_length(self):
        for data, length in [(DATA[:-1], None), (DATA + b"!", None), (b"x" * len(DATA), None),
                             (DATA, "1"), (DATA, "invalid")]:
            with self.subTest(data=data, length=length), self.assertRaises(engine.PreparationError):
                self.prepare(Opener(Response(data, length=length)))
            self.assertFalse(self.model.exists())
            self.assert_no_temps()

    def test_socket_timeout_has_no_retry(self):
        opener = Opener(error=TimeoutError("https://secret.example/?token=secret"))
        with self.assertRaises(TimeoutError):
            self.prepare(opener)
        self.assertEqual(len(opener.calls), 1)
        self.assert_no_temps()
        self.assertNotIn("secret", self.log.getvalue())

    def test_slow_read_total_deadline(self):
        class SlowResponse(Response):
            def read(self, size):
                time.sleep(1)
                return super().read(size)
        with self.assertRaises(engine.PreparationError):
            self.prepare(Opener(SlowResponse()), timeout=1, deadline=0.03)
        self.assert_no_temps()

    def test_cancel_cleans_only_own_temp(self):
        unrelated = self.directory / ".ams-download-unrelated.tmp"
        unrelated.write_bytes(b"user data")
        with self.assertRaises(KeyboardInterrupt):
            self.prepare(Opener(error=KeyboardInterrupt()))
        self.assertEqual(unrelated.read_bytes(), b"user data")
        self.assertEqual(list(self.directory.glob(".ams-download-*")), [unrelated])

    def test_cleanup_refuses_changed_inode(self):
        path = self.directory / ".ams-download-fixture.tmp"
        path.write_bytes(b"original")
        owned = engine.identity(path.stat())
        # Move the original aside within our synthetic fixture to replace its name.
        moved = self.directory / "original-kept"
        path.rename(moved)
        path.write_bytes(b"replacement user data")
        directory_fd = engine.open_directory(str(self.directory))
        try:
            with self.assertRaises(engine.PreparationError):
                engine.remove_owned_temp(directory_fd, str(path), owned)
        finally:
            os.close(directory_fd)
        self.assertEqual(path.read_bytes(), b"replacement user data")
        self.assertEqual(moved.read_bytes(), b"original")

    def test_publication_never_overwrites_racing_user_file(self):
        original_link = os.link
        def race(source, target, **kwargs):
            self.model.write_bytes(b"user data")
            return original_link(source, target, **kwargs)
        with mock.patch.object(engine.os, "link", side_effect=race), self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(self.model.read_bytes(), b"user data")
        self.assert_no_temps()

    def test_symlink_model_lock_and_ancestors(self):
        target = self.directory / "target"
        target.write_bytes(DATA)
        self.model.symlink_to(target)
        with self.assertRaises(engine.PreparationError):
            self.prepare()
        self.assertEqual(target.read_bytes(), DATA)
        # Separate isolated directories; never unlink a user-provided target.
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            (base / "actual").mkdir()
            (base / "actual" / "nested").mkdir()
            (base / "alias").symlink_to(base / "actual", target_is_directory=True)
            with self.assertRaises(OSError):
                engine.prepare_model(str(base / "alias" / "nested"), SPEC, opener=Opener())
            (base / "actual" / ".ams-model.lock").symlink_to(target)
            with self.assertRaises(OSError):
                engine.prepare_model(str(base / "actual"), SPEC, opener=Opener())

    def test_fifo_rejected_without_blocking(self):
        os.mkfifo(self.model)
        with self.assertRaises(engine.PreparationError):
            self.prepare()

    def test_https_redirects_and_empty_headers(self):
        handler = engine.HTTPSRedirect()
        request = urllib.request.Request("https://huggingface.co/file", headers={"Authorization": "synthetic-secret", "X-Api-Key": "secret"})
        for url in ["http://example.com/file", "file:///tmp/a", "ftp://example.com/a", "https://user:pass@example.com/a"]:
            with self.subTest(url=url), self.assertRaises(engine.PreparationError):
                handler.redirect_request(request, None, 302, "Found", {}, url)
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://cdn.example/model?signature=fixture")
        self.assertEqual(redirected.header_items(), [])
        self.assertTrue(redirected.full_url.startswith("https://cdn.example/"))
        with self.assertRaises(engine.PreparationError):
            self.prepare(Opener(Response(url="http://cdn.example/model")))
        self.assert_no_temps()

    def test_proxy_environment_ignored(self):
        with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://secret.example:1234", "HTTP_PROXY": "http://secret.example:1234"}):
            opener = engine.download_opener()
        for handler in opener.handlers:
            if isinstance(handler, urllib.request.ProxyHandler):
                self.assertEqual(handler.proxies, {})
        self.assertTrue(any(isinstance(handler, engine.HTTPSRedirect) for handler in opener.handlers))

    def test_hmac_known_fixture_preserves_case(self):
        self.assertEqual(engine.derive_engine_key(MASTER), "fec4eb5b5424d16ec4698ca46c4b5211f8314af14805988fea11f031c7ff8c87")
        self.assertNotEqual(engine.derive_engine_key(MASTER), engine.derive_engine_key(MASTER.lower()))
        for bad in [None, "", "g" * 64, "a" * 63, "a" * 65, "a" * 64 + "\n"]:
            with self.subTest(bad=bad), self.assertRaises(engine.PreparationError):
                engine.derive_engine_key(bad)

    def test_cpu_gpu_flags_and_sanitized_env(self):
        source = {"AMS_MASTER_KEY": MASTER, "LLM_API_KEY": "secret", "LLM_ADMIN_API_KEY": "secret",
                  "EMBEDDING_API_KEY": "secret", "EMBEDDING_ADMIN_API_KEY": "secret", "OV_ROOT_API_KEY": "secret",
                  "EMBEDDING_ENGINE_API_KEY": "secret", "LLAMA_API_KEY": "secret", "HTTPS_PROXY": "secret",
                  "LD_PRELOAD": "secret", "LD_LIBRARY_PATH": "wrong", "LLAMA_ARG_CTX_SIZE": "wrong", "PATH": "/usr/bin"}
        for layers, device, backend in [("0", "none", "cpu-haswell"), ("999", "Vulkan0", "vulkan"), ("12", "Vulkan0", "vulkan")]:
            source["EMBEDDING_GPU_LAYERS"] = layers
            command, env = engine.engine_command_and_env("/models/fixture.gguf", source)
            self.assertEqual(command[:4], ["/opt/runtime/ld-linux-x86-64.so.2", "--library-path", "/opt/runtime", "/opt/runtime/llama-server"])
            self.assertEqual(command[command.index("--device") + 1], device)
            self.assertEqual(command[command.index("-ngl") + 1], layers)
            self.assertIn("--no-op-offload", command)
            for flag, value in [("--pooling", "last"), ("--embd-normalize", "2"), ("-c", "2048"), ("-b", "2048"), ("-ub", "2048"), ("-np", "1"), ("-t", "4"), ("-tb", "4"), ("--flash-attn", "off"), ("--fit", "off")]:
                self.assertEqual(command[command.index(flag) + 1], value)
            self.assertEqual(env, {"PATH": "/usr/bin", "LLAMA_API_KEY": engine.derive_engine_key(MASTER), "LD_LIBRARY_PATH": "/opt/runtime", "GGML_BACKEND_PATH": f"/opt/runtime/libggml-{backend}.so"})
            self.assertNotIn(env["LLAMA_API_KEY"], command)
            self.assertEqual(source["LD_LIBRARY_PATH"], "wrong")
        for bad in ["-1", "1000", "1.5", " 0", "vulkan", "0\n"]:
            with self.subTest(bad=bad), self.assertRaises(engine.PreparationError):
                engine.engine_command_and_env("/models/model", {"AMS_MASTER_KEY": MASTER, "EMBEDDING_GPU_LAYERS": bad})

    def test_bind_port_defaults_and_overrides(self):
        for settings, bind, port in [({}, "0.0.0.0", "8080"),
                                     ({"ENGINE_BIND": "127.0.0.1", "ENGINE_PORT": "8081"}, "127.0.0.1", "8081"),
                                     ({"ENGINE_BIND": "localhost", "ENGINE_PORT": "1024"}, "localhost", "1024"),
                                     ({"ENGINE_PORT": "65535"}, "0.0.0.0", "65535")]:
            with self.subTest(settings=settings):
                source = {"AMS_MASTER_KEY": MASTER, **settings}
                command, env = engine.engine_command_and_env("/models/fixture.gguf", source)
                self.assertEqual(command[command.index("--host") + 1], bind)
                self.assertEqual(command[command.index("--port") + 1], port)
                self.assertNotIn("ENGINE_BIND", env)
                self.assertNotIn("ENGINE_PORT", env)
                self.assertNotIn("AMS_MASTER_KEY", env)

    def test_bad_bind_port_rejected_before_download(self):
        invalid = [{"ENGINE_PORT": value} for value in
                   ["", "0", "80", "1023", "65536", "-8080", "8081\n", " 8081", "1e4", "http://secret.example"]]
        invalid += [{"ENGINE_BIND": value} for value in
                    ["", "::1", "192.168.1.1", "example.com", "127.0.0.1\n", "http://secret.example"]]
        for settings in invalid:
            with self.subTest(settings=settings), mock.patch.dict(os.environ, {"AMS_MASTER_KEY": MASTER, **settings}, clear=True), mock.patch.object(engine, "prepare_model") as prepare, mock.patch.object(engine.os, "execve") as execute, mock.patch.object(engine.signal, "signal"), contextlib.redirect_stderr(io.StringIO()) as log:
                self.assertEqual(engine.main(), 1)
                prepare.assert_not_called()
                execute.assert_not_called()
                self.assertNotIn("secret", log.getvalue())
                self.assertNotIn(MASTER, log.getvalue())

    def test_main_error_redaction_and_no_python_ld_mutation(self):
        stderr = io.StringIO()
        before = os.environ.get("LD_LIBRARY_PATH")
        with mock.patch.dict(os.environ, {"AMS_MASTER_KEY": MASTER}), mock.patch.object(engine, "prepare_model", side_effect=RuntimeError("secret URL token response body")), mock.patch.object(engine.signal, "signal"), contextlib.redirect_stderr(stderr):
            self.assertEqual(engine.main(), 1)
        self.assertNotIn("secret", stderr.getvalue())
        self.assertNotIn(MASTER, stderr.getvalue())
        self.assertEqual(os.environ.get("LD_LIBRARY_PATH"), before)

    def test_main_exec_environment(self):
        with mock.patch.dict(os.environ, {"AMS_MASTER_KEY": MASTER}), mock.patch.object(engine, "prepare_model"), mock.patch.object(engine.signal, "signal"), mock.patch.object(engine.os, "execve") as execute:
            engine.main()
        program, command, env = execute.call_args.args
        self.assertEqual(program, command[0])
        self.assertNotIn("AMS_MASTER_KEY", env)
        self.assertEqual(env["LLAMA_API_KEY"], engine.derive_engine_key(MASTER))

    def test_flock_two_processes_download_once(self):
        ctx = multiprocessing.get_context("fork")
        count = ctx.Value("i", 0)
        class CountingOpener(Opener):
            def open(self, request, timeout):
                with count.get_lock():
                    count.value += 1
                time.sleep(0.05)
                return super().open(request, timeout)
        def worker():
            engine.prepare_model(str(self.directory), SPEC, opener=CountingOpener())
        processes = [ctx.Process(target=worker) for _ in range(2)]
        try:
            for process in processes:
                process.start()
            for process in processes:
                process.join(5)
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(5)
        self.assertEqual(count.value, 1)
        self.assertEqual(self.model.read_bytes(), DATA)
        self.assert_no_temps()


if __name__ == "__main__":
    unittest.main(verbosity=2)
