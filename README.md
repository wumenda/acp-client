# acp-client

一个本地 ACP（Agent Client Protocol）客户端：以本地 Node server + 浏览器 UI 的形态，通过 stdio JSON-RPC 接入任何实现了 ACP 的 agent harness（内置 deepseek-harness `dsh --profile acp` 与 opencode `opencode acp` 模板），并支持从 [ACP Registry](https://agentclientprotocol.com) 一键安装社区 agent。

## 特性

- **多 Agent 并存**：每个 agent 一个长驻子进程（stdio JSON-RPC），一个进程可承载多个 Session；启动/停止/崩溃检测。
- **会话管理**：新建、恢复（`session/list`）、删除；transcript 事实源在 agent 侧，客户端只保留元数据缓存。
- **交互闭环**：权限请求（`session/requestPermission`）、elicitation、文件系统与终端命令的客户端侧确认弹窗。
- **MCP 转发**：`agents.json` 中按 agent 配置的客户端侧 MCP servers（stdio / http / sse）随 `session/new` 转发。
- **认证指引**：需要登录的 agent（如 opencode）展示操作卡片，在系统终端完成后一键重试。
- **ACP Registry**：浏览公共目录（1h TTL stale-while-revalidate + 磁盘缓存），binary（下载 → sha256 校验 → 解压）/ npx / uvx 三种分发形态一键安装、卸载。
- **日志面板**：JSON-RPC 收发内容可视化，便于调试 agent。
- **明暗主题、中文界面**。

## 快速开始

依赖：Node ≥ 22、[pnpm](https://pnpm.io)。

```bash
pnpm install
pnpm dev        # server → http://127.0.0.1:3111（带 token，控制台输出）；UI → http://localhost:5173
```

生产模式：

```bash
pnpm build      # 前端构建到 dist/web
pnpm start      # server 同端口服务静态文件
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ACP_CLIENT_PORT` | `3111` | server 监听端口（仅绑定 127.0.0.1） |
| `ACP_CLIENT_HOME` | `~/.config/acp-client` | 配置与数据目录 |

## 配置 Agent

首次运行会在 `ACP_CLIENT_HOME` 下生成 `agents.json`（含 dsh / opencode 内置模板，启动命令来自实测，可覆盖 command/args/env）：

```json
{
  "agents": [
    {
      "name": "my-agent",
      "command": "my-agent-cli",
      "args": ["--acp"],
      "env": {},
      "shell": false,
      "autoStart": false,
      "mcpServers": [
        { "type": "stdio", "name": "fs", "command": "mcp-server-fs", "args": [] }
      ]
    }
  ]
}
```

- `shell: true`：Windows 上 `.cmd` shim 需要（缺省仅 win32 生效）。
- `autoStart: true`：server 启动即拉起该 agent。
- Registry 安装的 agent 记录在 `registry-installs.json`，与 `agents.json` 分离，重启后自动合并恢复（内置 → 用户 → 安装项，同名跳过）。

## 架构

```
浏览器 (React + zustand)  ⇄  WebSocket (bridge-protocol)  ⇄  Hono server
                                                                │ stdio JSON-RPC (ACP)
                                                                ├─ agent 进程 1 (dsh / opencode / …)
                                                                └─ agent 进程 2 …
```

| 目录 | 职责 |
| --- | --- |
| `src/server/store.ts` | Agent 进程与 ACP 连接生命周期、会话创建/恢复、崩溃检测 |
| `src/server/connection.ts` | ACP SDK 1.4.0 封装与事件转发 |
| `src/server/fs-proxy.ts` / `terminal-manager.ts` | agent 的 fs/terminal 调用经客户端确认后放行 |
| `src/server/registry/` | Registry 索引消费与安装/卸载编排 |
| `src/shared/bridge-protocol.ts` | WS 命令/事件协议（前后端唯一契约） |
| `src/web/state.ts` | 前端唯一 reducer（zustand），UI 状态只经它变更 |
| `docs/adr/` | 关键决策记录（本地 Web 形态、长驻进程、单 SDK 依赖、transcript 归属） |
| `CONTEXT.md` | 领域术语表（接入 / 会话 / Registry） |

## 测试

```bash
pnpm test         # 单元 + 集成（vitest，含 fake-agent 内存模拟与 app-harness）
pnpm test:e2e     # 浏览器端到端（Playwright chromium）
```

`tests/fake-agent.ts` 实现了一个最小 ACP agent，可在没有真实 harness 的环境下驱动全部交互路径。

## 许可

MIT
