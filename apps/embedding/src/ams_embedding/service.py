"""校验全部输入后才embed；有限串行队列 + digest-key RAM LRU/TTL缓存。"""
from __future__ import annotations

import asyncio
import hashlib
import math
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from .backend import Backend, EmbeddingBatch, is_integer
from .config import EmbeddingError, Profile, Settings


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    model: str
    input: str | list[str]
    input_type: Literal["query", "document", "passage"] = "document"
    encoding_format: Literal["float"] = "float"
    dimensions: int | None = None

    @field_validator("input_type", mode="before")
    @classmethod
    def default_direction(cls, value: object) -> object:
        # OV未指定方向（缺字段/null/空串）均按document；未知非空方向仍拒绝。
        return "document" if value is None or value == "" else value

    @field_validator("input")
    @classmethod
    def valid_input(cls, value: str | list[str]) -> str | list[str]:
        texts = [value] if isinstance(value, str) else value
        if not 1 <= len(texts) <= 32 or any(not text.strip() for text in texts):
            raise ValueError("Expected one to 32 nonempty strings")
        for text in texts:
            text.encode("utf-8")  # 拒绝孤立surrogate；不改写或截断文本。
        return value


@dataclass(frozen=True)
class CacheEntry:
    vector: tuple[float, ...]
    tokens: int
    expires: float
    estimated_bytes: int


class VectorCache:
    """缓存不存原文，仅pipeline/direction/text的SHA256与完整向量。"""

    def __init__(self, max_bytes: int, ttl: float):
        self.max_bytes, self.ttl = max_bytes, ttl
        self.entries: OrderedDict[str, CacheEntry] = OrderedDict()
        self.bytes = 0

    def _remove(self, key: str) -> None:
        self.bytes -= self.entries.pop(key).estimated_bytes

    def get(self, key: str) -> CacheEntry | None:
        entry = self.entries.get(key)
        if entry is None:
            return None
        if entry.expires <= time.monotonic():
            self._remove(key)
            return None
        self.entries.move_to_end(key)
        return entry

    def set_many(self, rows: list[tuple[str, tuple[float, ...], int]], deadline: float) -> None:
        # 暂存字典只复制entry引用，不复制整块向量RAM；全部成功后一次交换。
        now = time.monotonic()
        staged = OrderedDict((key, entry) for key, entry in self.entries.items() if entry.expires > now)
        total = sum(entry.estimated_bytes for entry in staged.values())
        for key, vector, tokens in rows:
            # Python float约24B + tuple slot约8B；留1KiB条目/字典/key余量。
            size = len(vector) * 32 + 1024
            if size > self.max_bytes:
                continue
            if key in staged:
                total -= staged.pop(key).estimated_bytes
            while total + size > self.max_bytes and staged:
                total -= staged.popitem(last=False)[1].estimated_bytes
            staged[key] = CacheEntry(vector, tokens, now + self.ttl, size)
            total += size
        if time.monotonic() >= deadline:
            raise EmbeddingError("request_timeout", 504, "Embedding request expired")
        self.entries, self.bytes = staged, total

    def expire(self) -> None:
        now = time.monotonic()
        for key in [key for key, entry in self.entries.items() if entry.expires <= now]:
            self._remove(key)

    def status(self) -> dict[str, int]:
        self.expire()
        return {"entries": len(self.entries), "estimated_bytes": self.bytes, "max_estimated_bytes": self.max_bytes}


