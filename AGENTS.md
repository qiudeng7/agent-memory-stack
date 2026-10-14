# Agent Memory Stack 开发约束

- 中文文档。NestJS LLM适配器用Node24/pnpm11/TypeScript严格ESM；Embedding服务用Python/FastAPI/httpx，保持各自生态。
- 只设apps/llm-adapter与apps/embedding两个应用。OAuth/protocol/common是Nest应用内部模块，不为辅助函数过细拆包。Node跨包依赖若将来确有需求，必须声明workspace:*并以包名导入，禁止跨包src相对路径。
- 只发布LLM Adapter和Embedding Service两个自有镜像。Embedding镜像包含Python网关与llama.cpp子进程；OpenViking直接使用固定官方镜像，不维护或发布派生镜像，不把底层推理引擎拆成独立部署服务。
- 运行用户只需compose.yml、.env.example、ov.conf部署包；不依赖源码/build/setup/宿主UID。数据使用Docker named volumes，首次模型准备内置引擎镜像。不要重新引入profiles、多份CPU override或日常native runtime准备步骤。
- 默认LLM provider disabled。测试只能使用合成fixtures、独立tmp及内存HTTP注入，不读取用户Codex/OAuth/key，也不发收费请求。真实OAuth/推理/正式部署需用户明确授权。
- OAuth access/refresh token、auth code、state、nonce、PKCE verifier、提示词/记忆正文不得出现在日志、Git或测试快照中。
- Responses未收到完整completed、存在failed/incomplete/未知终态，不得返回成功partial；不自动切付费后端。
- Embedding保存完整维数、校验L2/有限值，以同一模型tokenizer校验最终文本；拒绝截断标记和超预算，不静默截头。
- 只读原始日志、普通user key/内部Gateway key/ROOT admin key分离；禁止给容器或WebUI挂Docker socket。
- 用户已明确授权qiudeng7/agent-memory-stack公开仓库、Actions发布GHCR及~/deploy/agent-memory-stack本机部署。其它remote/发布目标仍须授权；许可证暂未决定，root package为UNLICENSED。不得代填用户OAuth凭据或发起登录。
- 设计在docs/architecture.md及ADR；执行验证在docs/verification.md；实际代码和测试为当前事实。不要在README塞任务流水账。
- 单实例凭据owner；扩多实例需额外锁/refresh设计，不能靠单进程Promise锁宣称跨实例安全。
- 验证命令：pnpm typecheck、pnpm test、pnpm build。文档改动需独立冷读与链接检查。
