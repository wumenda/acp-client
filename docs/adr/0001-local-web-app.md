---
status: accepted
---

# 本地 Web 应用形态（Node server + 浏览器 UI）

产品形态候选有桌面应用（Electron/Tauri）、TUI、IDE 插件、本地 Web 应用四种。决定采用**本地 Node server（负责 spawn agent 子进程与 ACP stdio 接线）+ 浏览器 UI**：两个目标 harness 均为 TS 生态，官方 `@agentclientprotocol/sdk` 是 TS 包可直接复用，此形态落地最快；后续如需桌面化，套 Electron/Tauri 壳的改造成本最低。拒绝 TUI（复刻 tool_call 卡片流成本高）与 IDE 插件（与 Zed/VS Code 已有的 ACP 宿主能力重叠，价值最低）。
