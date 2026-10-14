import asyncio
import json
from types import MappingProxyType

import httpx
import pytest
from pydantic import ValidationError

from ams_embedding.backend import LlamaHttpBackend
from ams_embedding.config import EmbeddingError, Settings, read_secret_file
from ams_embedding.service import EmbeddingService
from test_service import ADMIN_KEY, DATA_KEY, FIXTURE_PROFILE, request, assert_code


ENGINE_KEY = "synthetic-engine-key-0003-0123456789abcdef"


def settings(**extra):
    return Settings(engine_url="http://trusted-engine.invalid", data_key=DATA_KEY, admin_key=ADMIN_KEY, engine_key=ENGINE_KEY, **extra)


def embedding_body(**extra):
    return {"model": FIXTURE_PROFILE.engine_alias, "data": [{"index": 0, "object": "embedding", "embedding": [1, 0, 0, 0]}], "usage": {"prompt_tokens": 5}, **extra}


@pytest.mark.asyncio
async def test_httpx_backend_origin_headers_add_special_indices_and_usage():
    calls = []
    def handler(req):
        calls.append(req)
        assert req.url.host == "trusted-engine.invalid"
        assert req.headers["authorization"] == f"Bearer {ENGINE_KEY}"
        if req.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if req.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": FIXTURE_PROFILE.engine_alias}]})
        body = json.loads(req.content)
        if req.url.path == "/tokenize":
            assert body == {"content": "Instruct: Retrieve facts.\nQuery: synthetic", "add_special": True}
            return httpx.Response(200, json={"tokens": [1, 2, 3]})
        assert req.url.path == "/v1/embeddings"
        assert body == {"model": FIXTURE_PROFILE.engine_alias, "input": ["a", "b"], "encoding_format": "float"}
        return httpx.Response(200, json={"model": FIXTURE_PROFILE.engine_alias, "data": [
            {"index": 1, "embedding": [0, 1, 0, 0]}, {"index": 0, "embedding": [1, 0, 0, 0]},
        ], "usage": {"prompt_tokens": 6}})
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(handler))
    try:
        assert await backend.ready()
        assert await backend.tokenize("Instruct: Retrieve facts.\nQuery: synthetic") == 3
        batch = await backend.embed(["a", "b"])
        assert batch.vectors == ((1, 0, 0, 0), (0, 1, 0, 0))
        assert batch.prompt_tokens == 6
        assert len(calls) == 4
    finally:
        await backend.close()


@pytest.mark.parametrize("catalog", [{"data": []}, {"data": [{"id": "wrong"}]}, {"data": [{"id": FIXTURE_PROFILE.engine_alias}, {"id": FIXTURE_PROFILE.engine_alias}]}])
@pytest.mark.asyncio
async def test_ready_requires_unique_expected_engine_alias(catalog):
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(lambda req: httpx.Response(200, json={"status": "ok"} if req.url.path == "/health" else catalog)))
    try:
        assert await backend.ready() is False
    finally:
        await backend.close()


@pytest.mark.parametrize("tokens", [[], [True], [1.5], [-1], ["1"], None])
@pytest.mark.asyncio
async def test_tokenizer_token_ids_are_strict_and_nonempty(tokens):
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(lambda _: httpx.Response(200, json={"tokens": tokens})))
    try:
        with pytest.raises(EmbeddingError) as error:
            await backend.tokenize("synthetic")
        assert_code(error, "upstream_protocol_error", 502)
    finally:
        await backend.close()


@pytest.mark.parametrize("body", [
    embedding_body(data=[]),
    embedding_body(data=[{"index": True, "embedding": [1, 0, 0, 0]}]),
    embedding_body(data=[{"index": 1, "embedding": [1, 0, 0, 0]}]),
    embedding_body(data=[{"index": 0, "embedding": [True, 0, 0, 0]}]),
    embedding_body(data=[{"index": 0, "embedding": ["1", 0, 0, 0]}]),
    embedding_body(model="wrong-engine"),
    embedding_body(usage={"prompt_tokens": True}),
    embedding_body(usage={"prompt_tokens": -1}),
    embedding_body(usage={"prompt_tokens": 1.5}),
])
@pytest.mark.asyncio
async def test_invalid_embedding_indices_model_float_values_or_usage(body):
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    try:
        with pytest.raises(EmbeddingError):
            await backend.embed(["synthetic"])
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_duplicate_embedding_indices_rejected():
    body = embedding_body(data=[{"index": 0, "embedding": [1, 0, 0, 0]}, {"index": 0, "embedding": [1, 0, 0, 0]}])
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    try:
        with pytest.raises(EmbeddingError) as error:
            await backend.embed(["a", "b"])
        assert_code(error, "upstream_protocol_error", 502)
    finally:
        await backend.close()


@pytest.mark.parametrize("vector", [[1, 0], [2, 0, 0, 0], [0, 0, 0, 0]])
@pytest.mark.asyncio
async def test_http_service_checks_full_dimension_and_norm_without_caching(vector):
    def handler(req):
        return httpx.Response(200, json={"tokens": [1, 2, 3]} if req.url.path == "/tokenize" else embedding_body(data=[{"index": 0, "embedding": vector}]))
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(handler))
    service = EmbeddingService(FIXTURE_PROFILE, backend, settings())
    try:
        with pytest.raises(EmbeddingError) as error:
            await service.execute(request())
        assert_code(error, "invalid_vector", 502)
        assert service.cache.status()["entries"] == 0
    finally:
        await backend.close()


