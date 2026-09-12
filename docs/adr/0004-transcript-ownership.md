---
status: accepted
---

# Transcript 所有权归 agent 侧，客户端只持久化配置与会话缓存

Session 与聊天记录（transcript）的唯一事实源归 agent 侧：dsh 是 JSONL 事件溯源日志（代际不可变），opencode 是 SQLite 事件流。客户端（本地 Node server + 浏览器 UI）只持久化两样东西：`agents.json`（Agent 定义，真相源）与**会话缓存**（session 元数据：id/title/cwd/最近活跃，从 `session/list` 同步，可随时丢弃重建）。

客户端**不镜像聊天记录**——镜像必然与 agent 侧漂移，制造双份事实源。重启客户端或 agent 进程后恢复会话，一律走 ACP `session/load`（协议为此而设计），不做客户端侧消息重放。
