# Build the fixed upstream revision in CI; no local native image or runtime tree.
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce
FROM ${PYTHON_IMAGE} AS build
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

FROM ${PYTHON_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers libgomp1 ca-certificates
COPY --from=build /build/bin/ /opt/runtime/
COPY --from=build /src/LICENSE /opt/metadata/llama-LICENSE
COPY deploy/engine-entrypoint.py /stack/engine-entrypoint.py
RUN cp /lib64/ld-linux-x86-64.so.2 /opt/runtime/ld-linux-x86-64.so.2 \
    && ln -s libggml-cpu.so /opt/runtime/libggml-cpu-haswell.so \
    && cp /usr/share/vulkan/icd.d/radeon_icd*.json /opt/runtime/radeon_icd.json \
    && mkdir -p /models && chmod 700 /models
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 VK_DRIVER_FILES=/opt/runtime/radeon_icd.json XDG_CACHE_HOME=/cache
EXPOSE 8080
ENTRYPOINT ["python", "/stack/engine-entrypoint.py"]
