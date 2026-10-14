# 开发基线验证

日期：2026-10-14。本记录描述已经执行的证据，不是部署授权或产品验收。

## 独立部署包（当前入口）

- 运行包仅包含compose.yml、.env.example、ov.conf及说明/镜像ID/校验清单；解压到独立tmp后Compose静态展开通过，无源码/build/入口脚本宿主依赖。
- 四镜像已本地构建：两应用、带自动模型准备的引擎、仅增加薄入口的OpenViking派生镜像。固定上游GHCR镜像与模型HEAD采用直连验证，模型HEAD为200；未在本轮重复下载639MB模型。
- Node **113**项、Python **129**项测试通过；**37**项初始化/入口/打包/Compose/资产脚本测试通过。覆盖主密钥原样UTF8 HMAC向量、大小写保留、混用拒绝、不回显、下载校验/损坏文件保留/HTTPS/取消/临时文件清理。
- 四镜像隔离运行验证见[镜像记录](<evidence/portable-image-smoke.json>)：network=none、无宿主端口、合成主密钥和临时named volumes；两个adapter健康200、ready503、派生admin可用而master直接鉴权401；Node卷UID1000/0700可写并跨容器保留；引擎小文件mock首次下载/复用及native loader CLI通过；OV等待ready并响应SIGTERM，root卷0700在dropALL下可写。测试容器和卷均清理。
- 独立冷读和定向配置/下载入口审阅通过；运行说明明确离线镜像交付、主密钥同信任域、down -v删除数据和旧data目录不自动迁移。

本轮不把离线镜像测试当作真实OAuth或GPU/CPU新网关推理验收。以下为历史方案及其验证记录。

## 第一轮简化部署（历史）

根目录单compose.yml、单0600 .env和data目录。已移除profiles、CPU override及旧多secret初始化脚本；模型已移至data/models并重新SHA256校验。引擎使用既有预构建镜像；原生runtime准备只留给维护者。

验证：23项部署/初始化/资产脚本测试通过（含两种GPU层数的Compose静态展开、密钥最小注入、mock readiness等待、setup幂等与权限）。原Node108/Python104测试与构建通过。固定引擎CLI help确认LLAMA_API_KEY与-ngl/--no-op-offload参数；未将这次静态配置检查描述为GPU/CPU新网关推理实测。文档、忽略规则已核对。独立短审发现OV官方root与宿主0700目录在dropALL下的权限问题，已仅对OV补DAC_OVERRIDE；临时无网络Python容器以同cap策略验证私有目录读写通过，未启动OV。

以下是此前开发基线和资产迁移的历史证据；当前用法以[部署说明](<deployment.md>)为准。

## 已执行

- 正确pnpm workspace：唯一Node应用有自己的依赖，根filter脚本；没有packages目录、没有跨包src导入。
- `pnpm check`：严格NodeNext类型检查、**108/108 Node离线测试**、构建通过。
- `pnpm test:python`：**104/104 Python离线测试**通过（host Python3.14）。fresh dev hash锁安装、pip依赖检查、wheel构建也由子任务验证。
- Node与Python Dockerfile均构建成功。Node runtime只部署应用与生产依赖；Python3.11容器内从hash锁安装并构建wheel成功（不等于3.11上已跑pytest）。
- 两个生产镜像在临时非privileged、只读根fs、network=none、无宿主端口的容器中启动通过：health200，未配置ready/models503；随后停止并自动清理。见[镜像启动记录](<evidence/image-smoke.json>)，没有OAuth或模型调用。
- GPU/CPU合并Compose静态config通过，脚本AST、OV JSON、本地文档链接检查通过；没有用Compose启动四服务。
- OAuth/protocol测试使用mock/fake JWT验证器和独立tmp；不是实际签名核验或登录。全部临时文件清理限定于测试创建目录。
- Nest controller通过真实HTTP注入验证200、鉴权角色隔离、模型/字段拒绝、partial后失败、transport abort、默认disabled、501登录路由、400/413不泄露body。
- Python测试含ASGI/HTTP mock、精确最终token/prefix、缓存/身份/TTL/队列/取消/全批验证、向量和usage错误、权限/secret文件、duplicate JSON/413/redirect/日志不回显。

## 发现并修正

- OAuth并发原子替换后安全已打开旧inode可为nlink0；只在FD检查允许0/1，路径与hardlink保护保留，41个OAuth测试重新通过。
- Nest12.1.3漏声明rxjs peer：用pnpm packageExtensions显式声明，不靠root hoist。生产镜像构建也使用这份锁。
- Nest POST默认201与兼容API不符：推理明确HttpCode200。
- Fastify parser在Nest filter前：通过adapter唯一注册安全error handler，bad JSON/413不回显，避免重复override警告。
- 独立代码审查R1：等待transport.execute取得stream之前不主动截断promise。现在headers阶段也race deadline/abort、清理迟到stream；若底层清理不确定，持有串行slot时先暂停transport，排队/新请求不再启动，不能以简单race制造上游并发。新增回归测试通过。
- 独立代码审查R2：无selected profile的新授权可与旧refresh竞争，旧invalid_grant能覆盖新grant。现单owner下所有凭据授权/刷新全局串行，取得锁后重新检查pending到期，新增同client无selected重授权回归通过；不声称跨实例协调。

## 正式项目资产整理

模型和90项native闭包已归入本项目的`.models`与`.runtime/embedding-engine`；固定运行清单、ICD、device metadata、llama许可证在deploy/embedding-engine。准备工具改为校验项目内资产，不再需要外部目录参数；明确if/raise校验在Python正常/优化模式都有效，5项小文件完整性测试均通过。

已从项目本地上下文离线重建`agent-memory-stack-engine:b11429`，短期CLI核对build11429/commit d81235049；Compose固定新image ID。Node108与Python104离线测试再次通过。保留原始基准、registry证明与必要SIWC正文，丢弃旧源码副本、重复下载/cache和临时脚本。整理清单及删除校验见[迁移记录](<evidence/asset-migration.json>)。

## 原始engine依据与未执行边界

[既有engine指标](<evidence/original-engine-benchmark.json>)：RX570 Qwen0.6B Q8真实native/Docker推理、29/29offload、CPU/GPU向量近似一致、2047成功/2048拒绝、CPU2GiB OOM后4GiB通过。它支持本地Vulkan选型，**不是本次新Python prefix/cache网关与OV的联调验收**。

未进行任何真实OAuth注册/登录/token exchange/refresh、账户模型发现、付费推理；未读取用户既有认证；没有正式部署OV、修改驱动、创建GitHub remote或发布镜像。现有reasoning、复杂schema等不支持路径保守失败，而非声称全部兼容。

待验证：Python3.11完整pytest、GPU新网关、OV任务/权限/召回/忘记/重启/恢复、真实SIWC/JWKS/tool/quota/断流。后续执行后更新本记录，实际代码与测试仍是当前事实。
