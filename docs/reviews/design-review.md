# 独立设计与文档审阅

> 历史P0审阅记录。随后部署已简化为根Compose、单.env和data目录；以下多secret/override/profile相关判断只代表当时版本，当前操作以[部署说明](<../deployment.md>)为准。旧操作命令已移除，避免误用。

## 结论

**冻结版文档可以作为“具体方案 + P0 本地开发基线说明”交付，本审阅范围内没有剩余文档阻断问题。** 已定向读取最新修复与回归测试，文档描述和这些静态事实一致；完整安全代码复核由主任务的另一审阅路线负责。本结论不是真实授权/推理、四服务部署、逐行代码安全审计或记忆质量验收通过。

仓库遵守两个自有应用的边界：NestJS 独立 OAuth/LLM 适配，Python Embedding；没有为了四进程拆成四套业务包。P0 的安全默认、实现程度和未执行项目写得明确。首次冷读发现的 OV 操作指南缺口，在主任务补充部署 API 表及固定上游文档链接后已消除；下面保留原冷读记录，避免把后补信息冒充第一次已经读懂。

本审阅者未参与写作，不修改源码或交付文档、不发布、不再委派。唯一新增文件是本报告。

## 一、第一次冷读：仅依据六份文档及已有链接

范围为 [README](<../../README.md>)、[CONTRIBUTING](<../../CONTRIBUTING.md>)、[架构](<../architecture.md>)、[实施计划](<../implementation-plan.md>)、[部署](<../deployment.md>)、[验证报告](<../verification.md>)，以及当时链接的[既有 engine 指标](<../evidence/original-engine-benchmark.json>)。当时部署文档尚无 API 表，验证报告仍把短期镜像启动和 Compose 静态配置列为待验证。

### 1. 现在能运行什么？首次运行怎样判断成功？能直接用 Luna 提取吗？

**答案：不能直接用 Luna 提取。** 当前可以安装、编译和运行离线测试，启动 Nest HTTP 骨架，构建两个应用镜像。Python 网关的前缀、预算、缓存、后端 HTTP 与鉴权已有实现，但真实新网关与 GPU/OV 闭环尚未验证；真实 ChatGPT transport 和验签器没有绑定。

首次开发运行在仓库根：

```sh
pnpm install --frozen-lockfile
pnpm check
python3 -m venv apps/embedding/.venv
apps/embedding/.venv/bin/python -m pip install --require-hashes -r apps/embedding/requirements-dev.lock
apps/embedding/.venv/bin/python -m pip install --no-deps --no-build-isolation -e apps/embedding
pnpm test:python
pnpm start:llm
# 另一终端
curl --fail http://127.0.0.1:1455/health
```

前置为 Node 24、pnpm 11.24、Python ≥3.11；离线测试不依赖 GPU、OV 或账号。预期检查通过，health 返回 ok、ready 返回 503；未配服务 key 的受保护接口失败关闭。配置了本地 data/admin key 也不能使尚未绑定的 provider 可用。

