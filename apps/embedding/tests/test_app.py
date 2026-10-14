import asyncio
import json

import httpx
import pytest

from ams_embedding.app import create_app
from ams_embedding.config import Settings
from test_service import ADMIN_KEY, DATA_KEY, FIXTURE_PROFILE, FakeBackend


@pytest.fixture
async def application():
    backend = FakeBackend()
    app = create_app(Settings(data_key=DATA_KEY, admin_key=ADMIN_KEY), backend, FIXTURE_PROFILE)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture.invalid") as client:
        yield app, client, backend


def payload(text="synthetic", **extra):
    return {"model": FIXTURE_PROFILE.alias, "input": text, **extra}


DATA_AUTH = {"Authorization": f"Bearer {DATA_KEY}"}
ADMIN_AUTH = {"Authorization": f"Bearer {ADMIN_KEY}"}


@pytest.mark.asyncio
async def test_health_models_ready_and_admin_roles(application):
    app, client, backend = application
    assert (await client.get("/health")).status_code == 200
    ready = await client.get("/ready")
    assert ready.status_code == 200 and ready.json()["model"] == FIXTURE_PROFILE.alias
    assert (await client.get("/v1/models")).status_code == 401
    assert (await client.get("/v1/models", headers=ADMIN_AUTH)).status_code == 401
    model = await client.get("/v1/models", headers=DATA_AUTH)
    assert model.json()["data"][0]["id"] == FIXTURE_PROFILE.alias
    assert (await client.get("/admin/status", headers=DATA_AUTH)).status_code == 401
    status = await client.get("/admin/status", headers=ADMIN_AUTH)
    assert status.status_code == 200
    assert status.json()["cache"]["max_estimated_bytes"] == 256 * 1024 * 1024
    assert DATA_KEY not in status.text and ADMIN_KEY not in status.text
    backend.is_ready = False
    assert (await client.get("/ready")).status_code == 503
    assert (await client.get("/docs")).status_code == 404


@pytest.mark.asyncio
async def test_missing_credentials_never_fail_open():
    backend = FakeBackend()
    app = create_app(Settings(), backend, FIXTURE_PROFILE)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture.invalid") as client:
        assert (await client.get("/health")).status_code == 200
        for path in ("/ready", "/v1/models", "/admin/status"):
            assert (await client.get(path, headers=DATA_AUTH)).status_code == 503
        response = await client.post("/v1/embeddings", headers=DATA_AUTH, json=payload())
        assert response.status_code == 503
    assert backend.tokenized == backend.embedded == []


@pytest.mark.asyncio
async def test_embeddings_valid_batch_float_dimensions_order(application):
    _, client, backend = application
    result = await client.post("/v1/embeddings", headers=DATA_AUTH, json=payload(["a", "b", "a"], dimensions=4))
    assert result.status_code == 200
    body = result.json()
    assert body["object"] == "list"
    assert [row["index"] for row in body["data"]] == [0, 1, 2]
    assert body["data"][0]["embedding"] == body["data"][2]["embedding"]
    assert backend.embedded == [["a", "b"]]


@pytest.mark.parametrize("body", [b'{"input":"synthetic-private-body",', b'{"model":"a","model":"b","input":"synthetic-private-body"}', b'{"input":NaN}', b'"synthetic-private-body"'])
@pytest.mark.asyncio
async def test_malformed_json_error_never_echoes_body_or_credentials(application, body, caplog):
    _, client, backend = application
    response = await client.post("/v1/embeddings", headers={**DATA_AUTH, "Content-Type": "application/json"}, content=body)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"
    for marker in ("synthetic-private-body", DATA_KEY, ADMIN_KEY):
        assert marker not in response.text and marker not in caplog.text
    assert backend.tokenized == []


@pytest.mark.parametrize("extra", [{"extra": "synthetic-private-body"}, {"encoding_format": "base64"}, {"dimensions": True}, {"input_type": "unknown"}, {"input": [1]}, {"dimensions": 2}])
@pytest.mark.asyncio
async def test_shape_and_extra_fields_fail_without_pydantic_input_echo(application, extra, caplog):
    _, client, backend = application
    response = await client.post("/v1/embeddings", headers=DATA_AUTH, json={**payload(), **extra})
    assert response.status_code == 400
    assert "synthetic-private-body" not in response.text + caplog.text
    assert backend.tokenized == []


