# Agent Memory Stack：具体系统方案

## 1. 这是两个应用，不是一堆公共包

这个仓库维护**独立 NestJS LLM Adapter**和**Python Embedding Service**。OpenViking与llama.cpp是锁定版本的上游进程，不是本仓库业务代码。

```text
harness agent ──用户key / MCP──> OpenViking
harness hook ──spool──> collector（后续Python工具）──用户key──> OpenViking

OpenViking ──/v1/chat/completions──> NestJS LLM Adapter
                                      ├─ OAuth登录/刷新/模型目录
                                      └─ ChatGPT SIWC /v1/responses

OpenViking ──/v1/embeddings──> Python Embedding Service
                                 ├─ 指令、精确token、缓存、队列
                                 └─ llama.cpp engine ──Vulkan──> RX570
```

自己维护的代码只有两个应用，部署为三个容器：LLM Adapter、Embedding Service、官方 OpenViking。Python 网关和 llama.cpp 引擎是同一 Embedding 容器内的两个子进程，不拆成独立部署服务。

```text
apps/llm-adapter/         # 唯一Node workspace应用
  src/app.ts             # Nest控制器、HTTP适配与运行装配
  src/common.ts          # 本应用鉴权、错误、队列等辅助逻辑
  src/oauth/             # OAuth内部模块，非独立npm包
  src/protocol/          # 协议内部模块，非独立npm包
  test/
apps/embedding/           # Python自己的pyproject、锁、测试、Dockerfile
  src/ams_embedding/
deploy/                   # 两个自有镜像的本地构建配方
scripts/                  # 开发检查与安全准备工具，不提供一套新平台
```

Node依赖声明在应用自己的package.json，根pnpm脚本通过`--filter @agent-memory-stack/llm-adapter`执行。应用内部使用相对模块导入；以后只有真实共享需求才建Node包，并使用`workspace:*`和包名导入。**不再跨包导入`../../../packages/.../src`。**Python不伪装成pnpm包，也不为了统一语言把Embedding重写成Nest。

## 2. 当前已经能做什么

当前是可运行、可测试的开发基线：

| 内容 | 当前状态 |
|---|---|
| Nest HTTP启动、独立data/admin鉴权、统一安全错误 | 已实现 |
| Chat→Responses文本/namespace函数转换、完整终态聚合 | 已实现并离线测试 |
| PKCE/state/nonce、独立文件profile、原子刷新/单owner | 已实现并注入mock验证 |
| 网络token exchange、真实JWKS验证、浏览器登录、账户模型发现 | **未绑定；HTTP登录路由明确501** |
| 生产LLM网络transport | **未绑定；provider默认disabled，ready/inference返回503** |
| Python指令/token预算/缓存/后端HTTP/鉴权 | 已实现并使用ASGI与HTTP mock验证 |
| 合并Embedding镜像及真实RX570/OV闭环 | 待运行验证；固定llama.cpp/Trixie Mesa的已有CI构建不是合并镜像验收 |
| collector、memoryctl、完整reasoning bridge | 后续按实际需要实现，不部署空壳服务 |

这里的OAuth核心并不是“JWT decode就相信登录”：它要求外部注入真正的验证器并提供签名/JWKS/算法/标准claims的验证结果，再检查issuer/audience/nonce/expiry/subject。当前没有该联机验证器，也不会读取日常Codex登录来补齐。

## 3. LLM Adapter 的内部边界

### OAuth与凭据

使用官方SIWC的独立应用授权，不复用现有Codex refresh token。一个服务实例拥有一个专用凭据目录；不同注册/账户用独立profile。

流程：

```text
管理员显式登录
  → listener已绑定127.0.0.1:1455/auth/callback
  → 新state + nonce + PKCE，保存短期RAM事务
  → 官方浏览器授权，取得实际issued client_id
  → state单次消费、code exchange、真实ID-token验证、实际scope验证
  → 原子保存整个凭据集
  → 同一grant发现模型、受控能力probe、管理员选alias
  → ready，才让OpenViking写入
```

首次使用`dynamic_agent_client`注册，但token交换必须用回调颁发的实际client_id；后续复用client_id和稳定host ID。首次交换失败后，用实际issued ID新建完整流程，不重放旧code/state。

