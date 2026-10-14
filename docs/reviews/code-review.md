# P0 开发基线独立代码审查

## 当前结论

**R1、R2 两项原阻断已完成定向复核并关闭；本次复核范围内没有剩余阻断。** 独立重跑类型检查与 **108/108 Node 离线测试**通过，并补验了取消/排队/迟到失败、旧 refresh 成功交错和排队授权 TTL。下文保留问题依据、修复位置和验证边界，不将修复前复现脚本冒充当前可重现缺陷。

对象仍是唯一 Nest workspace 应用中的 OAuth/protocol/common 内部模块，以及独立 Python Embedding 应用。初审为全范围只读审查；此次仅复核父代理冻结的 R1/R2 修复与相关测试，没有重新扩展全审、委派或修改源码。唯一人工写入是本报告；测试产生其正常编译产物。

当前仍是 P0 开发基线，默认 provider disabled；不是 live OAuth 或生产已部署系统。未要求拆共享包、跨包引用 src、改写 Python 生态或引入全平台数据库。P1 未实现本身不是阻断。

## 已关闭的原阻断

### R1 · 中 · 已关闭：取得上游流之前，deadline/断连不能保证请求结束

**初审缺陷：** 旧版直接等待 `transport.execute()` 返回 AsyncIterable；只传入 deadline signal，未主动结束取得流之前的 pending promise。合成复现中，15ms deadline 到期后，60ms 时 signal 已 aborted，但请求与串行槽仍 pending，手动释放 transport 才结束。此结论针对可注入 P0 边界，不是声称真实网络 transport 已发生事故。

**修复核对：**