@pytest.mark.asyncio
async def test_unknown_model_is_404_and_truncation_token_budget_is_422(application):
    _, client, backend = application
    assert (await client.post("/v1/embeddings", headers=DATA_AUTH, json={**payload(), "model": "unknown"})).status_code == 404
    response = await client.post("/v1/embeddings", headers=DATA_AUTH, json=payload("private ...(truncated for embedding)"))
    assert response.status_code == 422 and backend.tokenized == []
    backend.tokens = 21
    response = await client.post("/v1/embeddings", headers=DATA_AUTH, json=payload("short", input_type="query"))
    assert response.status_code == 422
    assert backend.tokenized[0].startswith("Instruct:")
    assert backend.embedded == []


@pytest.mark.asyncio
async def test_oversize_content_length_and_chunked_body_413_no_echo(application, caplog):
    _, client, backend = application
    headers = {**DATA_AUTH, "Content-Type": "application/json"}
    response = await client.post("/v1/embeddings", headers=headers, content=b"synthetic-private-body" * 14000)
    assert response.status_code == 413
    assert "synthetic-private-body" not in response.text + caplog.text

    async def chunked():
        yield b"a" * 150000
        yield b"synthetic-private-body" * 7000
    response = await client.post("/v1/embeddings", headers=headers, content=chunked())
    assert response.status_code == 413
    assert "synthetic-private-body" not in response.text + caplog.text
    assert backend.tokenized == backend.embedded == []


@pytest.mark.asyncio
async def test_duplicate_auth_and_media_type_are_rejected_before_body(application):
    _, client, backend = application
    response = await client.post("/v1/embeddings", json=payload(), headers=[("Authorization", f"Bearer {DATA_KEY}"), ("Authorization", f"Bearer {DATA_KEY}")])
    assert response.status_code == 401
    response = await client.post("/v1/embeddings", headers=DATA_AUTH, content="synthetic")
    assert response.status_code == 415
    assert backend.tokenized == []


@pytest.mark.asyncio
async def test_trailing_slash_does_not_redirect_bearer_or_buffer_body(application):
    _, client, backend = application
    response = await client.post("/v1/embeddings/", headers=DATA_AUTH, json=payload(), follow_redirects=False)
    assert response.status_code == 404
    assert "location" not in response.headers
    assert backend.tokenized == []


@pytest.mark.asyncio
async def test_asgi_request_cancellation_cancels_backend_and_does_not_cache(application):
    app, client, backend = application
    backend.entered, backend.release = asyncio.Event(), asyncio.Event()
    operation = asyncio.create_task(client.post("/v1/embeddings", headers=DATA_AUTH, json=payload("cancel")))
    await backend.entered.wait()
    operation.cancel()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert backend.cancelled
    assert app.state.embedding_service.cache.status()["entries"] == 0
    assert app.state.embedding_service.status()["admitted_requests"] == 0


@pytest.mark.asyncio
async def test_explicit_http_disconnect_cancels_processing_without_partial_cache():
    backend = FakeBackend()
    backend.entered, backend.release = asyncio.Event(), asyncio.Event()
    app = create_app(Settings(data_key=DATA_KEY, admin_key=ADMIN_KEY), backend, FIXTURE_PROFILE)
    first = True
    sent = []
    body = json.dumps(payload("disconnect")).encode()
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http", "path": "/v1/embeddings", "raw_path": b"/v1/embeddings", "query_string": b"", "headers": [(b"authorization", f"Bearer {DATA_KEY}".encode()), (b"content-type", b"application/json")], "client": ("127.0.0.1", 0), "server": ("fixture.invalid", 80)}

    async def receive():
        nonlocal first
        if first:
            first = False
            return {"type": "http.request", "body": body, "more_body": False}
        await backend.entered.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    await app(scope, receive, send)
    assert sent[0]["status"] == 499
    assert backend.cancelled
    assert app.state.embedding_service.cache.status()["entries"] == 0


@pytest.mark.asyncio
async def test_lifespan_closes_backend():
    backend = FakeBackend()
    app = create_app(Settings(), backend, FIXTURE_PROFILE)
    async with app.router.lifespan_context(app):
        assert not backend.closed
    assert backend.closed
