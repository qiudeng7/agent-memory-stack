FROM scratch
COPY runtime/ /opt/runtime/
COPY runtime/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --chmod=0644 radeon_icd.json /opt/runtime/radeon_icd.json
COPY amdgpu.ids /usr/share/libdrm/amdgpu.ids
COPY runtime-manifest.json llama-LICENSE /opt/metadata/
ENV LD_LIBRARY_PATH=/opt/runtime GGML_BACKEND_PATH=/opt/runtime/libggml-vulkan.so VK_DRIVER_FILES=/opt/runtime/radeon_icd.json XDG_CACHE_HOME=/cache
EXPOSE 8080
ENTRYPOINT ["/opt/runtime/llama-server"]
