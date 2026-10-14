# 从开发基线到可用记忆栈

## 已确认范围

仓库名称agent-memory-stack，中文文档；NestJS维护独立OAuth/LLM协议适配，Embedding用Python与llama.cpp；不过细拆包；OpenViking只做锁定版本的上游服务配置。系统内存不作为省到极限的目标。当前仅本地Git，不默认建立远程仓库或选公开许可证。

## P0：可维护基线（本次交付）

- 真实pnpm workspace Node应用，内部OAuth/protocol/common模块；Python独立项目、带哈希的运行/开发锁。
- 安全默认：LLM disabled，网络OAuth和真实provider未绑定；不会导入Codex认证。两套data/admin key，parser错误不回显文本。
- PKCE/state/nonce、原子profile与刷新逻辑用mock测；文本与namespace function全历史转换、SSE完整终态保护；Python准确token、前缀、缓存/队列/向量验证用ASGI/HTTP mock测。
- 两个应用Dockerfile、四进程Compose方案、上游版本与模型hash锁，已有engine指标作为选型依据。

验收以代码/测试/镜像构建和独立审阅为准，记录于[验证报告](<verification.md>)，不把基础项目成功当成订阅可用。

## P1：真实SIWC授权与一个可用模型

按顺序实现，不拆新包或新服务：

1. Nest OAuth HTTP/CLI装配：先绑定固定loopback，再创建事务；Browser URL只给授权界面，不写应用日志；callback去重复param、消费state，code exchange。
2. 官方可信metadata/token transport，明确HTTPS allowlist/timeout/响应限制；采用真正JOSE/JWKS签名核验、issuer/aud/azp/exp/nbf/iat/nonce，不使用decode-only。真实verifier替换mock注入边界。
3. 配置自己的profile目录，保留host ID/client ID，单owner；refresh在开始推理前确认需要，single-flight旋转，invalid_grant转needs_login。Cookie/Codex auth都不作为后备。
4. 同一grant模型发现；将SIWC`models[].slug/display_name/visibility`与实际能力转成受控alias，不假定Luna权限。账户/grant变更使catalog与route能力失效。
5. 先选可关闭reasoning且支持所需functions的模型。限定输入、并发、超时、客户端byte/event预算；适配OV temperature=0/none/max_tokens行为。无硬输出token帽、无自动付费fallback。
6. 完成可信Responses HTTP transport，取消/timeout真正传到底层；根据真实SSE事件更新fixture，保留完整终态。合成失败注入必须先过，再做一次用户批准的额度受限推理与read-tool往返。

明确授权动作：用户确认eligible Plus/Pro、运行性质/许可证，以及允许独立SIWC登录和哪次推理；用户在自己的浏览器操作，不把token贴进聊天。没有这些信息不执行联机授权或收费请求。

**通过条件：**新grant独立于日常Codex、真实验签、受控真实模型/工具往返、缺scope/nonce错误/换账号/refresh rotation/401/429/quota/断流/partial失败均验证；只有完成结果返回200，quota暂停而不是切API key。

## P2：接OpenViking小样本闭环

- 准备新state，不覆盖旧部署；确认真实GGUF SHA与engine flags，然后走Python前缀网关的真实GPU/CPU、2000预算、缓存/方向隔离与取消测试。旧原生engine数字不能代替这个新链路。
- 从固定OV v0.5.0生成真实kwargs/tool schema fixture，测默认参数、schema、完整多轮消息；复杂schema或新事件不能为了“兼容”静默丢弃。
- root引导独立验收account，安全保存user key；session→messages→commit/task终态→find内容→重启→恢复。
- OV max_input_tokens=1M与网关256KiB/精确token拒绝的链路验收：普通长文本、罕见CJK/代码/大空白、生成摘要、OV已有truncated标记；不能仅测下游400。
- 若none模型质量不够或实际模型要求reasoning，再增加Nest内部conversation bridge（可嵌入SQLite），绑定profile/grant/model/revision/前缀digest、保存lossless output，包括encrypted reasoning。失效明确409，不能补猜旧reasoning或跨账户重用。

**通过条件：**写入可追溯、终态正确、召回事实/范围正确、修订/忘记可验证、冷备份恢复成功、partial没有落盘。真实质量集含中文、英文、代码、冲突、临时授权和忘记样本；不是只看模型有文字输出。

## P3：跨harness持续采集和管理

- Python collector工具以小batch精确切片，保留原文/hash/span/chunk manifest；宿主hook只写spool，bridge worker只读原日志，使用OV普通user key，无Docker socket。
- 至少一次投递、ACK丢失、断网/重启、失败重提及幂等验证。内部提取队列继续用OV，不再写另一套memory job DB。
- 薄memoryctl作为Nest应用的CLI/现有管理API客户端，不新增通用平台；显示effective config、model能力probe、task失败、备份/恢复、route revision。先复用Studio，不先做完整WebUI。
- 忘记的控制记录抑制旧history再生成；移除派生项与毁掉原始证据分开授权。

**通过条件：**多个harness身份稳定、权限范围一致、没有重复注入成为新证据，费用/用量可见，异常可恢复，模型变更有新profile/索引迁移和回滚。

## 暂不做

多租户SaaS、跨实例OAuth并发、Redis/Celery/独立数据库、任意provider自动切换、未经需求的共享npm包、把Embedding全部改成Nest、自动公开GitHub或发布镜像。

相关边界与接口：[架构](<architecture.md>)；准备及运行：[部署](<deployment.md>)。