profile至少记录issuer、subject、client_id、host_id、实际scopes、access/refresh/id token、expires_at、needs_login；目录0700，文件0600，原子replacement。refresh同profile single-flight；本单owner基线将所有授权/刷新凭据变更串行化，未知subject的新授权也不能绕过刷新锁。短暂失败不覆盖旧文件，invalid_grant暂停并要求重新登录，不自动切用户现有登录或付费key。pending登录只在RAM，重启后重新开始；profile与host ID持久化。

**单owner是明确运行约束。**不要给两个adapter实例挂同一目录来“提高可用性”；未来多实例需要真实分布式刷新协调。当前文件owner保护也不代替多实例设计。

联机实现还需要可信官方metadata/token transport和JWKS验证，不能由客户端传入任意issuer、token URL或JWKS URL。固定loopback外部地址与Docker内部监听地址分开，不能信任请求的Host/X-Forwarded-Host构造callback。

### 模型与请求路由

OpenViking只看稳定alias，例如`memory-default`。alias绑定已授权profile、实际账户模型slug、能力和配置revision；Luna完整slug由授权账户发现与真实probe决定，不在配置里猜权限。

MVP只接一个SIWC provider，不先做通用多供应商控制平台。模型目录可缓存，但重新授权、换账户或grant generation变化必须失效。运行中的请求固定route snapshot；后续请求才使用新revision。配额耗尽暂停，默认禁止付费fallback。

联机功能完成后才增加管理员接口：login/status/logout、模型发现/能力probe、alias切换。普通data key不能切模型、读token或调用OAuth管理。当前只有状态接口和明确未实现的start/callback，不把设计接口伪装成已实现。

### 协议转换：必须处理的不只是URL

- 入站OpenAI Chat Completions，出站SIWC公共Responses；`store:false`、`stream:true`，每次完整历史。
- system转developer/instructions，保留assistant/function/tool历史与call_id。
- 函数使用官方`namespace`容器；function_call的namespace与name是分开的字段，不拼成`openviking.read`。
- 工具只由OV执行；adapter不挂OV数据目录、不执行read/search/ls，不拥有OV Root key。
- 入站非流输出；上游SSE先缓冲，只有完整`response.completed/status=completed`且干净EOF才返回成功。delta后failed/incomplete/错误/未知输出/超时/取消全部失败，不能让partial写进memory。
- 字节、事件、时间、队列限制是客户端资源边界，不是服务端硬计费上限；取消也不保证供应商立刻停算。等待上游取得stream同样受deadline约束；若该阶段取消且底层清理无法确认，暂停transport、阻止排队/新请求继续调用，迟到stream尝试关闭，不自动解禁或重试。管理员须确认底层请求清理后再受控重启。
- OV的max_tokens/max_completion_tokens在SIWC不支持，显式不转发并在header报告。OV v0.5的`temperature:0`也只做明确兼容丢弃；其它temperature拒绝。`reasoning_effort:none`映射为Responses reasoning none；其它effort目前拒绝。
- P0文本/read-search-ls与有限schema支持已写；strict:true、强制tool_choice、复杂schema、图片、未知annotation/输出保守拒绝。**必须再用实际OV请求fixture和授权的真实tools往返检验，不能因50个合成协议测试就宣称全部OV兼容。**

### Reasoning：按需做，不先制造数据库

先验证Luna或其他账户可用模型是否能以none模式满足memory质量。若能，维持完整Chat历史的无状态转换即可，不必先做session数据库。

只有模型需要reasoning或实际质量要求时，再在Nest应用内部增加`conversation bridge`：绑定profile/grant generation/model revision/完整前缀digest，以tool-call ID关联原始Responses output items，包括encrypted reasoning；后续轮次lossless回放。不能只保存reasoning摘要或偷偷丢encrypted_content。

过期/身份不符/上下文变更时明确报conversation bridge失效，不跨账户重用。可使用嵌入式SQLite文件实现TTL记录，不另起数据库容器。**当前代码对任何reasoning输出失败关闭，没有完整reasoning支持。**

## 4. Python Embedding Service 的内部边界

固定profile包含GGUF SHA、engine revision、pooling=last、normalization=L2、维度1024、tokenizer/add_special、query instruction与pipeline revision。不能在同alias下静默换模型。

处理顺序：

