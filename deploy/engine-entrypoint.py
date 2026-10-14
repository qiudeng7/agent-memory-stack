#!/usr/bin/env python3
"""Standalone Linux/Python 3.11 model bootstrap; no repository imports."""
import contextlib
import fcntl
import hashlib
import hmac
import os
import re
import signal
import stat
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass


class PreparationError(Exception):
    """Safe, non-secret bootstrap failure."""


@dataclass(frozen=True)
class ModelSpec:
    filename: str = "Qwen3-Embedding-0.6B-Q8_0.gguf"
    revision: str = "370f27d7550e0def9b39c1f16d3fbaa13aa67728"
    size: int = 639150592
    sha256: str = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"

    @property
    def url(self):
        return f"https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/{self.revision}/{self.filename}"


MODEL = ModelSpec()
CHUNK = 1024 * 1024


def require_https(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise PreparationError("download requires HTTPS")


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require_https(newurl)
        # Never propagate caller headers, credentials, cookies or environment keys.
        return super().redirect_request(
            urllib.request.Request(req.full_url), fp, code, msg, headers, newurl
        )


def download_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), HTTPSRedirect())


def derive_engine_key(master):
    if not isinstance(master, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", master):
        raise PreparationError("AMS_MASTER_KEY must be 64 hexadecimal characters")
    return hmac.new(master.encode("utf-8"), b"agent-memory-stack/v1/embedding-engine", hashlib.sha256).hexdigest()


def open_directory(path):
    """Walk using dirfds: refuse symlinks even in ancestors, without resolve()."""
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise PreparationError("model directory must be an absolute canonical path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split("/")[1:]:
            if not part:
                continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(st):
    return st.st_dev, st.st_ino


def verify_file(directory_fd, name, spec):
    try:
        candidate = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(candidate.st_mode) or candidate.st_size != spec.size:
        raise PreparationError("model file has invalid type or size")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != spec.size:
            raise PreparationError("model file has invalid type or size")
        digest = hashlib.sha256()
        remaining = spec.size
        while remaining:
            block = stream.read(min(CHUNK, remaining))
            if not block:
                raise PreparationError("model file is incomplete")
            digest.update(block)
            remaining -= len(block)
        after = os.fstat(stream.fileno())
        if stream.read(1) or digest.hexdigest() != spec.sha256 or (
            before.st_mtime_ns, before.st_ctime_ns, before.st_size
        ) != (after.st_mtime_ns, after.st_ctime_ns, after.st_size):
            raise PreparationError("model checksum verification failed")
        if identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)) != identity(before):
            raise PreparationError("model changed during verification")
    return True


@contextlib.contextmanager
def download_deadline(seconds):
    # Socket timeouts alone do not bound a slow-drip response or redirect chain.
    def expired(signum, frame):
        raise PreparationError("model download deadline exceeded")
    previous = signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)


def remove_owned_temp(directory_fd, absolute_path, expected):
    # Only unlink our mkstemp inode, through the originally opened directory.
    if not os.path.isabs(absolute_path) or not os.path.basename(absolute_path).startswith(".ams-download-"):
        raise PreparationError("unsafe temporary path")
    name = os.path.basename(absolute_path)
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(current.st_mode) or identity(current) != expected:
        raise PreparationError("temporary file changed; refusing cleanup")
    os.unlink(name, dir_fd=directory_fd)