@pytest.mark.parametrize("response,code,status", [
    (httpx.Response(500, text="synthetic-private-body-and-key"), "embedding_backend_error", 502),
    (httpx.Response(302, headers={"location": "https://untrusted.invalid"}), "embedding_backend_error", 502),
    (httpx.Response(200, text="synthetic-private-body-and-key"), "upstream_protocol_error", 502),
    (httpx.Response(200, text='{"tokens":[1],"tokens":[2]}'), "upstream_protocol_error", 502),
    (httpx.Response(200, text='{"tokens":[NaN]}'), "upstream_protocol_error", 502),
])
@pytest.mark.asyncio
async def test_upstream_status_redirect_malformed_duplicate_nonfinite_do_not_leak(response, code, status, caplog):
    calls = []
    def handler(req):
        calls.append(req)
        return response
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(handler))
    try:
        with pytest.raises(EmbeddingError) as error:
            await backend.tokenize("synthetic")
        assert_code(error, code, status)
        assert len(calls) == 1
        assert "synthetic-private" not in str(error.value) + caplog.text
        assert ENGINE_KEY not in str(error.value) + caplog.text
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_upstream_size_limit_and_network_timeout_are_safe():
    backend = LlamaHttpBackend(settings(upstream_limit_bytes=1024), FIXTURE_PROFILE, httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" * 1025)))
    try:
        with pytest.raises(EmbeddingError) as error:
            await backend.tokenize("synthetic")
        assert_code(error, "upstream_protocol_error", 502)
    finally:
        await backend.close()
    for cls, code, status in [(httpx.ReadTimeout, "embedding_backend_timeout", 504), (httpx.ConnectError, "embedding_backend_unavailable", 503)]:
        def handler(req):
            raise cls("synthetic-private-body-and-key", request=req)
        backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(handler))
        try:
            with pytest.raises(EmbeddingError) as error:
                await backend.tokenize("synthetic")
            assert_code(error, code, status)
            assert "synthetic-private" not in str(error.value)
        finally:
            await backend.close()


@pytest.mark.asyncio
async def test_httpx_inflight_cancel_propagates_without_cache():
    entered, blocked = asyncio.Event(), asyncio.Event()
    cancelled = False
    async def handler(req):
        nonlocal cancelled
        if req.url.path == "/tokenize":
            return httpx.Response(200, json={"tokens": [1, 2, 3]})
        entered.set()
        try:
            await blocked.wait()
        except asyncio.CancelledError:
            cancelled = True
            raise
        return httpx.Response(200, json=embedding_body())
    backend = LlamaHttpBackend(settings(), FIXTURE_PROFILE, httpx.MockTransport(handler))
    service = EmbeddingService(FIXTURE_PROFILE, backend, settings())
    try:
        task = asyncio.create_task(service.execute(request()))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled
        assert service.cache.status()["entries"] == 0
    finally:
        await backend.close()


@pytest.mark.parametrize("url", ["file:///tmp/local", "http://user:pass@host", "https://host/path", "https://host/?a=b", "https://host/#fragment", "http://host:invalid", "http://host\n"])
def test_trusted_origin_has_no_request_controlled_path_credentials_or_query(url):
    with pytest.raises(ValidationError):
        Settings(engine_url=url)


def test_config_separates_data_admin_keys_and_invalid_settings_are_sanitized():
    with pytest.raises(ValidationError):
        Settings(data_key=DATA_KEY, admin_key=DATA_KEY)
    with pytest.raises(EmbeddingError) as error:
        Settings.from_env({"EMBEDDING_CACHE_MIB": "synthetic-private-key"})
    assert_code(error, "configuration_error", 500)
    assert "synthetic-private" not in str(error.value)
    assert DATA_KEY not in repr(settings()) and ENGINE_KEY not in repr(settings())


@pytest.mark.parametrize("key", ["short-key", "x" * 31, "REPLACE_" + "x" * 40, "replace_" + "x" * 40, "x" * 40 + "\n"])
def test_short_template_or_control_character_keys_rejected(key):
    with pytest.raises(ValidationError):
        Settings(data_key=key)
    with pytest.raises(EmbeddingError) as error:
        Settings.from_env({"EMBEDDING_API_KEY": key})
    assert_code(error, "configuration_error", 500)