依据：[README:5–32](<../../README.md#L5-L32>)、[架构当前状态:37–52](<../architecture.md#L37-L52>)。Luna 的公开卡片不证明账户权限，必须独立授权、发现实际 slug 并 probe，见 [README:44–46](<../../README.md#L44-L46>)。

**评价：清楚，无缺口。** 503/501 被明确解释为边界，不是匿名代理或已可提取。

### 2. 为什么两个应用、四个容器？Node/Python 依赖怎样组织？

自有应用只有 LLM Adapter 与 Embedding Service；四进程另包括上游 OpenViking 与 llama.cpp engine。上游负责记忆存储/执行工具与本地向量计算，不应变成本仓库复制维护的业务代码。

Node 是唯一 pnpm workspace 应用，运行依赖放应用自己的 package，根脚本以 filter 调度。OAuth/protocol/common 属于 Nest 内部模块；真实出现共享消费者后才讨论 `workspace:*` 与包名导入，不跨包导入 src。Python 使用独立 pyproject、venv 和带 hash 的运行/开发锁，不伪装成 Node 包。

依据：[架构:3–35](<../architecture.md#L3-L35>)、[CONTRIBUTING:5–23](<../../CONTRIBUTING.md#L5-L23>)。

**评价：理由、边界和维护规则都明确。**

### 3. 真实 OAuth 下一步有什么安全与授权门槛？reasoning 到哪里？

实现顺序为：绑定固定 loopback callback → 创建 RAM state/nonce/PKCE 事务 → 官方浏览器授权与实际 issued client_id → 单次 state 消费、code exchange、真实验签/标准 claims/实际 scope 检查 → 原子保存独立 profile → 同一 grant 模型发现与受控工具 probe → 选择稳定 alias → ready 后才允许 OV 写入。

还须实现可信官方 metadata/token transport、JOSE/JWKS 校验和 Responses 网络 transport，限制 HTTPS 目标、超时、响应与并发；不能让客户端任意指定 issuer/JWKS/token URL，不能根据 Host 构造 callback。单 owner、0600/0700、刷新 single-flight、rotation、invalid_grant 转 needs_login；不复用日常 Codex，也不自动切付费 key。

用户须先明确 eligible Plus/Pro、运行性质/许可证，批准独立登录及特定额度受限推理，在自己的浏览器完成授权而非把 token 发到聊天。缺 scope、身份变化、刷新、401/429/quota、断流/partial 等要独立验收。

当前只允许 `reasoning_effort:none` 的保守转换；reasoning output、正 reasoning token 数或未知 reasoning 事件失败关闭。先确认 none 模型是否满足质量；确有需要才增加 Nest 内部 lossless conversation bridge，绑定 profile/grant/model revision/完整前缀 digest，保存 encrypted reasoning 等原始 items。嵌入 SQLite 是方案，不是已交付功能。

依据：[架构 OAuth/路由:56–87](<../architecture.md#L56-L87>)、[协议/reasoning:89–106](<../architecture.md#L89-L106>)、[P1:16–29](<../implementation-plan.md#L16-L29>)、[P2:33–39](<../implementation-plan.md#L33-L39>)。

**评价：能确定下一步和停止条件；未实施 OAuth/reasoning bridge 不构成本次缺陷。**

### 4. Embedding 怎样避免 OV 先截？缓存、CPU、网络和权限怎样配置？

OV 的估计截头阈值提高至 1,000,000，由网关对正常 HTTP 输入裁决；网关限制 body 256KiB、拒绝已出现的 truncated 标记，query 加 Instruct/Query，document 不加。同一 engine tokenizer 检查最终文本 ≤2000，整批 preflight 后才 embed，验证完整 1024 维、有限值、L2 和索引；超长拒绝而非无损自动切片。正文建议约1536并留 header 空间，collector 后续精确分段保存原文/hash/span/manifest；OV 其他解析、摘要及 account override 仍需验收。

缓存为 RAM hash/vector/token/TTL，不持久保存原文；默认估算256MiB、1h，可调到1GiB。失败、取消、不完整批次不缓存；单 worker、一活动+16等待，总期限120s。CPU 回退保持相同权重与 profile，不为 CPU/GPU 切换重嵌；override 移除设备/group、禁 op offload、RAM上限8GiB并延长超时，持续采集用小 batch。

四进程共用专用 bridge；仅 LLM/OAuth loopback1455、OV loopback1933发布宿主端口，Embedding/engine 不公开。renderD128 只给 GPU engine。随机服务 key 为0600，Compose RUN_UID/GID 与准备者匹配，Python 镜像默认 UID10001 由 Compose 覆盖；不能 chmod644 绕过检查。秘密单文件替换后需受控 recreate，OAuth 目录 mount 允许原子 rotation。

准备与 CPU 示例见：

```sh
# 历史多文件初始化/CPU override命令已退役；使用部署说明中的setup与根Compose。
```

依据：[架构 Embedding:108–138](<../architecture.md#L108-L138>)、[部署/权限边界:140–157](<../architecture.md#L140-L157>)、[部署准备:9–70](<../deployment.md#L9-L70>)。

**评价：完整说明了防截边界，不误称配置本身证明全链路无损。** 网络配置仍可补充代理与 egress 的具体语义，见可选建议。

### 5. 怎样启动四进程、引导 account/user key、写读任务、重启和备份？前置是什么？

前置为独立本地服务 key、权限匹配的全新 state、审核过的 engine 镜像与 GGUF hash、真实 P1 授权/验签/模型与工具 probe 完成、两个 adapter ready 通过。随后 memory profile 启动四进程；P0 不应启动 OV 冒充可用记忆服务。

```sh
# 历史memory profile命令已退役；根Compose内OV入口等待adapter就绪。
```

Root 只用于引导 account，返回 user key 安全保存，harness/MCP/collector 用 user key 而非 Root/Gateway admin。写读验收要求 session→messages→commit→task 真终态→find→restart→restore；HTTP200/accepted 不证明提取成功，须检查内部失败，不能盲重提。冷备份先停采集/写入、drain task 与 refresh、停 OV/adapter，复制完整 state+配置/版本+独立 keys，加密并在副本恢复；旧 refresh token 因 rotation 可能失效，允许重新授权。

依据：[初稿部署§4、§5，最新对应位置:72–110](<../deployment.md#L72-L110>)、[架构数据与备份:159–175](<../architecture.md#L159-L175>)。

**首次冷读缺口：只有流程名称，不能回答具体 API 路径、身份 header、请求/响应、task 查询/失败处理，且无 API 文档入口。因此首次意见是“具体完整方案交付前补齐操作依据”，不是要求本次登录/部署。此问题已在后续修订中解决，见第三节。**

### 6. 哪些已测、哪些只是方案？下次按什么顺序？

初稿记录已测：`pnpm check`、106/106 Node 离线测试与构建；104/104 Python 离线测试（host Python3.14）、fresh hash-lock安装/依赖检查/wheel；两个应用 Docker build；OAuth mock、协议保护、真实 Nest controller 注入、Python ASGI/HTTP mock 和临时权限测试。旧 RX570 原生/容器 engine 数字只支持选型，不代表新 prefix/cache/OV 链路通过。

**首次冷读时，生产镜像短期启动/health 与 Compose 静态配置仍明确待验证，没有当作已执行。** 真实 Python3.11 pytest、新 GPU 网关、OV任务/权限/质量/忘记/重启/恢复、SIWC/JWKS/真实工具/quota/断流均未验收；collector、memoryctl、完整 reasoning bridge 是后续方案。

下一步：收尾 P0 实际运行证据 → P1 可信联机 OAuth/单模型/transport 与受控工具往返 → P2 新 state、真实 Embedding/GPU/CPU/OV多轮 fixture及小样本闭环/恢复 → 按需 reasoning bridge → P3 Python collector 与跨 harness 治理。不能跳过 P1 直接猜 Luna slug，也不先开新数据库或拆更多包。

依据：[最新验证报告](<../verification.md>)、[实施计划 P0–P3:7–48](<../implementation-plan.md#L7-L48>)、[旧 engine 指标的 notes:249–254](<../evidence/original-engine-benchmark.json#L249-L254>)。

**评价：阶段和证据层次清楚。** 上述通过数为主任务记录，本审阅者没有重跑。

## 二、只读事实核对

以下属于第二阶段核对，不倒推为第一次仅凭文档已经得到的事实。

| 核对主题 | 实现依据与结果 |
|---|---|
| 两应用/依赖 | [根 package](<../../package.json>)与[workspace](<../../pnpm-workspace.yaml>)只调度唯一 Node 应用；[应用 package](<../../apps/llm-adapter/package.json>)声明 Nest运行依赖；[Python项目](<../../apps/embedding/pyproject.toml>)与[运行锁](<../../apps/embedding/requirements.lock#L1-L35>)/[开发锁](<../../apps/embedding/requirements-dev.lock#L1-L55>)独立。检查过的导入没有跨应用 src。 |
| 首次 Node 运行 | [应用脚本:9–12](<../../apps/llm-adapter/package.json#L9-L12>)运行编译产物，README 先 check/build 再 start 的顺序正确；[main](<../../apps/llm-adapter/src/main.ts>)默认loopback1455。 |
| P0状态/角色 | [HTTP装配:114–164](<../../apps/llm-adapter/src/app.ts#L114-L164>)与[服务ready:55–70](<../../apps/llm-adapter/src/app.ts#L55-L70>)确实未装配联机provider，start/callback=501，ready=503，data/admin独立；未配admin key时start先鉴权失败，并非无条件501。 |
| OAuth证明边界 | [核心:157–262](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L157-L262>)消费state并要求注入验证结果证明；[mock verifier:69–84](<../../apps/llm-adapter/test/oauth/helpers.ts#L69-L84>)明确不做真实JWT校验；[scope常量:5–11](<../../apps/llm-adapter/src/oauth/security.ts#L5-L11>)请求openid/profile/email以及resource.invoke、chatgpt.tokens.use.direct、offline_access，后三项是实际grant必需检查；[刷新:267–323](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L267-L323>)single-flight、rotation与invalid_grant处理存在。 |
| Owner/文件安全 | [文件store:17–23](<../../apps/llm-adapter/src/oauth/file-store.ts#L17-L23>)明确只是单进程owner保护，不冒充跨实例锁；[文件检查/原子写:66–155](<../../apps/llm-adapter/src/oauth/file-store.ts#L66-L155>)、[服务secret:26–47](<../../apps/llm-adapter/src/common.ts#L26-L47>)匹配0600/0700与FD检查约束。 |
| 协议/reasoning | [请求转换](<../../apps/llm-adapter/src/protocol/request.ts>)使用namespace+name、文本/工具完整历史；[终态解析](<../../apps/llm-adapter/src/protocol/response.ts>)拒绝reasoning与不完整终态；[SSE:84–135](<../../apps/llm-adapter/src/protocol/sse.ts#L84-L135>)等待干净EOF，取消/期限不制造partial成功；[Nest测试](<../../apps/llm-adapter/test/app.test.ts>)为注入fixture，不是外网往返。 |
| Embedding | [配置profile](<../../apps/embedding/src/ams_embedding/config.py#L25-L54>)、[FrontDoor](<../../apps/embedding/src/ams_embedding/app.py#L25-L93>)、[service:120–214](<../../apps/embedding/src/ams_embedding/service.py#L120-L214>)分别落实固定identity/body/最终预算/批次/向量/缓存；[backend](<../../apps/embedding/src/ams_embedding/backend.py>)只对固定配置origin请求，禁止redirect、`trust_env=False`。 |
| OV 防截配置 | [OV配置:4–18](<../../ov.conf#L4-L18>)确有1M阈值、1024维、query/document、none/temperature0；只能证明配置存在，不能独立证明OV端真实解析与整链路无损。 |
| 四容器/CPU | 历史方案只有四服务，engine/memory profile和CPU override已随后移除；当前使用[根Compose](<../../compose.yml>)。本行保留初审背景，不视为新部署复核。 |
| 启动门槛 | 历史OV薄wrapper在exec上游前检查两adapter ready；随后按用户要求移除派生镜像，当前[根Compose](<../../compose.yml>)直接使用官方镜像并保留就绪等待的内联启动配置。 |
| 资产/镜像 | [准备工具](<../../scripts/prepare-embedding.py>)现校验项目内资产并同步公开构建元数据，不下载或读取认证；[模型manifest](<../evidence/qwen3-model-manifest.json>)的SHA与Pythonprofile匹配；[engine配方](<../../deploy/embedding-engine/Dockerfile>)是ELF闭包组装，文档未谎称全部源码可复现构建。 |
| Docker隔离 | [Node Dockerfile](<../../apps/llm-adapter/Dockerfile>)部署生产依赖；[Python Dockerfile](<../../apps/embedding/Dockerfile>)用hash锁/wheel、单worker、默认10001；[Docker忽略规则](<../../.dockerignore>)和[Git忽略规则](<../../.gitignore>)排除私有配置、state和大资产。 |

上述主要应用边界与配置和文档一致；这不等于所有代码安全边界已经审计通过。主任务修复的两个代码问题已纳入下节定向文档事实复核，不把另一代码审阅者的发现或结论算作本审阅发现。只读源码不能证明行为已实测；OV的实际协议、权限、质量与恢复仍按P2验证。

## 三、最新稿复核

主任务在首次反馈后补充内容，本节是同一审阅者的复核，不是第二次独立冷读。

### 已解决的交付问题

[部署:87–104](<../deployment.md#L87-L104>)新增独立验收account的完整API表：Root `X-API-Key`创建account并将返回user key保存0600；user key建session/追加消息；commit保存accepted/task_id；轮询任务和失败信息；find读取正文/来源/范围；重启与副本恢复。请求形状与预期状态区分开，并标注P1后执行、本次未运行OV或收费LLM，提供固定revision的上游账户、Sessions、Tasks、Retrieval文档入口。

因此初稿“只有名词、无法实施”的阻断意见已解决。恢复的精确override示例仍可进一步完善，但完整冷备份边界、操作顺序与不覆盖原目录的要求已经可以理解，不再把它判作P0方案阻断。

**核验限制：** 尝试读取固定上游API原文时，四个raw链接均因当前读取工具判定hostname解析为非公网IP而拒绝；未绕过限制。故本审阅确认API表的读者完整性，未独立确认其全部字段与固定上游实现相符。需主任务保留其固定源码核对依据，P2再验证真实请求。

### 新增证据的状态

[验证报告:11–12](<../verification.md#L11-L12>)现在记录两production镜像临时隔离启动以及GPU/CPU合并Compose静态通过，不再列待跑。读取了[镜像原始记录](<../evidence/image-smoke.json>)：两个image ID、health200、ready/models503、networknone、无宿主端口、非privileged，与[隔离验证脚本](<../../scripts/smoke-images.py>)的探测/断言相符。脚本使用只读根fs并在finally核对容器身份后停止。

冻结后重新读取[验证报告:8–24](<../verification.md#L8-L24>)与[镜像记录](<../evidence/image-smoke.json>)：Node记录更新为108/108、Python仍104/104，增加两个回归的发现/修正说明；Node image ID已更新，两个隔离镜像探测仍为health200、ready/models503。它们是主任务报告的实际测试/重建/探测记录，不是本审阅独立运行的结果。

审阅者未运行脚本、未启动容器，也未独立重跑Compose。Compose通过只证明静态配置，不证明secret挂载/GPU驱动/四服务实际ready，文档对此区分正确。Python3.11完整pytest与所有真实P1/P2项目仍明确待验证，见[未执行与待验证:30–32](<../verification.md#L30-L32>)。

### 冻结版定向文档事实复核

- **Headers阶段取消/超时：描述与代码一致。** [架构:96](<../architecture.md#L96>)不再仅描述SSE消费预算，而明确获取stream阶段也受deadline约束；清理不确定时暂停transport，不以简单race放行新的上游请求。[等待辅助:98–123](<../../apps/llm-adapter/src/common.ts#L98-L123>)race abort并处理迟到返回，[服务:78–110](<../../apps/llm-adapter/src/app.ts#L78-L110>)在持有串行slot时设置暂停、排队请求再次检查，ready也受暂停影响。[回归fixture:12–33](<../../apps/llm-adapter/test/regressions.test.ts#L12-L33>)检查504、abort、暂停、拒绝后续调用、迟到stream关闭与不自动恢复。文档没有把客户端取消吹成供应商停止计费。
- **未知subject授权与refresh串行：描述与代码一致。** [架构:75–77](<../architecture.md#L75-L77>)明确所有凭据变更全局串行、仅单owner；[授权:170–220](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L170-L220>)取得锁后再查到期，selected与无selected路径都用`credential-mutations`，[refresh:268–323](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L268-L323>)同一锁。[回归fixture:35–60](<../../apps/llm-adapter/test/regressions.test.ts#L35-L60>)覆盖旧refresh invalid_grant与同client无selected新grant的竞争。没有据此宣称跨实例安全。
- **Python预算歧义已消除。** [架构:130](<../architecture.md#L130>)现在明确body接收和后续排队/推理各120s、CPU各300s，而非整个HTTP总120s；与已读FrontDoor和service分别设timeout的行为一致。这是修正文档保证，不冒称新增了统一端到端deadline。
- **Owner例外已写清。** [架构:153](<../architecture.md#L153>)限定Node/Python匹配运行UID，OV官方root薄wrapper是0600普通文件的受控例外；与现有wrapper一致，不再引导读者把共享data key一律chown成root。
- **Compose/网络建议已采纳。** [部署:7](<../deployment.md#L7>)明确Compose≥2.24.4、本机验证版本、bridge允许出站、Python不自动继承代理、未来Node transport显式代理，以及不得把私有OAuth请求送公共下载加速器。无需额外服务或拆包。

这些定向阅读只确认文档与所读实现/测试形状一致；两回归“实际通过”的依据是主任务验证记录，完整安全审查和授权运行验收不由本报告代替。

## 四、剩余可选建议（不阻断本次交付）

1. **持续采集前固定身份约定。** 最新表已明确account/admin_user与普通user key；[架构:161–163](<../architecture.md#L161-L163>)说明稳定用户和按环境区分agent。P2/P3可再给一个固定上游支持的account/user/agent identity header示例，确认默认agent身份是否符合多harness隔离目标。不是要求本次实现collector。
2. **恢复演练可加最小override例子。** [部署:99–110](<../deployment.md#L99-L110>)已要求独立目录/端口副本；[Compose:100–107](<../../compose.yml>)仍固定1933和相对目录挂载。冻结稿已说明备份操作顺序，尚未给副本project名、全部state/key来源及替代端口的完整命令。将来补例子可降低误挂原workspace/原OAuth目录的风险；不要让“副本恢复”实际运行第二个共享凭据owner。

不要求为可选建议反复润色，亦不要求本次完成真实OAuth、reasoning bridge、部署或采集。

## 五、实际审查范围与未做事项

- 已加载软件工程工作流、technical-writing、writing-guidelines、README/CONTRIBUTING规范及对应问题模板；按先读者测试、再事实核对执行。
- 全文读取六份交付文档及[ADR](<../adr/0001-app-boundaries.md>)；在反馈修订后重新全文读取[README](<../../README.md>)、[部署](<../deployment.md>)与[验证报告](<../verification.md>)；读取三份公开本地evidence。六份初稿的本地文档入口均可读，最新新增的镜像记录也可读；主任务报告其本地链接自动检查通过，本审阅未另跑自动链接脚本。
- 读取根package/workspace/TypeScript配置、公共配置示例、ignore规则，Node应用package/tsconfig、Python pyproject、两份锁的开头，三个Dockerfile、两Compose、OV配置与wrapper，准备/测试入口/镜像smoke脚本。
- 读取Node HTTP/main/common、OAuth core/security/file-store、协议request/response/SSE及[validation](<../../apps/llm-adapter/src/protocol/validation.ts>)；全文读取Nest controller测试和OAuth mock helpers、三份Python ASGI/service/backend配置测试。冻结后重新读取架构/部署/验证报告及镜像记录、Node HTTP/common、OAuth core变更段和新增[两回归测试](<../../apps/llm-adapter/test/regressions.test.ts>)。未做所有模块与测试的逐行安全审计；未读取锁文件的全部hash条目。
- 没有读取私有运行配置、secret目录、持久数据目录或用户其他凭据；没有执行安装、测试、构建、Compose或服务启动；没有真实外网推理/授权，没有修改源码、原文档、远程仓库或发布资产。公开上游文档读取失败的环境限制已如实披露。
- 所有“已测”结论均区分主任务记录、现有evidence与本审阅静态核对；本报告不授予登录、收费请求、部署或发布权限。