def prepare_model(directory="/models", spec=MODEL, *, opener=None, timeout=30.0, deadline=1800.0):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", spec.filename) or spec.filename in (".", "..") or spec.size <= 0:
        raise PreparationError("invalid model specification")
    if timeout <= 0 or deadline <= 0:
        raise PreparationError("invalid download time limit")
    with contextlib.ExitStack() as stack:
        directory_fd = open_directory(directory)
        stack.callback(os.close, directory_fd)
        lock_fd = os.open(".ams-model.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory_fd)
        stack.callback(os.close, lock_fd)
        lock_stat = os.fstat(lock_fd)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
            raise PreparationError("invalid model lock")
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        if identity(os.stat(".ams-model.lock", dir_fd=directory_fd, follow_symlinks=False)) != identity(lock_stat):
            raise PreparationError("model lock changed")
        if verify_file(directory_fd, spec.filename, spec):
            print("Model verified; reusing cached model.", flush=True)
            return os.path.join(directory, spec.filename)
        # mkstemp is required to create only a private, uniquely owned temp file.
        check_fd = open_directory(directory)
        try:
            if identity(os.fstat(check_fd)) != identity(os.fstat(directory_fd)):
                raise PreparationError("model directory changed")
        finally:
            os.close(check_fd)
        fd, temporary = tempfile.mkstemp(prefix=".ams-download-", suffix=".tmp", dir=directory)
        owned = identity(os.fstat(fd))
        try:
            if identity(os.stat(os.path.basename(temporary), dir_fd=directory_fd, follow_symlinks=False)) != owned:
                raise PreparationError("model directory changed")
            with os.fdopen(fd, "wb") as output:
                fd = -1
                require_https(spec.url)
                print("Preparing model download.", flush=True)
                with download_deadline(deadline):
                    started = time.monotonic()
                    request = urllib.request.Request(spec.url, headers={})
                    with (opener or download_opener()).open(request, timeout=min(timeout, deadline)) as response:
                        require_https(response.geturl())
                        if response.status != 200:
                            raise PreparationError("unexpected model download status")
                        length = response.headers.get("Content-Length")
                        if length is not None and (not length.isdecimal() or int(length) != spec.size):
                            raise PreparationError("unexpected model download size")
                        total = 0
                        while True:
                            if time.monotonic() - started >= deadline:
                                raise PreparationError("model download deadline exceeded")
                            block = response.read(min(CHUNK, spec.size - total + 1))
                            if not block:
                                break
                            total += len(block)
                            if total > spec.size:
                                raise PreparationError("model download exceeds size limit")
                            output.write(block)
                        if total != spec.size:
                            raise PreparationError("model download is incomplete")
                    output.flush()
                    os.fsync(output.fileno())
            verify_file(directory_fd, os.path.basename(temporary), spec)
            # link is an atomic no-clobber publication: even an unexpected writer
            # cannot make us overwrite user data. Temp and destination share a FS.
            os.link(os.path.basename(temporary), spec.filename, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
            published = os.stat(spec.filename, dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISREG(published.st_mode) or identity(published) != owned:
                raise PreparationError("model changed during publication")
            os.fsync(directory_fd)
            print("Model prepared and verified.", flush=True)
            return os.path.join(directory, spec.filename)
        finally:
            if fd >= 0:
                os.close(fd)
            remove_owned_temp(directory_fd, temporary, owned)


def engine_command_and_env(model_path, source_env):
    key = derive_engine_key(source_env.get("AMS_MASTER_KEY"))
    layers = source_env.get("EMBEDDING_GPU_LAYERS", "999")
    if not re.fullmatch(r"[0-9]{1,3}", layers):
        raise PreparationError("EMBEDDING_GPU_LAYERS must be an integer from 0 to 999")
    layers = int(layers)
    port = source_env.get("ENGINE_PORT", "8080")
    if not re.fullmatch(r"[0-9]{4,5}", port) or not 1024 <= int(port) <= 65535:
        raise PreparationError("ENGINE_PORT must be an integer from 1024 to 65535")
    bind = source_env.get("ENGINE_BIND", "0.0.0.0")
    if bind not in ("127.0.0.1", "localhost", "0.0.0.0"):
        raise PreparationError("ENGINE_BIND must be a local bind address")
    # Strict allowlist: no master key, service credentials, proxy/auth env, or
    # LLAMA_* overrides reach the engine. Runtime discovery variables are local.
    env = {name: source_env[name] for name in (
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "VK_ICD_FILENAMES",
        "VK_DRIVER_FILES", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"
    ) if name in source_env}
    env.update(LLAMA_API_KEY=key, LD_LIBRARY_PATH="/opt/runtime", GGML_BACKEND_PATH=(
        "/opt/runtime/libggml-cpu-haswell.so" if layers == 0 else "/opt/runtime/libggml-vulkan.so"
    ))
    command = ["/opt/runtime/ld-linux-x86-64.so.2", "--library-path", "/opt/runtime", "/opt/runtime/llama-server",
               "-m", model_path, "--alias", "qwen3-embedding-0.6b-q8", "--embedding", "--pooling", "last",
               "--embd-normalize", "2", "--host", bind, "--port", str(int(port)), "-c", "2048", "-b", "2048",
               "-ub", "2048", "-np", "1", "-t", "4", "-tb", "4", "--flash-attn", "off", "--fit", "off",
               "--device", "none" if layers == 0 else "Vulkan0", "-ngl", str(layers), "--no-op-offload"]
    return command, env


def main():
    def cancelled(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, cancelled)
    try:
        # Reject invalid credentials/settings before any network or file writes.
        command, env = engine_command_and_env(os.path.join("/models", MODEL.filename), os.environ)
        prepare_model()
        os.execve(command[0], command, env)
    except KeyboardInterrupt:
        print("Engine startup cancelled.", file=sys.stderr)
        return 130
    except Exception:
        # Never echo exception text, redirect URLs, response bodies or env values.
        print("Engine startup failed; check model integrity, configuration and connectivity.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