class EmbeddingService:
    def __init__(self, profile: Profile, backend: Backend, settings: Settings):
        self.profile, self.backend, self.settings = profile, backend, settings
        self.cache = VectorCache(settings.cache_bytes, settings.cache_ttl_seconds)
        self._lock = asyncio.Lock()
        self._admitted = 0
        self._counters = {"requests": 0, "cache_hits": 0, "upstream_batches": 0, "input_rejected": 0, "failures": 0}

    def status(self) -> dict[str, object]:
        return {
            **self._counters, "admitted_requests": self._admitted,
            "cache": self.cache.status(), "model": self.profile.alias,
            "engine_alias": self.profile.engine_alias, "model_sha256": self.profile.model_sha256,
            "engine_revision": self.profile.engine_revision, "pipeline_revision": self.profile.pipeline_revision,
            "dimensions": self.profile.dimensions, "max_tokens": self.profile.max_tokens,
            "pooling": self.profile.pooling, "normalization": self.profile.normalization,
        }

    async def execute(self, request: EmbeddingRequest) -> dict[str, object]:
        self._counters["requests"] += 1
        if request.model != self.profile.alias:
            raise EmbeddingError("unknown_model", 404, "Unknown embedding model alias")
        if request.dimensions is not None and request.dimensions != self.profile.dimensions:
            raise EmbeddingError("invalid_dimensions", 400, "Dimensions must match the pinned profile")
        if "dimensions" in request.model_fields_set and request.dimensions is None:
            raise EmbeddingError("invalid_dimensions", 400, "Dimensions cannot be null")
        items = [request.input] if isinstance(request.input, str) else request.input
        if any("...(truncated for embedding)" in text for text in items):
            self._counters["input_rejected"] += 1
            raise EmbeddingError("upstream_truncation_detected", 422, "Input was truncated before reaching gateway")
        direction = "query" if request.input_type == "query" else "document"
        texts = [f"Instruct: {self.profile.query_instruction}\nQuery: {text}" if direction == "query" else text for text in items]
        keys = [hashlib.sha256((self.profile.identity + "\0" + direction + "\0" + text).encode("utf-8")).hexdigest() for text in texts]
        # 一个活动请求 + 最多max_pending个等待者。单event-loop内检查/增减不含await。
        if self._admitted >= self.settings.max_pending + 1:
            raise EmbeddingError("queue_full", 429, "Embedding queue is full")
        self._admitted += 1
        deadline = time.monotonic() + self.settings.timeout_seconds
        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                async with self._lock:
                    return await self._execute_locked(texts, keys, deadline)
        except TimeoutError:
            self._counters["failures"] += 1
            raise EmbeddingError("request_timeout", 504, "Embedding request expired") from None
        except (EmbeddingError, asyncio.CancelledError):
            self._counters["failures"] += 1
            raise
        except Exception:
            self._counters["failures"] += 1
            raise EmbeddingError("internal_error", 500, "Internal embedding error") from None
        finally:
            self._admitted -= 1

    async def _execute_locked(self, texts: list[str], keys: list[str], deadline: float) -> dict[str, object]:
        def check_time() -> None:
            if time.monotonic() >= deadline:
                raise EmbeddingError("request_timeout", 504, "Embedding request expired")

        check_time()
        cached = [self.cache.get(key) for key in keys]
        self._counters["cache_hits"] += sum(entry is not None for entry in cached)
        missing: dict[str, tuple[str, int]] = {}
        for text, key, entry in zip(texts, keys, cached, strict=True):
            if entry is not None or key in missing:
                continue
            tokens = await self.backend.tokenize(text)
            if not is_integer(tokens, 1):
                raise EmbeddingError("upstream_protocol_error", 502, "Invalid tokenizer response")
            if tokens > self.profile.max_tokens:
                self._counters["input_rejected"] += 1
                raise EmbeddingError("input_too_long", 422, "Final embedding text exceeds token budget")
            missing[key] = (text, tokens)
        check_time()
        resolved: dict[str, CacheEntry] = {key: entry for key, entry in zip(keys, cached, strict=True) if entry is not None}
        if missing:
            self._counters["upstream_batches"] += 1
            batch = await self.backend.embed([row[0] for row in missing.values()])
            vectors = self._validate_batch(batch, len(missing))
            check_time()
            for (key, (_, tokens)), vector in zip(missing.items(), vectors, strict=True):
                resolved[key] = CacheEntry(vector, tokens, 0, 0)
        tokens = sum(resolved[key].tokens for key in keys)
        result = {
            "object": "list", "model": self.profile.alias,
            "data": [{"object": "embedding", "index": index, "embedding": list(resolved[key].vector)} for index, key in enumerate(keys)],
            # cache/去重后仍按逻辑请求文本计数，不冒称本次实际engine计算/收费量。
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
        }
        check_time()
        # 成功响应已完整构造才暂存并原子提交cache；提交前再检查期限。
        if missing:
            self.cache.set_many([(key, resolved[key].vector, resolved[key].tokens) for key in missing], deadline)
        return result

    def _validate_batch(self, batch: EmbeddingBatch, count: int) -> list[tuple[float, ...]]:
        if (not isinstance(batch, EmbeddingBatch) or not isinstance(batch.vectors, (tuple, list)) or len(batch.vectors) != count
                or not is_integer(batch.prompt_tokens)):
            raise EmbeddingError("upstream_protocol_error", 502, "Invalid embedding batch response")
        validated: list[tuple[float, ...]] = []
        for vector in batch.vectors:
            if (not isinstance(vector, (tuple, list)) or len(vector) != self.profile.dimensions
                    or any(type(value) not in {int, float} for value in vector)):
                raise EmbeddingError("invalid_vector", 502, "Invalid embedding dimension or values")
            try:
                normalized = tuple(float(value) for value in vector)
                norm = math.hypot(*normalized)
                if not all(math.isfinite(value) for value in normalized) or abs(norm - 1.0) > 0.001:
                    raise ValueError("invalid norm")
            except (ValueError, OverflowError):
                raise EmbeddingError("invalid_vector", 502, "Embedding must be finite, full-dimensional and L2 normalized") from None
            validated.append(normalized)
        return validated
