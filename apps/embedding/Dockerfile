# Root build context; both native engine and Python wheel use the reviewed base.
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce
FROM ${PYTHON_IMAGE} AS engine-build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake ninja-build g++ libvulkan-dev glslc spirv-headers libssl-dev
ARG LLAMA_REVISION=d81235049384534c167caea52b85a694f6103d14
RUN git init /src && git -C /src remote add origin https://github.com/ggml-org/llama.cpp.git \
    && git -C /src fetch --depth 1 origin "${LLAMA_REVISION}" \
    && git -C /src checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "${LLAMA_REVISION}"
RUN cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DGGML_VULKAN=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF \
    -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
    -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    && cmake --build /build --target llama-server --parallel 2

FROM ${PYTHON_IMAGE} AS wheel-build
ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY apps/embedding/pyproject.toml apps/embedding/requirements-dev.lock ./
COPY apps/embedding/src ./src
RUN python -m pip install --no-cache-dir --require-hashes -r requirements-dev.lock \
    && python -m build --wheel --no-isolation --outdir /wheels

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VK_DRIVER_FILES=/opt/runtime/radeon_icd.json XDG_CACHE_HOME=/cache \
    EMBEDDING_ENGINE_URL=http://127.0.0.1:8081
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY apps/embedding/requirements.lock ./
COPY --from=wheel-build /wheels /wheels
COPY --from=engine-build /build/bin/ /opt/runtime/
COPY --from=engine-build /src/LICENSE /opt/metadata/llama-LICENSE
COPY deploy/engine-entrypoint.py deploy/embedding-entrypoint.py /stack/
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
    && python -m pip install --no-cache-dir --no-deps /wheels/*.whl \
    && rm -rf /wheels \
    && cp /lib64/ld-linux-x86-64.so.2 /opt/runtime/ld-linux-x86-64.so.2 \
    && ln -s libggml-cpu.so /opt/runtime/libggml-cpu-haswell.so \
    && cp /usr/share/vulkan/icd.d/radeon_icd*.json /opt/runtime/radeon_icd.json \
    && mkdir -p /models && chmod 700 /models
# Existing engine policy: root owns the private model volume; Compose drops ALL caps.
USER 0:0
VOLUME ["/models"]
EXPOSE 8080
ENTRYPOINT ["python", "/stack/embedding-entrypoint.py"]
# No .env/user credentials/model content copied; one in-memory gateway worker.
CMD ["uvicorn", "ams_embedding.app:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log", "--log-level", "warning"]