# Independently computed once with Python hmac/hashlib, shared v1 UTF-8 protocol.
@pytest.mark.parametrize("master,expected", [
    ("a" * 64, (
        "8f07c3c33a61ca2290fc2431e17f7e683824308e50128d54a7eee607e88cba6b",
        "f3fb8cd8d02ce672917083ba16117926f6f30a82d2263c50a13ebec7be97c20e",
        "f977cf434cd8e19aff89893ecb13d7a39d963866ad3ae4d566672613bc2382b1")),
    ("A" * 64, (
        "89304d906e571cc6c18fef7d5cbd466bc42d29f077cb2fc7223c31c2cb06a609",
        "2460e0e705db457abda022cf56581ecfa8dabd671fc6e2072d694ca12bb603d2",
        "555684948a6a016e04f17eebbf09ab491e4ae6b1c4963be6365198848efa9ee9")),
    ("aA01" * 16, (
        "897b9a4e1ff66c624c0d3564391935877d3c3571192285f219a3b25bcc03c57c",
        "9cb7512f33af483431814898053f06aa0e703f7b7e00c8f3e9e74d7e5edac3fe",
        "c1f3a6bdf90999c249a48160ff37b71e48cd4824803e973c92592e70095afb43")),
])
def test_master_protocol_vectors_stable_distinct_case_preserving_and_env_unchanged(master, expected):
    env = MappingProxyType({"AMS_MASTER_KEY": master, "LLM_API_KEY": ""})
    before = dict(env)
    configured = Settings.from_env(env)
    actual = tuple(key.get_secret_value() for key in (configured.data_key, configured.admin_key, configured.engine_key))
    assert actual == expected
    assert len(set(actual)) == 3
    assert configured == Settings.from_env(env)
    assert dict(env) == before
    assert master not in repr(configured)
    assert all(key not in repr(configured) for key in actual)


@pytest.mark.parametrize("master", ["", "a" * 63, "a" * 65, "g" * 64, "REPLACE_" + "a" * 56,
                                    "${AMS_MASTER_KEY}", " a" * 32, "a" * 64 + "\n", "ａ" * 64])
def test_invalid_master_is_explicitly_rejected_without_leaking_or_mutating(master, caplog):
    env = MappingProxyType({"AMS_MASTER_KEY": master})
    with pytest.raises(EmbeddingError) as error:
        Settings.from_env(env)
    assert_code(error, "configuration_error", 500)
    assert "Invalid AMS_MASTER_KEY" in str(error.value)
    if master:
        assert master not in str(error.value) + caplog.text
    assert dict(env) == {"AMS_MASTER_KEY": master}


@pytest.mark.parametrize("name", ["EMBEDDING_API_KEY", "EMBEDDING_ADMIN_API_KEY", "EMBEDDING_ENGINE_API_KEY"])
@pytest.mark.parametrize("suffix", ["", "_FILE"])
@pytest.mark.parametrize("value", ["", "synthetic-private-value-not-a-real-path"])
def test_master_rejects_all_explicit_keys_and_files_even_empty_without_reading(name, suffix, value, caplog):
    env = MappingProxyType({"AMS_MASTER_KEY": "a" * 64, name + suffix: value})
    before = dict(env)
    with pytest.raises(EmbeddingError) as error:
        Settings.from_env(env)
    assert_code(error, "configuration_error", 500)
    assert "cannot be combined" in str(error.value)
    assert env["AMS_MASTER_KEY"] not in str(error.value) + caplog.text
    if value:
        assert value not in str(error.value) + caplog.text
    assert dict(env) == before


def test_missing_master_retains_all_legacy_keys_and_files_without_mutating(tmp_path):
    names = ("EMBEDDING_API_KEY", "EMBEDDING_ADMIN_API_KEY", "EMBEDDING_ENGINE_API_KEY")
    expected = (DATA_KEY, ADMIN_KEY, ENGINE_KEY)
    for use_files in (False, True):
        values = {}
        for name, key in zip(names, expected):
            if use_files:
                path = tmp_path / name
                path.write_text(key + "\n", encoding="ascii")
                path.chmod(0o600)
                values[name + "_FILE"] = str(path)
            else:
                values[name] = key
        env = MappingProxyType(values)
        before = dict(env)
        configured = Settings.from_env(env)
        assert tuple(key.get_secret_value() for key in (configured.data_key, configured.admin_key, configured.engine_key)) == expected
        assert dict(env) == before
    empty = Settings.from_env({})
    assert (empty.data_key, empty.admin_key, empty.engine_key) == (None, None, None)


def test_only_explicit_0600_owned_regular_secret_file_is_read(tmp_path):
    path = tmp_path / "fixture-secret"
    path.write_text(DATA_KEY + "\n", encoding="ascii")
    path.chmod(0o600)
    assert read_secret_file(str(path)) == DATA_KEY
    configured = Settings.from_env({"EMBEDDING_API_KEY_FILE": str(path), "EMBEDDING_ADMIN_API_KEY": ADMIN_KEY})
    assert configured.data_key.get_secret_value() == DATA_KEY
    link = tmp_path / "fixture-link"
    link.symlink_to(path)
    with pytest.raises(EmbeddingError):
        read_secret_file(str(link))
    path.chmod(0o644)
    with pytest.raises(EmbeddingError):
        read_secret_file(str(path))
    with pytest.raises(EmbeddingError):
        Settings.from_env({"EMBEDDING_API_KEY": DATA_KEY, "EMBEDDING_API_KEY_FILE": str(path)})
    # 无隐式用户文件读取：空env只创建locked配置。
    assert Settings.from_env({}).data_key is None
