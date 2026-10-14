"""显式配置与固定pipeline；不加载dotenv或用户认证目录。"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from dataclasses import asdict, dataclass
from typing import Mapping
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


class EmbeddingError(Exception):
    """只包含预先定义的安全错误code/message；不携带输入或上游正文。"""

    def __init__(self, code: str, status: int, message: str = "Embedding request rejected"):
        self.code = code
        self.status = status
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class Profile:
    alias: str = "memory-embedding-qwen3-v1"
    engine_alias: str = "qwen3-embedding-0.6b-q8"
    model_sha256: str = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
    engine_revision: str = "d81235049384534c167caea52b85a694f6103d14"
    pipeline_revision: str = "qwen3-last-l2-query-instruct-v1"
    dimensions: int = 1024
    max_tokens: int = 2000
    pooling: str = "last"
    normalization: str = "L2"
    add_special: bool = True
    query_instruction: str = (
        "Given a question, retrieve relevant facts, preferences, and technical notes from agent memory."
    )

    def __post_init__(self) -> None:
        if (not re.fullmatch(r"[a-f0-9]{64}", self.model_sha256)
                or type(self.dimensions) is not int or self.dimensions < 1
                or type(self.max_tokens) is not int or not 1 <= self.max_tokens <= 2000
                or self.pooling != "last" or self.normalization != "L2" or self.add_special is not True
                or not self.alias or not self.engine_alias or not self.engine_revision or not self.pipeline_revision):
            raise EmbeddingError("configuration_error", 500, "Invalid pinned embedding profile")

    @property
    def identity(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


PINNED_PROFILE = Profile()


def read_secret_file(path: str) -> str:
    """仅显式指定的0600、当前UID普通文件；拒绝符号链接，检查打开后的FD。"""
    fd: int | None = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or not 0 < info.st_size <= 4096):
            raise ValueError("invalid secret permissions")
        with os.fdopen(fd, "rb") as handle:
            fd = None
            value = handle.read(4097)
        if len(value) > 4096:
            raise ValueError("secret too large")
        return value.decode("ascii").rstrip("\r\n")
    except (OSError, ValueError, UnicodeError):
        raise EmbeddingError("configuration_error", 500, "Invalid configured secret file") from None
    finally:
        if fd is not None:
            os.close(fd)


def configured_secret(env: Mapping[str, str], name: str) -> str | None:
    direct, path = env.get(name), env.get(f"{name}_FILE")
    if direct is not None and path is not None:
        raise EmbeddingError("configuration_error", 500, "Specify a credential or its file, not both")
    return read_secret_file(path) if path is not None else direct


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    engine_url: str = "http://embedding-engine:8080"
    data_key: SecretStr | None = Field(default=None, repr=False)
    admin_key: SecretStr | None = Field(default=None, repr=False)
    engine_key: SecretStr | None = Field(default=None, repr=False)
    cache_bytes: int = Field(default=256 * 1024 * 1024, ge=0, le=1024 * 1024 * 1024)
    cache_ttl_seconds: float = Field(default=3600.0, gt=0, le=86400)
    max_pending: int = Field(default=16, ge=0, le=128)
    timeout_seconds: float = Field(default=120.0, gt=0, le=600)
    engine_timeout_seconds: float = Field(default=30.0, gt=0, le=600)
    body_limit_bytes: int = Field(default=256 * 1024, ge=1024, le=256 * 1024)
    upstream_limit_bytes: int = Field(default=2 * 1024 * 1024, ge=1024, le=8 * 1024 * 1024)

    @field_validator("engine_url")
    @classmethod
    def trusted_origin(cls, value: str) -> str:
        try:
            url = urlsplit(value)
            if (url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password
                    or url.path not in {"", "/"} or url.query or url.fragment
                    or any(c.isspace() or ord(c) < 32 for c in value)):
                raise ValueError("invalid")
            _ = url.port
        except ValueError:
            raise ValueError("Engine must be a trusted HTTP origin without path or credentials") from None
        return value.rstrip("/")

    @field_validator("data_key", "admin_key", "engine_key", mode="before")
    @classmethod
    def valid_key(cls, value: object) -> SecretStr | None:
        if value is None:
            return None
        token = value.get_secret_value() if isinstance(value, SecretStr) else value
        if (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9._~+/=-]{32,4096}", token)
                or "REPLACE_" in token.upper()):
            raise ValueError("Credential must be an ASCII bearer token of at least 32 characters, not a template")
        return SecretStr(token)

    @model_validator(mode="after")
    def separate_roles(self) -> Settings:
        if (self.data_key is not None and self.admin_key is not None
                and self.data_key.get_secret_value() == self.admin_key.get_secret_value()):
            raise ValueError("Data and administrator credentials must differ")
        return self

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        values = os.environ if env is None else env
        try:
            names = ("EMBEDDING_API_KEY", "EMBEDDING_ADMIN_API_KEY", "EMBEDDING_ENGINE_API_KEY")
            if "AMS_MASTER_KEY" in values:
                master = values["AMS_MASTER_KEY"]
                if not isinstance(master, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", master):
                    raise EmbeddingError("configuration_error", 500, "Invalid AMS_MASTER_KEY: expected 64 hexadecimal characters")
                if any(name in values or f"{name}_FILE" in values for name in names):
                    raise EmbeddingError("configuration_error", 500, "AMS_MASTER_KEY cannot be combined with explicit service credentials or files")
                # Literal UTF-8: do not decode hex or normalize case.
                keys = [hmac.new(master.encode("utf-8"), f"agent-memory-stack/v1/{role}".encode("utf-8"), hashlib.sha256).hexdigest()
                        for role in ("embedding-data", "embedding-admin", "embedding-engine")]
            else:
                keys = [configured_secret(values, name) for name in names]
            return cls(
                engine_url=values.get("EMBEDDING_ENGINE_URL", "http://embedding-engine:8080"),
                data_key=keys[0],
                admin_key=keys[1],
                engine_key=keys[2],
                cache_bytes=int(values.get("EMBEDDING_CACHE_MIB", "256")) * 1024 * 1024,
                cache_ttl_seconds=float(values.get("EMBEDDING_CACHE_TTL_SECONDS", "3600")),
                max_pending=int(values.get("EMBEDDING_MAX_PENDING", "16")),
                timeout_seconds=float(values.get("EMBEDDING_TIMEOUT_SECONDS", "120")),
                engine_timeout_seconds=float(values.get("EMBEDDING_ENGINE_TIMEOUT_SECONDS", "30")),
            )
        except (ValueError, TypeError):
            raise EmbeddingError("configuration_error", 500, "Invalid embedding configuration") from None


def strict_json_loads(data: bytes | str) -> object:
    """拒绝NaN/Infinity及重复JSON键，包括转义后的重名。"""
    def pairs(entries: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in entries:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_: str) -> object:
        raise ValueError("nonfinite JSON")

    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
