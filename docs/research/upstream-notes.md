# 固定上游与保留调研

本项目保留权重、native构建资产、测试证据及必要公开文档。日常启动见[部署说明](<../deployment.md>)，直接使用预构建引擎；`python3 scripts/prepare-embedding.py`仅供维护者校验并重新组装引擎。GGUF和运行数据放data目录，native构建资产不入Git。

## 固定版本

- OpenViking v0.5.0：commit `20f9c11362ad16193b0daa4a414e1095061af427`，GHCR index `sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf`。保留[registry index](<../evidence/ghcr-v0.5.0-manifest.json>)、[amd64 manifest](<../evidence/ghcr-v0.5.0-amd64-manifest.json>)及[image config](<../evidence/ghcr-v0.5.0-amd64-config.json>)。
- llama.cpp b11429：commit `d81235049384534c167caea52b85a694f6103d14`。90项native ELF闭包的大小/hash见[运行清单](<../../deploy/embedding-engine/runtime-manifest.json>)；[配方](<../../deploy/embedding-engine/Dockerfile>)、ICD、device metadata和许可证在同目录。
- Qwen3 Embedding0.6B Q8：revision `370f27d7550e0def9b39c1f16d3fbaa13aa67728`、1024维，固定[模型manifest](<../evidence/qwen3-model-manifest.json>)与[模型卡](<qwen3-model-card.md>)。GGUF保存于项目`data/models`，闭包保存于`.runtime/embedding-engine`。

## 下一步OAuth开发会用到的公开资料

以下正文快照采集于2026-10-14，保留研究时证据；真实联机开发仍按官方文档核验当下契约。

| 官方资料 | 本地正文 |
|---|---|
| [Overview](https://developers.openai.com/siwc/token-sharing-open-source) | [快照](<siwc/siwc-overview.txt>) |
| [Quickstart](https://developers.openai.com/siwc/quickstart) | [快照](<siwc/siwc-quickstart.txt>) |
| [Registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | [快照](<siwc/siwc-sign-in.txt>) |
| [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) | [快照](<siwc/siwc-token-reference.txt>) |
| [Models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | [快照](<siwc/siwc-models-and-inference.txt>) |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | [快照](<siwc/siwc-preview-limitations.txt>) |
| [Profiles/sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | [快照](<siwc/siwc-profiles-and-sessions.txt>) |
| [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | [快照](<siwc/siwc-self-hosted-vms.txt>) |
| [GPT-6 Luna模型卡](https://developers.openai.com/api/docs/models/gpt-6-luna) | [快照](<siwc/model-gpt-6-luna.txt>) |

关键结论：独立SIWC grant使用实际issued client_id与稳定host ID，不复制Codex token；实际granted scopes和真实JWKS/nonce/audience必须验证。Responses固定store:false/stream:true；函数使用namespace；完整历史与失败终态不能丢。实际模型slug由同grant的账户目录与probe确定。

## OpenViking核对结论

- 启动参数是`--without-bot`；HTTP/MCP/Studio共用1933。Root用于账户管理，普通user key用于内容/session/find。
- ready只证明provider初始化，不能代替LLM/Embedding与记忆闭环验收。
- 默认本地向量库是flat/flat_hybrid、CPU索引；本地Embedding GPU与索引不是同一组件。
- query_param只传方向，不加Qwen文本指令；原生max_input_tokens是启发式截头。正式配置/精确校验由[当前架构](<../architecture.md>)约束。
- 任务accepted后须查询task_id终态与内部失败；没有通用retry；身份、完整state和隐藏.ovgit都在冷备份范围。
- 原生Codex adapter不是当前独立SIWC adapter的替代：工具结构和failed/EOF处理存在不同契约。原始源码副本已丢弃，需要时按上述固定commit重新获取。

## 实测证据

- [总览](<../evidence/original-engine-benchmark.json>)。
- [native CPU/GPU原始结果](<../evidence/embedding-results.json>)。
- [Docker CPU/GPU原始结果](<../evidence/docker-embedding-results.json>)。
- [临时engine鉴权测试](<../evidence/network-auth-results.json>)。

这些是原始engine选型证据；Python查询前缀网关的当前行为由自身测试验证，真实GPU/OV闭环按[实施计划](<../implementation-plan.md>)执行。
