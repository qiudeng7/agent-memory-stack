"""可信固定origin的llama.cpp前置；不记录HTTP正文或凭据。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from .config import EmbeddingError, Profile, Settings, strict_json_loads


@dataclass(frozen=True)
class EmbeddingBatch:
    vectors: tuple[tuple[float, ...], ...]
    prompt_tokens: int


class Backend(Protocol):
    async def tokenize(self, text: str) -> int: ...
    async def embed(self, texts: list[str]) -> EmbeddingBatch: ...
    async def ready(self) -> bool: ...
    async def close(self) -> None: ...


def is_integer(value: object, minimum: int = 0) -> bool:
    return type(value) is int and minimum <= value <= 2**53 - 1


class LlamaHttpBackend:
    def __init__(self, settings: Settings, profile: Profile, transport: httpx.AsyncBaseTransport | None = None):
        self.profile = profile
        self.limit = settings.upstream_limit_bytes
        headers = {"Accept": "application/json"}
        if settings.engine_key is not None:
            headers["Authorization"] = f"Bearer {settings.engine_key.get_secret_value()}"
        self.client = httpx.AsyncClient(
            base_url=settings.engine_url,
            headers=headers,
            timeout=settings.engine_timeout_seconds,
            follow_redirects=False,
            trust_env=False,  # 不隐式读取代理、netrc或用户环境里的凭据。
            transport=transport,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def _call(self, path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
        try:
            async with self.client.stream("GET" if payload is None else "POST", path, json=payload) as response:
                if response.status_code != 200:
                    raise EmbeddingError("embedding_backend_error", 502, "Embedding backend rejected the request")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > self.limit:
                        raise EmbeddingError("upstream_protocol_error", 502, "Embedding backend response exceeds limit")
                    data.extend(chunk)
                try:
                    result = strict_json_loads(data)
                except (ValueError, UnicodeError, RecursionError):
                    raise EmbeddingError("upstream_protocol_error", 502, "Invalid embedding backend JSON") from None
                if not isinstance(result, dict):
                    raise EmbeddingError("upstream_protocol_error", 502, "Invalid embedding backend response")
                return result
        except httpx.TimeoutException:
            raise EmbeddingError("embedding_backend_timeout", 504, "Embedding backend timed out") from None
        except httpx.HTTPError:
            raise EmbeddingError("embedding_backend_unavailable", 503, "Embedding backend is unavailable") from None

    async def ready(self) -> bool:
        try:
            health = await self._call("/health")
            if health.get("status") != "ok":
                return False
            catalog = await self._call("/v1/models")
            rows = catalog.get("data")
            return isinstance(rows, list) and sum(
                isinstance(row, dict) and row.get("id") == self.profile.engine_alias for row in rows
            ) == 1
        except EmbeddingError:
            return False

    async def tokenize(self, text: str) -> int:
        body = await self._call("/tokenize", {"content": text, "add_special": self.profile.add_special})
        tokens = body.get("tokens")
        if not isinstance(tokens, list) or not tokens or not all(is_integer(token) for token in tokens):
            raise EmbeddingError("upstream_protocol_error", 502, "Invalid tokenizer response")
        return len(tokens)

    async def embed(self, texts: list[str]) -> EmbeddingBatch:
        body = await self._call("/v1/embeddings", {
            "model": self.profile.engine_alias, "input": texts, "encoding_format": "float",
        })
        rows, usage = body.get("data"), body.get("usage")
        if (not isinstance(rows, list) or len(rows) != len(texts) or not isinstance(usage, dict)
                or not is_integer(usage.get("prompt_tokens"))
                or ("model" in body and body["model"] != self.profile.engine_alias)):
            raise EmbeddingError("upstream_protocol_error", 502, "Invalid embedding batch identity or usage")
        vectors: list[tuple[float, ...] | None] = [None] * len(texts)
        for row in rows:
            if (not isinstance(row, dict) or not is_integer(row.get("index"))
                    or row["index"] >= len(texts) or vectors[row["index"]] is not None
                    or not isinstance(row.get("embedding"), list)
                    or row.get("object", "embedding") != "embedding"):
                raise EmbeddingError("upstream_protocol_error", 502, "Invalid embedding batch indices")
            vector = row["embedding"]
            if any(type(value) not in {int, float} for value in vector):
                raise EmbeddingError("invalid_vector", 502, "Invalid embedding vector values")
            try:
                vectors[row["index"]] = tuple(float(value) for value in vector)
            except (OverflowError, ValueError):
                raise EmbeddingError("invalid_vector", 502, "Invalid embedding vector values") from None
        if any(vector is None for vector in vectors):
            raise EmbeddingError("upstream_protocol_error", 502, "Missing embedding batch index")
        return EmbeddingBatch(tuple(vector for vector in vectors if vector is not None), usage["prompt_tokens"])
