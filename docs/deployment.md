# 部署与镜像发布

运行用户只需部署包和在线镜像，不需要源码、Node、pnpm、Python、setup 脚本或离线镜像导入。环境要求：Linux amd64（x86_64）/ AVX2、Docker Compose、OpenSSL、tar、sha256sum；GPU 模式还需 Vulkan render 设备，CPU 模式无需 GPU。

## 首次部署

1. 从 [GitHub Releases](<https://github.com/qiudeng7/agent-memory-stack/releases>) 下载 `agent-memory-stack-deploy.tar.gz`。未打版本标签时，从对应成功的 [Actions](<https://github.com/qiudeng7/agent-memory-stack/actions>) 运行下载部署 artifact，并先解开下载的外层 ZIP。
2. 在新目录解压并检查校验清单。以下在下载文件所在目录执行；若目标已存在，不要覆盖，先按后文升级流程处理。

```sh
mkdir -p ~/deploy
mkdir ~/deploy/agent-memory-stack
tar -xzf agent-memory-stack-deploy.tar.gz -C ~/deploy/agent-memory-stack
cd ~/deploy/agent-memory-stack
sha256sum -c SHA256SUMS
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

3. 将生成的 64 位 hex 字符串填入 `.env` 的 `AMS_MASTER_KEY`，替换模板占位。若管理员已准备好现场配置且该值留空，直接填写，不要再次复制模板覆盖配置。不要把密钥发给他人。
4. 默认使用 RX570 GPU。无 GPU 主机将 `EMBEDDING_GPU_LAYERS=0`、`RENDER_DEVICE=/dev/null`；同机仅切 CPU 时只需前者。
5. 在部署目录启动：

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f
```

部署包包含 [Compose 配置](<https://github.com/qiudeng7/agent-memory-stack/blob/main/compose.yml>)、[环境模板](<https://github.com/qiudeng7/agent-memory-stack/blob/main/.env.example>)、[OpenViking 配置](<https://github.com/qiudeng7/agent-memory-stack/blob/main/ov.conf>)，另带部署说明、镜像清单 `images.json` 和校验清单 `SHA256SUMS`。三个容器分别使用自有 LLM、Embedding 镜像和官方 OpenViking 镜像，引用均固定 digest，不需填写镜像标签或执行 `docker load`。主密钥是用户必须填写的值。

Embedding 镜像负责设备访问和模型准备：首次启动从 Hugging Face 下载固定 revision 的约 639MB 模型，校验长度和 SHA256 后启用，以后复用模型卷并在启动时核验。需能访问 Hugging Face 及其 HTTPS 下载域名。单次下载期限为 30 分钟；Python 网关可以先变为 `healthy`，而模型尚未就绪。进度与故障查看 `docker compose logs -f embedding`，失败不会启用损坏模型。

`/health` 仅表示进程健康，不表示推理就绪；在部署目录检查 Embedding `/ready`：

```sh
docker compose exec embedding python -c "import http.client; c=http.client.HTTPConnection('127.0.0.1',8080,timeout=5); c.request('GET','/ready'); print(c.getresponse().status)"
```

200 表示后端就绪，503 表示仍未就绪；结合 Embedding 日志排查。Compose 在 Embedding health 通过后启动 OpenViking 容器，其入口再等待两个适配服务 `/ready`，然后运行官方入口。

当前 LLM provider 为 `disabled`（LLM `/health` 返回 200、`/ready` 返回 503），因此 OpenViking 会继续等待，1933 暂无应用响应。

## 日常操作与升级

以下命令均在部署目录执行：

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f
docker compose down
```

**正常停止使用 `down`，不要加 `-v`：`down -v` 会删除持久数据卷。** 修改环境后使用 `up -d`，而不是 `restart`，使 Compose 重建受影响容器。缓存默认 256MiB，可设置 `EMBEDDING_CACHE_MIB`。

镜像按 digest 固定，单独 `pull` 不会自动升级。升级时先备份，将新版部署包解压到独立临时目录并校验，比较配置后更新部署目录中的配置和三个镜像引用；保留现有主密钥及需要的设备设置，不直接覆盖私有配置。再执行 `pull` 和 `up -d`。从旧四容器版本升级时使用 `docker compose up -d --remove-orphans`，清除本项目已退役的独立引擎容器，避免它继续占用GPU。保留旧配置用于回退；若上游改变数据格式，先在备份副本验证兼容性。

仅 localhost 的 1455（LLM）和 1933（OpenViking）开放；Embedding 无宿主端口，内置 llama.cpp 仅监听容器内 `127.0.0.1:8081`。OpenViking 就绪后才提供 `/studio/` 和 `/mcp`。

## 密钥、数据与备份

一个随机主密钥按用途派生内部服务的 data/admin、engine 和 OpenViking Root key；主密钥本身不是 Bearer key。**这是单用户、同信任域部署**：三个容器和 Docker 管理员都能取得主密钥，不能把用途派生当作跨容器隔离。普通 agent/MCP 使用 OpenViking user key，不使用主密钥。不要公开私有配置或带凭据的完整 `docker compose config` / `inspect` 输出。轮换主密钥须协调重建全部服务并更新使用旧派生 key 的客户端。

| 默认 named volume | 内容 |
|---|---|
| `agent-memory-stack_models` | 挂载到 Embedding 的 GGUF 模型及下载锁 |
| `agent-memory-stack_oauth` | LLM OAuth 持久目录（联机接入后使用） |
| `agent-memory-stack_openviking` | OpenViking 完整持久数据 |

Docker 和镜像负责目录权限，不需宿主 UID/GID 或手工建数据目录。不要更改 Compose 项目名来“重启”，否则会使用另一组卷。

备份前停止写入、等待任务结束并执行 `docker compose down`，再用 Docker 卷备份工具完整保存三个卷以及私有配置；凭据备份应加密。运行中直接复制卷不是一致冷备份。迁机时恢复相同主密钥、项目名和卷，再在线 `pull`、`up -d`；无需携带源码或 native runtime。先在独立副本验证恢复，过期 OAuth 凭据需重新授权。

旧版宿主数据目录与多 key 配置不会自动迁移或删除。有旧数据时先冷备份，再分别恢复到对应卷；模型/OpenViking 使用 root，OAuth 使用 UID1000、目录 0700/文件 0600。不要把新建空卷误认为旧记忆丢失。

## 维护者发布流程

源码仓库为 [qiudeng7/agent-memory-stack](<https://github.com/qiudeng7/agent-memory-stack>)。[发布 workflow](<https://github.com/qiudeng7/agent-memory-stack/blob/main/.github/workflows/publish.yml>)在 push 到 `main`、推送 `v*` 标签或手动 `workflow_dispatch` 时执行测试，然后仅以 `llm`、`embedding` 两项矩阵构建并推送 Linux amd64 镜像：

- `ghcr.io/qiudeng7/agent-memory-stack-llm`
- `ghcr.io/qiudeng7/agent-memory-stack-embedding`

OpenViking 直接使用官方固定引用，不构建或发布自有 OpenViking 镜像：

```text
ghcr.io/volcengine/openviking:v0.5.0@sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf
```

两个自有镜像带 `sha-<完整 commit>` 及对应 branch/tag 标签。工作流收集 `image-llm`、`image-embedding` artifacts，将两个自有 GHCR digest 与官方 OpenViking digest 写入部署包的 `images.json`，并生成固定引用的配置；`v*` 标签额外上传为 Release asset。底层引擎包含在 Embedding 镜像中，不单独发布。

**首次发布后验证两个自有镜像及官方引用能否匿名拉取，不以 push 成功推断可见性。** 已公开的镜像无需填写 GitHub Token。若新 package 匿名拉取被拒绝，owner 在 GitHub 个人 Packages 页面进入 package settings，将 visibility 改为 Public 后再验证；工作流不调用不存在的 REST visibility 更新接口。

Embedding 内编译固定 llama.cpp commit `d81235049384534c167caea52b85a694f6103d14` 并使用 Debian trixie Mesa 包，不依赖本机旧镜像或 runtime。该引擎构建已有 CI 基线；合并后的 Embedding 镜像仍需单独验证进程生命周期、GPU 可用性及实际性能。

公开仓库与镜像发布已获授权；源码许可证尚未选择，保持 `UNLICENSED`。公开访问不等于授予源码开源许可证；分发 OpenViking、llama.cpp、Mesa 等组件时仍须履行其许可证和对应源码等义务。
