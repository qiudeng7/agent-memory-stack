"""合成fixture离线验证；不读用户凭据，不发网络/GPU请求。"""
import asyncio
import dataclasses
import math
import time

import pytest
from pydantic import ValidationError

from ams_embedding.backend import EmbeddingBatch
from ams_embedding.config import EmbeddingError, PINNED_PROFILE, Profile, Settings
from ams_embedding.service import EmbeddingRequest, EmbeddingService


DATA_KEY = "synthetic-data-key-0001-0123456789abcdef"
ADMIN_KEY = "synthetic-admin-key-0002-0123456789abcdef"
FIXTURE_PROFILE = dataclasses.replace(PINNED_PROFILE, dimensions=4, max_tokens=20, query_instruction="Retrieve facts.")


class FakeBackend:
    def __init__(self, profile=FIXTURE_PROFILE, tokens=5, vectors=None, error=None):
        self.profile, self.tokens, self.vectors, self.error = profile, tokens, vectors, error
        self.tokenized = []
        self.embedded = []
        self.closed = False
        self.is_ready = True
        self.entered = None
        self.release = None
        self.cancelled = False

    async def tokenize(self, text):
        self.tokenized.append(text)
        return self.tokens.get(text, 5) if isinstance(self.tokens, dict) else self.tokens

    async def embed(self, texts):
        self.embedded.append(list(texts))
        if self.entered:
            self.entered.set()
        if self.release:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        if self.error:
            raise self.error
        vectors = self.vectors
        if vectors is None:
            vectors = [tuple(1.0 if index == (1 if text == "b" else 0) else 0.0 for index in range(self.profile.dimensions)) for text in texts]
        return EmbeddingBatch(tuple(vectors), 5 * len(texts))

    async def ready(self):
        return self.is_ready

    async def close(self):
        self.closed = True


def setup_service(*, backend=None, profile=FIXTURE_PROFILE, **options):
    selected = backend or FakeBackend(profile)
    settings = Settings(data_key=DATA_KEY, admin_key=ADMIN_KEY, **options)
    return EmbeddingService(profile, selected, settings), selected


def request(input="synthetic", input_type="document", profile=FIXTURE_PROFILE, **extra):
    return EmbeddingRequest(model=profile.alias, input=input, input_type=input_type, **extra)


def assert_code(error, code, status=None):
    assert isinstance(error.value, EmbeddingError)
    assert error.value.code == code
    if status is not None:
        assert error.value.status == status


@pytest.mark.asyncio
async def test_query_prefix_only_query_and_complete_text_tokenized():
    service, backend = setup_service()
    for direction in ("document", "passage", "query"):
        await service.execute(request("synthetic source", direction))
    assert backend.tokenized == ["synthetic source", "Instruct: Retrieve facts.\nQuery: synthetic source"]
    assert backend.embedded == [["synthetic source"], ["Instruct: Retrieve facts.\nQuery: synthetic source"]]


@pytest.mark.parametrize("direction", [None, ""])
@pytest.mark.asyncio
async def test_empty_direction_is_document(direction):
    service, backend = setup_service()
    await service.execute(request("synthetic document", direction))
    assert backend.tokenized == ["synthetic document"]
    assert backend.embedded == [["synthetic document"]]


@pytest.mark.asyncio
async def test_expired_atomic_cache_stage_does_not_commit_partial_results():
    service, _ = setup_service()
    await service.execute(request("existing"))
    original = list(service.cache.entries.items())
    with pytest.raises(EmbeddingError) as error:
        service.cache.set_many([("a" * 64, (1.0, 0.0, 0.0, 0.0), 5)], time.monotonic() - 1)
    assert_code(error, "request_timeout", 504)
    assert list(service.cache.entries.items()) == original


@pytest.mark.asyncio
async def test_all_input_preflight_before_embed_and_prefix_budget():
    backend = FakeBackend(tokens={"ok": 5, "long": 21, "Instruct: Retrieve facts.\nQuery: short": 21})
    service, _ = setup_service(backend=backend)
    for req in (request(["ok", "long"]), request("short", "query")):
        with pytest.raises(EmbeddingError) as error:
            await service.execute(req)
        assert_code(error, "input_too_long", 422)
    assert backend.embedded == []
    assert service.cache.status()["entries"] == 0


