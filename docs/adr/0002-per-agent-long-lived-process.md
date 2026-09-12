---
status: accepted
---

# 每 Agent 一个长驻子进程，Session 归属进程、cwd 绑定 Session

连接模型候选有单活动连接（切换即重启）、按 cwd 起进程、每 agent 一个长驻进程三种。决定采用**每 Agent 定义一个长驻 stdio 子进程**：两个目标 harness 都支持单进程多 Session（`session/new` 携带 cwd），dsh 的 `exitOnStdinEnd` 语义天然匹配长驻 stdio；进程与项目目录解耦、Session 才与 cwd 绑定，避免按 cwd 起进程的进程数爆炸，也避免单连接切换时丢失会话状态。多 Agent 并行即多个长驻进程并存。
