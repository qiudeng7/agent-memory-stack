"""FastAPI边界：角色分离、有限body、仅安全错误、不流出上游正文。"""
from __future__ import annotations

import asyncio
import hmac
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .backend import Backend, LlamaHttpBackend
from .config import EmbeddingError, PINNED_PROFILE, Profile, Settings, strict_json_loads
from .service import EmbeddingRequest, EmbeddingService


def error_response(error: EmbeddingError) -> JSONResponse:
    return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)


class FrontDoor:
    """纯ASGI认证与body上限；先认证，避免Pydantic默认错误回显原文。"""

    def __init__(self, app: ASGIApp, settings: Settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        role = "data" if path.startswith("/v1/") else "admin" if path.startswith("/admin/") else None
        headers = scope.get("headers", [])
        if role:
            expected = self.settings.data_key if role == "data" else self.settings.admin_key
            if expected is None:
                await error_response(EmbeddingError("authentication_not_configured", 503, "Endpoint credentials are not configured"))(scope, receive, send)
                return
            auth = [value for key, value in headers if key.lower() == b"authorization"]
            valid = False
            if len(auth) == 1:
                parts = auth[0].split(b" ")
                valid = (len(parts) == 2 and parts[0].lower() == b"bearer"
                         and hmac.compare_digest(parts[1], expected.get_secret_value().encode("ascii")))
            if not valid:
                response = error_response(EmbeddingError("unauthorized", 401, "Bearer authentication required"))
                response.headers["WWW-Authenticate"] = "Bearer"
                await response(scope, receive, send)
                return
        if path != "/v1/embeddings" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        try:
            lengths = [value for key, value in headers if key.lower() == b"content-length"]
            if len(lengths) > 1 or (lengths and (not lengths[0].isdigit() or len(lengths[0]) > 16)):
                raise EmbeddingError("invalid_request", 400, "Invalid request framing")
            if lengths and int(lengths[0]) > self.settings.body_limit_bytes:
                raise EmbeddingError("body_too_large", 413, "Request body exceeds limit")
            content_types = [value.lower().split(b";", 1)[0].strip() for key, value in headers if key.lower() == b"content-type"]
            if content_types != [b"application/json"]:
                raise EmbeddingError("unsupported_media_type", 415, "JSON request required")
            body = bytearray()
            async with asyncio.timeout(self.settings.timeout_seconds):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        raise EmbeddingError("cancelled", 499, "Request cancelled")
                    if message["type"] != "http.request":
                        raise EmbeddingError("invalid_request", 400, "Invalid request framing")
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > self.settings.body_limit_bytes:
                        raise EmbeddingError("body_too_large", 413, "Request body exceeds limit")
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break
            consumed = False

            async def replay() -> Message:
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()

            await self.app(scope, replay, send)
        except TimeoutError:
            await error_response(EmbeddingError("request_timeout", 504, "Request body timed out"))(scope, receive, send)
        except EmbeddingError as error:
            await error_response(error)(scope, receive, send)


async def execute_with_disconnect(request: Request, service: EmbeddingService, parsed: EmbeddingRequest) -> dict[str, object]:
    operation = asyncio.create_task(service.execute(parsed))

    async def wait_disconnect() -> None:
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return

    watcher = asyncio.create_task(wait_disconnect())
    try:
        done, _ = await asyncio.wait({operation, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            raise EmbeddingError("cancelled", 499, "Request cancelled")
        return await operation
    finally:
        for task in (operation, watcher):
            if not task.done():
                task.cancel()
        await asyncio.gather(operation, watcher, return_exceptions=True)


def create_app(settings: Settings | None = None, backend: Backend | None = None, profile: Profile = PINNED_PROFILE) -> FastAPI:
    # 默认构造不读环境或文件。只有显式factory/from_env才加载指定的服务配置。
    selected = settings if settings is not None else Settings()
    engine_backend = backend if backend is not None else LlamaHttpBackend(selected, profile)
    service = EmbeddingService(profile, engine_backend, selected)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await engine_backend.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.state.embedding_service = service
    app.add_middleware(FrontDoor, settings=selected)

    @app.exception_handler(EmbeddingError)
    async def known_error(_: Request, error: EmbeddingError) -> JSONResponse:
        return error_response(error)

    @app.exception_handler(RequestValidationError)
    async def invalid_route(_: Request, __: RequestValidationError) -> JSONResponse:
        return error_response(EmbeddingError("invalid_request", 400, "Invalid request"))

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException) -> JSONResponse:
        return error_response(EmbeddingError("http_error", error.status_code, "Request rejected"))

    @app.exception_handler(Exception)
    async def unexpected(_: Request, __: Exception) -> JSONResponse:
        return error_response(EmbeddingError("internal_error", 500, "Internal service error"))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"service": "embedding", "status": "ok"}

    @app.get("/ready")
    async def ready() -> dict[str, str]:
        if selected.data_key is None or selected.admin_key is None:
            raise EmbeddingError("embedding_not_ready", 503, "Embedding configuration is not ready")
        try:
            async with asyncio.timeout(min(3.0, selected.timeout_seconds)):
                ready = await engine_backend.ready()
        except (TimeoutError, EmbeddingError):
            ready = False
        except Exception:
            ready = False
        if not ready:
            raise EmbeddingError("embedding_not_ready", 503, "Embedding backend is not ready")
        # 仅engine health + alias检查；不是GGUF内容hash、pooling或OV记忆闭环实测。
        return {"service": "embedding", "status": "ready", "model": profile.alias}

    @app.get("/v1/models")
    async def models() -> dict[str, object]:
        return {"object": "list", "data": [{"id": profile.alias, "object": "model", "created": 0, "owned_by": "agent-memory-stack"}]}

    @app.post("/v1/embeddings")
    async def embeddings(request: Request) -> dict[str, object]:
        try:
            body = strict_json_loads(await request.body())
            parsed = EmbeddingRequest.model_validate(body)
        except (ValueError, UnicodeError, RecursionError, ValidationError):
            raise EmbeddingError("invalid_request", 400, "Invalid embedding JSON request") from None
        return await execute_with_disconnect(request, service, parsed)

    @app.get("/admin/status")
    async def status() -> dict[str, object]:
        return {"service": "embedding", **service.status()}

    return app


def app_factory() -> FastAPI:
    return create_app(Settings.from_env())
