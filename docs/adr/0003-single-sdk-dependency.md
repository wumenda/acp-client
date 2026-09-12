---
status: accepted
---

# 单一 SDK 依赖（1.4.0）+ 宽容解析，不按 agent 分 SDK 版本

两个目标 agent 分别构建于 `@agentclientprotocol/sdk` 0.21.0（opencode）与 1.4.0（dsh），但调研证实 wire protocol 恒为 v1（`PROTOCOL_VERSION = 1` 从未变过），0.21.0 → 1.4.0 之间无 breaking wire change；差异只在 schema 表面（session/update union 11→15 个 variant、个别 unstable 方法增删）与 SDK API 形态（0.27.0 fluent 重写）。

决定：客户端**单依赖 `@agentclientprotocol/sdk@1.4.0`**（现行 fluent `client()` API，不用 deprecated 的 `ClientSideConnection`）；`session/update` 按**开放式 tagged union 宽容解析**——未知 variant 不报错，降级为占位卡片渲染。

拒绝的替代：双版本 alias 并存（wire 稳定使其无必要，徒增依赖管理成本）；零依赖手写协议层（官方 schema.json 代码生成可行，约 25 个 method，但收益仅是少一个依赖，留作 SDK 生态恶化时的退路）。

后果：若未来 v1 wire 真被破坏（迄今未发生），启用退路 D；适配层职责收窄为纯 agent 侧差异（认证方式、权限选项语义、独有推送类型）。
