# root context；基镜digest由父核实，覆盖ARG时也须使用审核后的pin/digest。
ARG PYTHON_IMAGE=python:3.11-slim-bookworm@sha256:a36c24f9cbdf4fd0f52d67f0823eeac19c2028c637cecc392d97f980d4fec56b
FROM ${PYTHON_IMAGE} AS build
ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY apps/embedding/pyproject.toml apps/embedding/requirements-dev.lock ./
COPY apps/embedding/src ./src
RUN python -m pip install --no-cache-dir --require-hashes -r requirements-dev.lock \
    && python -m build --wheel --no-isolation --outdir /wheels

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY apps/embedding/requirements.lock ./
COPY --from=build /wheels /wheels
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
    && python -m pip install --no-cache-dir --no-deps /wheels/*.whl \
    && rm -rf /wheels \
    && addgroup --system --gid 10001 ams \
    && adduser --system --uid 10001 --ingroup ams --no-create-home ams
USER 10001:10001
EXPOSE 8080
# 凭据文件须由运行UID拥有且0600；不COPY .env/用户认证或模型正文。
# 单worker：队列与缓存为单进程RAM，不假称跨实例coalesce。
CMD ["uvicorn", "ams_embedding.app:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log", "--log-level", "warning"]