```text
认证 → 256KiB body限制 → 严格JSON/字段/alias/方向
 → 拒绝上游truncated标记
 → query加Instruct/Query；document不加
 → 查完整pipeline+方向+文本hash缓存
 → 同一engine /tokenize 精确检查最终文本≤2000
 → 整批preflight通过后调用engine
 → 索引/维度/有限值/L2/usage验证
 → 构造全部结果、deadline复查
 → 原子写缓存、按原顺序返回
```

model的标称32K不决定本机服务预算：已有engine实测ctx2048只接受2047输入tokens，因此留2000上限、正文建议1536左右并留来源header空间。

缓存只在RAM保存hash/vector/token/TTL，不保存原始文本；默认256MiB估算、1h TTL，可以提高到1GiB，不为节省几十MB引入复杂持久缓存。相同并发请求通过单worker队列后复用结果；失败/取消/不完整batch不缓存。usage是逻辑输入token数，包含重复/缓存，不等于此次实际推理工作量。

一个活动请求+有限等待，默认等待16。Python的body接收与后续排队/推理分别有预算，应用默认各120s；统一Compose为两阶段各300s，不是整个HTTP生命周期只限300s。GPU正常短查询快，真正容易拖慢读请求的是后台大batch：collector默认用小batch，不把32条×2000tokens塞成常态。CPU回退调整engine/client timeout、减少batch；后续如需读优先，在同一Python服务内增加调度，不先起第二套队列。

Embedding 容器的 Python 小型 PID 1 管理 FastAPI 网关（8080）与 llama.cpp 子进程（仅 `127.0.0.1:8081`）：转发停止信号、回收子进程，任一子进程失败就终止另一个并退出，由容器重启策略恢复。模型下载、校验和设备访问由该镜像负责；首次下载与子进程启动最长等待 30 分钟。

`/health`只表示进程健康，不代表推理就绪；`/ready`验证engine健康与预期alias。下载进度和启动故障查看 `docker compose logs -f embedding`。模型内容由镜像内准备逻辑核验长度与SHA，pooling与召回正确性仍需实际GPU和OV联调。

### 怎样避免OV上游先截断

OV原生`max_input_tokens`是估计截头，不是精确分段。配置将其提高到1,000,000，把日常输入的长度裁决交给网关；网关的256KiB HTTP上限远低于这个估计阈值，正常接受的请求不会触发该估计裁剪。

极大输入若已在OV被截，标记仍会被网关拒绝；网关不能恢复丢掉的原文。超长任务因此会失败而不是无损自动成功，collector仍须精确分段、保留原文/hash/span/chunk manifest。账号override或其它OV解析/摘要路径另需验收，不把这项配置当全链路无损保证。

## 5. 部署与数据边界

三个容器的默认边界：

| 容器 | 访问权 | 持久化 |
|---|---|---|
| Nest LLM Adapter | 自己的OAuth目录；数据/admin服务key；外部Auth/Responses HTTPS | oauth卷：host ID/profile；将来按需bridge |
| Python Embedding + llama.cpp | 网关data/admin key、内部engine key；render设备；可写模型卷 | models卷：GGUF、下载锁；shader缓存可丢弃，原文/向量缓存不持久化 |
| 官方 OpenViking | 自己完整workspace、自己的Root key、网关data keys；无OAuth token | openviking卷：文件、向量、task、queue、identity等完整state |

同一专用bridge，只有LLM管理/OAuth loopback1455与OV loopback1933发布到宿主；Embedding不公开端口，llama.cpp仅监听同容器loopback8081。普通harness通过MCP/user key访问OV，不拿Root或Gateway admin key。

部署包与源码分离：三份运行配置加说明、镜像清单与校验值，无源码mount/build依赖。Actions只构建发布LLM和Embedding两个自有GHCR镜像；OpenViking直接引用官方`v0.5.0`，固定为：

```text
ghcr.io/volcengine/openviking:v0.5.0@sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf
```

部署包的 `images.json` 记录两个自有镜像digest与官方OV digest。Embedding内从固定llama.cpp commit `d81235049384534c167caea52b85a694f6103d14`编译引擎，使用Debian trixie Mesa包，不依赖旧本地native image/runtime。固定引擎构建已有CI基线，合并镜像的运行、GPU及性能验证单独记录。

