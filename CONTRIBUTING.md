# 开发与验证

## 开始贡献

在 [GitHub Issues](<https://github.com/qiudeng7/agent-memory-stack/issues>) 讨论功能或边界变更；小型修正可直接提交 PR。PR 说明改动目的、实际执行的验证、未执行项及原因，关联已有 Issue。不要在公开讨论中贴真实凭据或用户数据。

本项目保持两个应用：NestJS LLM Adapter 与 Python Embedding Service。Node 使用 pnpm workspace，Python 使用独立项目和依赖锁。应用内部辅助逻辑不拆公共包，不跨包 import src；确需共享 Node 包时，先说明需求，再用 `workspace:*` 和包名。模块边界见[架构](<docs/architecture.md>)。

## 开发环境

安装 Node 24、pnpm 11（版本见根 [package.json](<package.json>)）、Python ≥3.11。以下命令均在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
# 上述三项检查也可用 pnpm check

python3 -m venv apps/embedding/.venv
apps/embedding/.venv/bin/python -m pip install --require-hashes -r apps/embedding/requirements-dev.lock
apps/embedding/.venv/bin/python -m pip install --no-deps --no-build-isolation -e apps/embedding
pnpm test:python
python3 -m unittest discover -s scripts -p 'test_*.py'
```

Node 测试使用协议 fixtures 和 Nest HTTP 注入；Python 使用 ASGI/HTTP mock 与私有临时文件。离线测试不需要 GPU、OpenViking 或真实账号。锁更新从项目依赖声明解析并保留 hash，不从已有 venv 抄绝对路径。

`python3 scripts/setup.py` 仅为源码开发可选的主密钥配置生成器，不是部署前置；已有配置原样保留。不要读取用户 Codex auth、真实 `.env` 或 token 来补全测试。

## 本地镜像构建

需要 Docker Compose。以下配方只构建本地开发标签，不发布 GHCR：

```sh
docker compose --env-file .env.example -f deploy/build.compose.yml build
# 仅用于静态检查的合成主密钥，不可用于真实部署：
AMS_MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000000 docker compose --env-file .env.example config --quiet
AMS_MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000000 EMBEDDING_GPU_LAYERS=0 RENDER_DEVICE=/dev/null docker compose --env-file .env.example config --quiet
```

引擎在 Docker 构建中编译固定 llama.cpp commit `d81235049384534c167caea52b85a694f6103d14`，使用 Debian trixie Mesa 包；不依赖本机 native image 或 runtime 目录。构建需要访问上游源码及软件包源。旧 RX570/native 引擎性能不能作为这份 Mesa 镜像的 GPU、性能或完整链路验收。

正式镜像由 Actions 测试、构建和推送，再按四个镜像 digest 生成部署包，见[发布流程](<docs/deployment.md#维护者发布流程>)。必要时，维护者下载同一次运行的四个 `image-*` artifacts，保留各自目录，再执行：

```sh
python3 scripts/package-deployment.py --references /path/to/downloaded-artifacts
```

打包器只生成配置包，不构建、推送、登录或启动服务；已有输出会被拒绝，可用 `--output-dir` 指定新目录。终端用户不需要运行它。

## 按改动选择验证

| 改动 | 最低验证 |
|---|---|
| Node 模块 | typecheck、相关离线测试、build |
| OAuth/协议安全边界 | token/nonce/state/scope、重放、取消、并发、终态及权限 fixtures；真实流程须单独获授权 |
| Python 服务 | hash-lock 依赖安装、Python 测试；检查 body/token/cache/取消/权限边界 |
| Docker/Compose | 构建、静态 config、隔离短期容器 health/ready；不冒充真实 OV 闭环 |
| 文档 | 本地链接检查、独立冷读；区分设计、实现与实测 |

Nest 12.1.3 缺失的 rxjs peer 在 [pnpm-workspace.yaml](<pnpm-workspace.yaml>) 用 `packageExtensions` 固定；升级时验证能否移除，不用 root hoist 或修改 node_modules 修复。

## 安全与交付

- 新测试只使用合成 fixtures 和独立临时目录；清理前核对绝对路径及归属。
- 不记录真实 OAuth token/code/state/verifier、提示词或记忆正文；真实配置、用户数据和 runtime 不进 Git。不要打印带凭据的完整 Compose 配置。
- 单元测试不执行 OAuth、付费推理或既有部署操作；联机测试须单独获授权、固定额度、隔离 state，并记录未执行项。
- 协议失败、取消或不完整终态不得返回 partial 成功；模型、namespace、tokenizer、pooling 或 query 政策变更须更新 fixtures 和版本记录。
- PR 合并、镜像发布与运行验收是不同步骤。发布到公开仓库和 GHCR 已获授权，但源码许可证仍为 `UNLICENSED`，不能自行改选许可证；第三方分发义务仍须核对。
