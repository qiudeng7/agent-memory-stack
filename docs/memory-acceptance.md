# 记忆闭环验收

在LLM真实授权、模型与tools probe通过，两个adapter ready且OpenViking启动后执行。使用独立验收account、合成文本，不直接灌入正式history。

Base：`http://127.0.0.1:1933`。Root只用于账户管理，数据操作用独立user key；密钥由客户端读取，不打印响应里的密钥。

| 步骤 | 接口及请求 | 判断 |
|---|---|---|
| 引导 | Root的X-API-Key调用`POST /api/v1/admin/accounts`，`{"account_id":"acceptance","admin_user_id":"owner"}` | 顶层status=ok，将result.user_key安全保存；不要打印整个响应 |
| 建session | user key调用`POST /api/v1/sessions`，`{"session_id":"acceptance-<新UUID>"}` | 保存result.session_id |
| 写消息 | `POST /api/v1/sessions/{id}/messages`，`{"role":"user","content":"验收夹具：我偏好本机Docker部署。"}` | 成功后可追加assistant确认，未知是否成功不盲重试 |
| 提取 | `POST /api/v1/sessions/{id}/commit` | 保存task_id，accepted不算完成，会实际调用LLM |
| 等终态 | `GET /api/v1/tasks/{task_id}?include_events=true` | completed后检查error及内部failed_records/unsupported_records；pending不盲重commit |
| 召回 | `POST /api/v1/search/find`，`{"query":"用户偏好如何部署？","target_uri":"viking://~/memories","context_type":"memory","limit":3,"read_content":true}` | 检查正文、范围和来源，不仅看total>0 |
| 重启/恢复 | 重启服务后重复find；冷备份后在独立副本恢复 | 原事实可召回，不让两实例共享同一workspace |

MCP以同一user key连接`/mcp`，验证find/read和权限。没有通用task retry接口；失败重提之前先核对已有写入。冲突修订、忘记及防止旧history再生另用专项样本检验。

接口依据：[固定v0.5.0 API文档](https://github.com/volcengine/OpenViking/tree/20f9c11362ad16193b0daa4a414e1095061af427/docs/en/api)。备份步骤见[部署说明](<deployment.md>)。