三个named volumes仍为models、oauth、openviking；models现挂载到Embedding。镜像预设目录属主/权限，不要求填写宿主UID。Embedding保留root以访问既有模型卷和映射设备，同时`cap_drop: [ALL]`、`no-new-privileges`，不增加特权。镜像内准备逻辑以HTTPS下载固定模型，校验size/SHA后原子发布；已有模型每次核验，失败不覆盖旧文件。

.env只配置一个256bit随机主密钥（64hex字符）。Node/Python/入口按HMAC-SHA256(master原样UTF8, `agent-memory-stack/v1/<role>`)派生六角色key，输出64hex；roles为llm-data、llm-admin、embedding-data、embedding-admin、embedding-engine、openviking-root。主密钥大小写不归一化、不hex解码。无master时应用保留显式key/file开发兼容，混用明确报错。修改.env后compose up -d重建受影响容器。

这项简化将三个容器置于同信任域：每个容器及Docker管理员可读取master并派生其它角色；表中的访问权描述正常调用/挂载，不宣称密钥泄漏后的跨容器隔离。API仍区分角色，普通agent只拿OV user key。主密钥不当Bearer key、不写日志/镜像层；OAuth token仍仅存独立卷，不由master派生。多租户或强容器隔离须另用独立secret供应机制，不把主密钥方案冒充它。

OpenViking的启动配置由Compose内联Python脚本处理：从环境中的主密钥仅派生llm-data、embedding-data、openviking-root三个key，注入运行配置；先等待两个adapter的`/ready`，再exec官方entrypoint并传入`--without-bot`。这是启动配置，不是自有OV镜像或核心修改，也不挂载宿主脚本。Compose对Embedding仅依赖health，不把推理ready当容器启动条件；入口的ready门禁防止未就绪时写入失败。原生HTTP/MCP/Studio在门禁通过后启动；只读启动配置的保存与runtime/account overrides须区分。

有充足RAM，优先常驻模型与索引、留大缓存。统一Compose给合并Embedding容器8GiB上限，覆盖网关与CPU/GPU引擎，4GiB显存仍独立约束。容器limit不是预留；OV的规模内存按向量/原文与现有主机负载调整。

## 6. 原始history与后续collector

harness原日志为证据，OV为可重建派生层。后续collector仍用Python工具，不设新npm包，也不再造memory job DB：宿主hook写保护spool，bridge内worker只读日志、写自己的ACK/manifest并调用OV用户API。

session ID包含harness/installation/session，事件ID来自原offset/hash；区分用户声明、assistant推测、工具验证与旧memory注入。长期偏好用户ID稳定，agent经验按环境/用途区分。旧memory注入不再次当用户证据。

采集最多承诺至少一次投递；spool+ACK不能消除“服务成功但ACK丢失”的窗口。实际接收端幂等验证后才提高承诺。保存原文与提取成功分开，commit/task ID必须检查终态与内部失败记录。没有通用retry端点就不能反复盲commit。

忘记/纠正还需控制记录防旧history再生，删除派生向量、memory和原始证据是不同操作。工具存在不代表完整治理已经通过。

## 7. 维护约束

- 升级OV时先更新官方版本/镜像digest与具体API fixture，不追浮动main；认证、任务、embedding截断契约必须再验。
- 更新Node/Python依赖走各自锁文件。Nest12.1.3遗漏rxjs peer已用pnpm packageExtensions显式修复，不依赖root hoist碰巧可用。
- 换Embedding模型用新profile、namespace/workspace和全量重嵌；同权重CPU/GPU只是backend回退，不为此重建。
- 冷备份先停采集、drain任务与refresh、停OV/adapter，再备份完整state+配置+独立keys。旧refresh-token备份可能因rotation失效，恢复后需要重新登录，不能承诺凭据备份永久可用。
- 源码和镜像分别发布到公开 GitHub 仓库 `qiudeng7/agent-memory-stack` 与 GHCR，发布流程见[部署说明](<deployment.md#维护者发布流程>)。许可证尚未选择，`UNLICENSED` 不因仓库公开而变为开源授权；分发须履行 OV AGPL 及其他第三方义务。SIWC 资格、Plus/Pro entitlement 与实际 slug 仍需确认。

完整实施阶段与验收：[路线图](<implementation-plan.md>)；运行/端口/准备步骤：[部署说明](<deployment.md>)。
