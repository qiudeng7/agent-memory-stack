# ADR 0001：按应用边界组织，而不是按辅助功能拆包

状态：采纳用户确认的约束。

## 决策

保留两个自有应用：NestJS LLM Adapter与Python Embedding Service。OAuth、协议、HTTP鉴权/错误属于Nest内部模块；Embedding在Python自己的项目中维护。pnpm workspace只管理Node应用，依赖声明在应用package.json。

应用内部正常相对导入；不存在共享需求的模块不抽包。以后若跨多个Node消费者确有共享需求，用workspace:*和包名导入，禁止跨包src路径。

## 理由与代价

需要维护的是OAuth/协议与Embedding行为，不是通用多供应商平台。过细包边界增加版本/构建/导入成本，却没有真实独立消费者。两个语言保留原生工具链，避免为了统一技术栈把更适合Python的Embedding逻辑迁移到Nest。

OpenViking与llama.cpp作为锁定上游进程，配置/镜像配方放deploy，不复制上游核心。四个容器不意味着四个业务代码包。

单应用内部模块可以共享类型和辅助函数；暂不承担独立发布API稳定性。若将来出现共享消费者，再以实际需求评估提包。
