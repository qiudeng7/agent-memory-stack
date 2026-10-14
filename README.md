# agent-memory-stack

为个人 agent 提供记忆服务：OpenViking 管理记忆，Python 服务连接本地 Embedding 引擎，NestJS 适配 LLM。

**当前为开发基线，尚不能完成记忆闭环。** LLM provider 仍为 `disabled`，真实 OAuth 登录和推理未接通；OpenViking 会等待 LLM 就绪。镜像发布成功不代表这些能力已经可用。

## 快速开始

需要 Linux amd64 / AVX2、Docker Compose，以及 OpenSSL、tar、sha256sum。GPU 模式需要可用的 Vulkan render 设备，也可切换 CPU。

从 [Releases](<https://github.com/qiudeng7/agent-memory-stack/releases>) 下载 `agent-memory-stack-deploy.tar.gz`；未打版本标签时，从对应成功的 [Actions](<https://github.com/qiudeng7/agent-memory-stack/actions>) 运行下载部署 artifact 并解开外层 ZIP。不需要 clone 源码、安装开发环境或导入离线镜像。

首次部署到尚不存在的目录：

```sh
mkdir -p ~/deploy
mkdir ~/deploy/agent-memory-stack
# 在下载文件所在目录执行：
tar -xzf agent-memory-stack-deploy.tar.gz -C ~/deploy/agent-memory-stack
cd ~/deploy/agent-memory-stack
sha256sum -c SHA256SUMS
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
# 将生成值填入 .env 的 AMS_MASTER_KEY；不要公开该值。
# 无 GPU 时同时设置 EMBEDDING_GPU_LAYERS=0、RENDER_DEVICE=/dev/null。
docker compose pull
docker compose up -d
docker compose ps
```

四个镜像从公共 GHCR 在线拉取，部署包按 digest 固定版本。模型首次启动自动下载并校验，数据保存在 Docker named volumes。LLM 健康地址为 `http://127.0.0.1:1455/health`；目前 `/ready` 返回 503，OpenViking 等待就绪是已知状态。

日常在部署目录执行 `docker compose pull`、`docker compose up -d`、`docker compose down`。**不要使用 `down -v`，它会删除持久数据。** 升级需先换用新版部署包的 digest，单独 `pull` 不会升级固定版本。

## 相关文档

- [部署指南](<docs/deployment.md>)：首次配置、CPU 切换、升级、备份及镜像发布。
- [贡献指南](<CONTRIBUTING.md>)：源码开发、测试和本地构建。
- [架构](<docs/architecture.md>)：服务边界、密钥与持久化。
- [实施计划](<docs/implementation-plan.md>)：后续 OAuth 联机和记忆闭环。
- [验证记录](<docs/verification.md>)：实际执行结果；旧引擎性能不是新 Mesa 镜像的验收结果。

## 许可证

源码许可证尚未选择，保留 `UNLICENSED`；公开仓库不等于授予开源许可证。OpenViking 及镜像中的第三方组件遵循各自许可证，分发时仍须履行相应义务。