@pytest.mark.asyncio
async def test_pinned_full_dimension_and_exact_2000_token_boundary():
    backend = FakeBackend(profile=PINNED_PROFILE, tokens=2000)
    service, _ = setup_service(backend=backend, profile=PINNED_PROFILE)
    result = await service.execute(request(profile=PINNED_PROFILE))
    assert len(result["data"][0]["embedding"]) == 1024
    assert math.hypot(*result["data"][0]["embedding"]) == 1
    assert result["usage"]["prompt_tokens"] == 2000
    backend.tokens = 2001
    with pytest.raises(EmbeddingError) as error:
        await service.execute(request("different", profile=PINNED_PROFILE))
    assert_code(error, "input_too_long", 422)
    assert len(backend.embedded) == 1


@pytest.mark.asyncio
async def test_truncation_marker_rejected_before_any_tokenizer():
    service, backend = setup_service()
    with pytest.raises(EmbeddingError) as error:
        await service.execute(request(["valid", "synthetic ...(truncated for embedding)"]))
    assert_code(error, "upstream_truncation_detected", 422)
    assert backend.tokenized == backend.embedded == []


@pytest.mark.asyncio
async def test_cache_and_duplicate_batch_order_are_preserved_without_raw_text_storage():
    service, backend = setup_service()
    first = await service.execute(request("a"))
    first["data"][0]["embedding"][0] = 123
    result = await service.execute(request(["b", "a", "b"]))
    assert [row["index"] for row in result["data"]] == [0, 1, 2]
    assert [row["embedding"] for row in result["data"]] == [[0, 1, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0]]
    assert result["usage"] == {"prompt_tokens": 15, "total_tokens": 15}
    assert backend.embedded == [["a"], ["b"]]
    assert backend.tokenized == ["a", "b"]
    assert all(len(key) == 64 for key in service.cache.entries)
    assert all(set(dataclasses.asdict(entry)) == {"vector", "tokens", "expires", "estimated_bytes"} for entry in service.cache.entries.values())


@pytest.mark.asyncio
async def test_batch_duplicates_and_simultaneous_identical_requests_compute_once():
    service, backend = setup_service()
    result = await service.execute(request(["a", "b", "a"]))
    assert backend.embedded == [["a", "b"]]
    assert result["usage"]["prompt_tokens"] == 15
    results = await asyncio.gather(*(service.execute(request("same")) for _ in range(8)))
    assert all(value == results[0] for value in results)
    assert backend.embedded == [["a", "b"], ["same"]]


@pytest.mark.asyncio
async def test_cache_lru_ttl_and_zero_capacity_do_not_change_success():
    service, backend = setup_service(cache_bytes=1152)
    for text in ("a", "b", "a"):
        await service.execute(request(text))
    assert len(backend.embedded) == 3
    assert service.cache.status()["entries"] == 1
    assert service.cache.status()["estimated_bytes"] <= 1152
    expiry, exp_backend = setup_service(cache_ttl_seconds=0.01)
    await expiry.execute(request("ttl"))
    await asyncio.sleep(0.02)
    await expiry.execute(request("ttl"))
    assert len(exp_backend.embedded) == 2
    zero, zero_backend = setup_service(cache_bytes=0)
    for _ in range(2):
        assert len((await zero.execute(request()))["data"]) == 1
    assert len(zero_backend.embedded) == 2
    assert zero.cache.status()["entries"] == 0


@pytest.mark.asyncio
async def test_cache_identity_binds_complete_pipeline_revision_and_instruction():
    service, backend = setup_service()
    await service.execute(request("same"))
    for changed in (dataclasses.replace(FIXTURE_PROFILE, engine_revision="other-revision"), dataclasses.replace(FIXTURE_PROFILE, query_instruction="Different instruction.")):
        other, other_backend = setup_service(profile=changed)
        other.cache = service.cache
        await other.execute(request("same", profile=changed))
        assert len(other_backend.embedded) == 1
    assert len(backend.embedded) == 1


@pytest.mark.parametrize("vector", [(1, 0), (2, 0, 0, 0), (0, 0, 0, 0), (float("nan"), 0, 0, 0), (float("inf"), 0, 0, 0), (True, 0, 0, 0), ("1", 0, 0, 0)])
@pytest.mark.asyncio
async def test_bad_vectors_rejected_and_never_cached(vector):
    service, backend = setup_service(backend=FakeBackend(vectors=[vector]))
    for _ in range(2):
        with pytest.raises(EmbeddingError) as error:
            await service.execute(request())
        assert_code(error, "invalid_vector", 502)
    assert len(backend.embedded) == 2
    assert service.cache.status()["entries"] == 0