- [common.ts:98–123](<../../apps/llm-adapter/src/common.ts#L98-L123>) 新增 `awaitWithAbort`，主动在 abort 时拒绝等待，区分 timeout 504 和 cancel 499；移除监听，并消费迟到的 resolve/reject。
- [app.ts:78–110](<../../apps/llm-adapter/src/app.ts#L78-L110>) 将其用于 execute 取得流阶段。失败时在串行槽内部 catch 中设置 `transportPaused`，先暂停再唤醒等待者；不是简单 race 后继续发送新上游请求。
- [app.ts:55–67](<../../apps/llm-adapter/src/app.ts#L55-L67>) 让暂停状态影响 ready，并让新请求拒绝；槽内再次检查暂停，覆盖已经排队的请求。迟到流请求 iterator.return 做 best-effort 清理，**不因该调用完成而自动解除暂停**。

**验证：** [regressions.test.ts:12–33](<../../apps/llm-adapter/test/regressions.test.ts#L12-L33>) 已重跑通过：15ms timeout 在 500ms watchdog 内返回 504、signal aborted、ready=false、新请求拒绝、calls=1、迟到流执行 cleanup 后仍 paused。另外用不写源码的离线脚本补验：外部取消返回 499，已排队请求返回 503，calls 仍为 1；迟到 reject 不产生未处理拒绝，状态仍暂停。

**接受的安全取舍：** 无法确认底层清理时暂停服务，属于 fail closed，不是自动恢复功能。需要确认真实 cleanup 后受控重启；当前修复不保证供应商收到取消后立刻停止计算，也不宣称验证过真实 transport。

### R2 · 中 · 已关闭：无 selected 授权绕开同 profile 锁，旧 refresh 回滚新登录

**初审缺陷：** 旧版仅 selected 授权路径使用 profile 锁。现有 API 允许 `retryRegistration(issuedClientId)` 最终落到已保存的相同 client/subject；该无 selected 路径可在旧 refresh 未结束时保存新 grant。初审纯内存复现：新授权 generation 2 已返回 ready 后，旧 refresh 的 invalid_grant 分支把旧 generation 1 写回并标记 needs_login。原子 replacement 和单 owner 不能避免这个逻辑覆盖。

**修复核对：**

- [oauth-core.ts:218–220](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L218-L220>) 将所有 completeAuthorization，包括无 selected 路径，统一进入 `serialized('credential-mutations', perform)`。
- [oauth-core.ts:268–281](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L268-L281>) 的 refresh 使用同一把锁，保留同 profile single-flight。code exchange、身份验证、凭据保存和失效标记更新不能再与旧 refresh 写入交错。
- [oauth-core.ts:170–173](<../../apps/llm-adapter/src/oauth/oauth-core.ts#L170-L173>) 在实际开始 perform 时重查取消和 TTL；排队期间过期的授权不会继续 exchange。

**验证：** [regressions.test.ts:35–60](<../../apps/llm-adapter/test/regressions.test.ts#L35-L60>) 已重跑通过：无 selected 新授权等待旧 refresh 的 invalid_grant 结束，再保存新 grant，最终凭据与状态均为新授权且 ready。另外离线补验旧 refresh **成功**的顺序，最终仍保留新授权 grant；排队授权到期则 EXPIRED_STATE，未增加 code exchange 次数。

**接受的安全取舍：** 单 owner MVP 全局串行化凭据 mutation，会连带串行不同 profile，吞吐更保守，但解决本缺陷且不需要新包或数据库。它不是跨进程锁，也没有扩大为多实例安全承诺。

**可复验入口：** 仓库根运行 `pnpm typecheck && pnpm test`；两项正式回归位于上述测试链接，均仅用合成 transport/verifier、内存或独立 tmp，不连接真实 OAuth/推理。

## 非阻断建议：暂缓处理

以下三项按父代理控制本轮范围的决定暂不采纳，继续记录，不影响上述关闭结论：

1. **历史建议：安全校验不要使用可被优化掉的 assert。** 初审发现旧准备脚本的复制前检查可被Python优化模式关闭。迁移整理更新：现[准备工具](<../../scripts/prepare-embedding.py>)只校验项目内资产，使用明确if/raise；正常模式和`python -O`均已通过迁移方校验。本项是后续迁移记录，不倒推为原审阅者当时已验证。
2. **把 engine 凭据也纳入误配置隔离。** [config.py:125–130](<../../apps/embedding/src/ams_embedding/config.py#L125-L130>) 只阻止 data/admin 相同；engine_key 若等于 admin_key，会通过 [backend.py:33–35](<../../apps/embedding/src/ams_embedding/backend.py#L33-L35>) 将该管理凭据发送给引擎。默认准备脚本生成独立角色 key，未发现默认越权；后续可只增加三者非空时两两不同的检查。
3. **Node 服务 key 校验与 Python 保持同等级别。** [common.ts:41–45](<../../apps/llm-adapter/src/common.ts#L41-L45>) 只校验最短长度和大小写敏感的模板前缀；环境直传允许空白、控制字符和小写模板。默认随机生成路径没有问题；后续可在本应用内增加有限 ASCII bearer 校验与明确的尾换行处理，不必抽共享包。

## 初审已覆盖的其他边界

以下为初审结论；本轮没有扩展重审这些未改动路径。

| 关注点 | 证据与判断 |
| --- | --- |
| workspace 与生产打包 | [workspace 定义](<../../pnpm-workspace.yaml#L1-L9>) 只有 Nest 应用；应用自行声明 Nest/reflect-metadata/rxjs，[锁文件](<../../pnpm-lock.yaml#L20-L36>) 一致。源码仅应用内部相对导入，无跨包 src 路径。[Node Dockerfile](<../../apps/llm-adapter/Dockerfile#L6-L20>) 使用 frozen lock、生产 deploy、dist 入口；Python 保持独立 wheel/hash 锁安装。 |
| Nest 鉴权、parser/body 错误 | data/admin 分离、相同 key 拒绝、未配置 fail closed；parser-safe handler 与全局 filter 不回显输入。角色隔离、400/413、partial 后 failed 的现有 HTTP 注入测试本轮也通过。 |
| Responses 安全完成 | [聚合器](<../../apps/llm-adapter/src/protocol/response.ts#L89-L100>) 在终态前不返回内容；终态输出/usage/工具 namespace、call_id、历史 call_id、身份变更检查存在。[SSE 层](<../../apps/llm-adapter/src/protocol/sse.ts#L99-L135>) 要求干净 EOF，拒绝 trailing error、截断、未知输出、reasoning，并主动打断 idle iterator。原 R1 的取得 iterator 前缺口现已补齐。 |
| OAuth 与文件 owner | S256/state/nonce、state 单次消费、issuer/audience/expiry/selected subject、实际 scopes 校验存在。[文件存储](<../../apps/llm-adapter/src/oauth/file-store.ts#L24-L71>) 明确仅单进程 owner、目录 0700；文件 0600、FD 检查、原子 rename/fsync、取消前检查存在。原 R2 的逻辑锁覆盖缺口现已补齐。 |
| Python 最终输入与 batch | [service.py](<../../apps/embedding/src/ams_embedding/service.py#L128-L195>) 在 query 前缀形成后以同 backend tokenize；全部未缓存且去重后的输入通过 preflight 才 embed。缓存绑定完整 profile/direction/text digest，复用既有已检验结果。批量索引、完整维数、有限值、L2、失败不提交部分 cache、逻辑 usage 与顺序有代码及离线测试支撑。 |
| Python 超时/取消/可信 origin | 服务期限包含队列等待，ASGI disconnect 和取消传至 backend；httpx 固定配置 origin，禁止 redirect、trust_env=False；data/admin 认证在读取受保护 body 前执行。未发现请求参数可改变 backend origin 的路径。 |
| 部署默认与 secret/path | 历史初审为多secret文件和profiles方案。后续按用户要求简化为[根Compose](<../../compose.yml>)和[setup](<../../scripts/setup.py>)生成单.env，旧文件已移除；本行原初审不作为新部署独立验收依据，当前操作见[部署说明](<../deployment.md>)。 |
| 1M heuristic / 256KiB guard | [OV 配置](<../../ov.conf#L4-L13>) 的 1,000,000 是交给网关裁决普通输入长度的上游 heuristic 阈值，不是模型精确 token 预算。[FrontDoor](<../../apps/embedding/src/ams_embedding/app.py#L57-L79>) 对 Content-Length 和流式读取均施加最多 256KiB；[service.py:129–133](<../../apps/embedding/src/ams_embedding/service.py#L129-L133>) 拒绝既有截断标记，再精确检查最终 ≤2000 tokens。配置意图与网关检查一致，但未实测 OV 所有提前截断/override 路径。 |

## 验证记录与未验证事项

实际执行环境：Node v24.20.0、pnpm 11.24.0；首轮现成虚拟环境 Python 3.14.8。

- **本轮独立执行：** `pnpm typecheck && pnpm test`，退出 0，**108/108** 通过，包含两项新增正式回归。
- **本轮额外离线补验：** R1 外部取消 499 / 排队拒绝 503 / calls=1 / late reject 保持暂停；R2 旧 refresh 成功后再新授权 / 排队授权 TTL 过期不 exchange。全部断言通过，未写入源码或正式测试。
- **首轮独立执行：** Node **106/106**、Python **104/104** 通过；首轮两项缺陷各已复现。本轮只做 Node 定向复核，未重跑未改动的 Python。
- **交付方提供、非本审阅者重验：** 冻结修复后的 pnpm check、Python 104/104、Node 镜像重建、两应用镜像隔离 smoke 通过。本审阅者未重建或启动镜像，也未执行会隐式读取真实 env/secret 的 Compose 命令。

**仍未验证：** 真实 OAuth 注册/授权码交换/refresh、官方 metadata/JWKS、密码学签名/算法/nbf/iat/azp 实现、网络 transport 的 abort/重定向/重试行为、真实账户模型目录、SIWC 推理/tool 往返/配额，以及 Python 3.11 pytest、GPU/CPU 新网关、真实 OV 请求 fixture、任务提取/召回/权限/忘记/备份恢复、1M heuristic 在固定上游版本的完整行为。没有联网推理、读取真实 .env/.secrets/.data/Codex/key、启动 daemon 或正式容器。

特别注意：[IdTokenVerifier](<../../apps/llm-adapter/src/oauth/types.ts#L52-L69>) 中的 true 字段是**受信 verifier 的接口证明**，不是密码学验签。当前测试只注入假 verifier；core 的独立 claims 检查不能取代签名/JWKS 验证。网络 token/Responses transport 与 crypto verifier 均未绑定，mock 测试成功不代表真实登录或生产可用。reasoning 保守拒绝、collector/数据库尚无实现本身均未列阻断。

本报告由受委派审阅者独立完成，遵守“不再次委派”；未再触发文档冷读 subagent 流程。
