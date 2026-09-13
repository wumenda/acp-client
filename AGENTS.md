# AGENTS.md

本仓库的 agent 工作指引。项目：本地 ACP 客户端（Hono server + React UI，经 stdio JSON-RPC 驱动 agent harness 进程）。领域术语以 [CONTEXT.md](CONTEXT.md) 为准（Agent / Agent 定义 / Session / 会话缓存 / Registry）。

## 命令

- `pnpm dev` — 并行起 server（3111，token 打印在控制台）与 vite（5173，`/api` 代理）
- `pnpm test` — vitest 全量；`pnpm test:e2e` — 仅 Playwright e2e（需 chromium）
- `pnpm typecheck` — `tsc --noEmit`；改动后提交前跑一次 `pnpm typecheck && pnpm test`
- 包管理只用 pnpm（lockfile 是 pnpm-lock.yaml）

## 架构速查

| 位置 | 职责 |
| --- | --- |
| `src/shared/bridge-protocol.ts` | WS 命令/事件唯一契约，前后端改协议必须同步此处 |
| `src/server/store.ts` | agent 进程/ACP 连接生命周期、session/new（30s 超时）、崩溃检测 |
| `src/server/connection.ts` | ACP SDK 1.4.0 封装 |
| `src/server/registry/` | Registry 索引（schema/service）与安装器（installer，binary 下载→sha256→tar 解压） |
| `src/server/fs-proxy.ts` / `terminal-manager.ts` | agent 的 fs/terminal 请求经用户确认后放行 |
| `src/web/state.ts` | 前端唯一 reducer：所有 UI 状态变更只发生在 `reduceEvent` / 少数具名 action |
| `tests/fake-agent*.ts` | 最小 ACP agent 模拟；`tests/app-harness.ts` 起完整服务 |

## 约定与坑

- **事件流单向**：UI 只经 `src/web/ws.ts` 的 `sendCommand` 发命令、经 `reduceEvent` 收事件。新增功能先在 bridge-protocol 定义类型，再两端各自接线。
- **transcript 事实源在 agent 侧**：客户端只缓存会话元数据（`session-cache.ts`），不镜像聊天记录；`session.list`/`session.opened` 的 title 合并防跳动逻辑在 `state.ts`，改动会话列表时保持该语义。
- **error 态不降级**：store 的崩溃检测把非主动退出降为 stopped，但 error 态保留（errorMsg 需对用户可见）。
- **SDK 泛型坑**：`acp.agent.request()` 的泛型重载对宽松类型会静默失配，params 必须显式注解（见 `connection.ts` 备注）。
- **SDK close 噪音**：`ACP connection closed` 的 unhandledRejection 是预期现象（`tests/setup.ts` 有说明），main.ts 已过滤，勿当 bug 修。
- **Windows**：`.cmd` shim 的 agent 定义需 `shell: true`；zip/tar 解压用系统 `tar`（installer.ts）。
- **registry 兼容**：上游 schema 会演进（如 sha256 变可选），新字段一律 optional + 兜底，不设硬依赖。

## 风格

- 代码注释、文档、commit message 用中文；commit 遵循 conventional commits（如 `feat(registry): …`、`fix: …`），一主题一提交。