@pytest.mark.asyncio
async def test_invalid_second_vector_does_not_cache_valid_first_vector():
    service, _ = setup_service(backend=FakeBackend(vectors=[(1, 0, 0, 0), (2, 0, 0, 0)]))
    with pytest.raises(EmbeddingError):
        await service.execute(request(["a", "b"]))
    assert service.cache.status()["entries"] == 0


@pytest.mark.parametrize("tokens", [True, 0, -1, 2.5, "5"])
@pytest.mark.asyncio
async def test_invalid_tokenizer_count_never_embeds(tokens):
    service, backend = setup_service(backend=FakeBackend(tokens=tokens))
    with pytest.raises(EmbeddingError) as error:
        await service.execute(request())
    assert_code(error, "upstream_protocol_error", 502)
    assert backend.embedded == []


@pytest.mark.asyncio
async def test_backend_failure_and_unexpected_exception_are_not_cached():
    backend = FakeBackend(error=EmbeddingError("embedding_backend_error", 502, "Embedding backend rejected the request"))
    service, _ = setup_service(backend=backend)
    for _ in range(2):
        with pytest.raises(EmbeddingError):
            await service.execute(request())
    assert len(backend.embedded) == 2
    assert service.cache.status()["entries"] == 0
    backend.error = RuntimeError("synthetic-private-body-and-key")
    with pytest.raises(EmbeddingError) as error:
        await service.execute(request())
    assert_code(error, "internal_error", 500)
    assert "synthetic-private" not in str(error.value)


@pytest.mark.asyncio
async def test_bounded_queue_wait_timeout_cancel_and_failure_do_not_cache():
    backend = FakeBackend()
    backend.entered, backend.release = asyncio.Event(), asyncio.Event()
    service, _ = setup_service(backend=backend, max_pending=0)
    active = asyncio.create_task(service.execute(request("active")))
    await backend.entered.wait()
    with pytest.raises(EmbeddingError) as error:
        await service.execute(request("too-many"))
    assert_code(error, "queue_full", 429)
    active.cancel()
    with pytest.raises(asyncio.CancelledError):
        await active
    assert backend.cancelled
    assert service.status()["admitted_requests"] == 0
    assert service.cache.status()["entries"] == 0

    timeout_backend = FakeBackend()
    timeout_backend.entered, timeout_backend.release = asyncio.Event(), asyncio.Event()
    timeout_service, _ = setup_service(backend=timeout_backend, timeout_seconds=0.02)
    with pytest.raises(EmbeddingError) as error:
        await timeout_service.execute(request("timed-out"))
    assert_code(error, "request_timeout", 504)
    assert timeout_backend.cancelled
    assert timeout_service.cache.status()["entries"] == 0


@pytest.mark.asyncio
async def test_cancel_waiter_does_not_execute_and_frees_queue_admission():
    backend = FakeBackend()
    backend.entered, backend.release = asyncio.Event(), asyncio.Event()
    service, _ = setup_service(backend=backend, max_pending=1)
    active = asyncio.create_task(service.execute(request("first")))
    await backend.entered.wait()
    waiting = asyncio.create_task(service.execute(request("waiting")))
    await asyncio.sleep(0)
    assert service.status()["admitted_requests"] == 2
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    backend.release.set()
    await active
    assert backend.embedded == [["first"]]
    assert service.status()["admitted_requests"] == 0


@pytest.mark.parametrize("extra", [{"encoding_format": "base64"}, {"input_type": "unknown"}, {"url": "http://untrusted.invalid"}, {"dimensions": True}])
def test_request_extra_or_incompatible_type_rejected(extra):
    with pytest.raises(ValidationError):
        EmbeddingRequest.model_validate({"model": FIXTURE_PROFILE.alias, "input": "a", **extra})


@pytest.mark.parametrize("value", ["", "   ", [], ["a"] * 33, [1], ["a", ""], 42, "\ud800"])
def test_strict_input_batch_bounds_and_unicode(value):
    with pytest.raises((ValueError, ValidationError)):
        EmbeddingRequest(model=FIXTURE_PROFILE.alias, input=value)


@pytest.mark.asyncio
async def test_model_and_dimension_alias_enforced():
    service, _ = setup_service()
    for req, code in ((EmbeddingRequest(model="unknown", input="x"), "unknown_model"), (request(dimensions=2), "invalid_dimensions"), (request(dimensions=None), "invalid_dimensions")):
        with pytest.raises(EmbeddingError) as error:
            await service.execute(req)
        assert_code(error, code)
