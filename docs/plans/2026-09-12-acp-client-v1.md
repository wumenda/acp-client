# acp-client v1 实现计划

> **For agentic workers:** 按任务逐个执行本计划。可用本仓库的 `.agents/skills/executing-plans` 技能来执行。每个步骤用 `- [ ]` 复选框跟踪。

**Goal:** 构建一个本地 ACP（Agent Client Protocol）客户端：Node server 管理 dsh/opencode 的长驻 agent 子进程（stdio JSON-RPC），浏览器 UI 提供对话、工具卡片、权限交互与认证指引。

**Architecture:** 单 pnpm 包。server 侧 `AgentStore` 持有「每 agent 一个长驻子进程 + 一条 ACP 连接」，通过 Hono(HTTP) + WebSocket 把 ACP 的 `session/update` 流与 `request_permission` 桥接到浏览器；transcript 归 agent 侧，客户端只持久化 `agents.json` 与会话缓存。测试用 SDK 起进程内/子进程 fake agent，不需要真实 harness。

**Tech Stack:** Node 22 · TypeScript ESM · pnpm · Hono + @hono/node-server + @hono/node-ws · @agentclientprotocol/sdk@1.4.0 · zod · React 19 + Vite + zustand · vitest

**共识文档:** [CONTEXT.md](../../CONTEXT.md) · [ADR-0001 本地Web形态](../adr/0001-local-web-app.md) · [ADR-0002 长驻进程](../adr/0002-per-agent-long-lived-process.md) · [ADR-0003 单SDK依赖+宽容解析](../adr/0003-single-sdk-dependency.md) · [ADR-0004 transcript所有权](../adr/0004-transcript-ownership.md)

**对共识的一处修正（有据）:** Q15 推荐「Vite middleware 内嵌单进程开发」。经查证 `@hono/vite-dev-server` 插件不代理 WebSocket 升级，而 WS 是本应用主干。故 **dev = `tsx watch` server(127.0.0.1:3111) + vite(5173, proxy `/api` 含 ws)**，用 `concurrently` 一键起；**prod = 单端口单进程**（Hono 同时服务静态文件与 WS）。单包、pnpm 两个决策不变。

---

## 前置事实速查（SDK 1.4.0 实测类型，写代码前必读）

来源：`npm pack @agentclientprotocol/sdk@1.4.0` 解包核对 `dist/acp.d.ts`、`dist/schema/types.gen.d.ts`。

- 长驻连接用 `client({name}).connect(stream): ClientConnection`（`connectWith` 会在回调结束后**关闭连接**，勿用）。`ClientConnection` = `{ agent: ClientContext; signal; closed: Promise<void>; close() }`。
- `ClientContext.request(method, params)` / `.notify(method, params)`，method 用字面量：`"initialize" | "session/new" | "session/prompt" | "session/cancel" | "session/load" | "session/resume" | "session/list" | "authenticate"`。
- 客户端回调注册在 app 上：`clientApp.onNotification("session/update", ctx => ...)`（`ctx.params: SessionNotification = { sessionId, update }`）、`clientApp.onRequest("session/request_permission", ctx => ...)`（返回 `{ outcome: RequestPermissionOutcome }`）。
- `RequestPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string }`；`PermissionOption = { optionId; name; kind: "allow_once"|"allow_always"|"reject_once"|"reject_always" }`。
- `initialize` 请求：`{ protocolVersion: PROTOCOL_VERSION(=1), clientCapabilities, clientInfo }`；响应含 `authMethods: AuthMethod[]`（`type:"agent"` 或 `type:"terminal"`）、`agentCapabilities`（含 `loadSession?: boolean`）。
- `auth_required` 错误码 = `-32000`，SDK 导出 `RequestError`（`err.code === -32000`）。
- opencode 额外检查 `clientCapabilities._meta["terminal-auth"] === true`（见 `opencode/packages/opencode/src/acp/service.ts:102-110`）；dsh 无认证（`authMethods: []`）。
- dsh 启动：`dsh --profile acp`（stdio NDJSON，stdin EOF 即退出）；opencode 启动：`opencode acp`。均只用 stdio 传输。
- Windows 注意：`spawn("dsh", ...)` 命中的是 pnpm 的 `.cmd` shim，Node 不加 `shell:true` 无法执行 `.cmd` → AgentDef 有 `shell` 字段，默认 `process.platform === "win32"`。

## 文件结构

```
acp-client/
├── package.json  tsconfig.json  vitest.config.ts  vite.config.ts  index.html  .gitignore
├── agents.example.json              # 含 dsh/opencode/fake 三个模板
├── scripts/
│   └── smoke.ts                     # 可选真实冒烟（需本机装好 dsh/opencode）
├── src/
│   ├── shared/
│   │   ├── agent-def.ts             # AgentDef zod schema + 内置模板
│   │   └── bridge-protocol.ts       # 浏览器↔server 消息契约
│   ├── server/
│   │   ├── main.ts                  # 入口：token/Hono/WS/静态服务/打印 URL
│   │   ├── app.ts                   # createApp：路由+鉴权+WS 桥
│   │   ├── config.ts                # agents.json 加载合并
│   │   ├── store.ts                 # AgentStore：进程+连接编排
│   │   ├── agent-process.ts         # spawn + stdio→Stream
│   │   ├── connection.ts            # buildClientApp + connectAcp
│   │   └── session-cache.ts         # 会话缓存持久化
│   └── web/
│       ├── main.tsx  App.tsx  ws.ts  state.ts  i18n.ts  styles.css
│       └── components/
│           ├── AgentSidebar.tsx  SessionView.tsx  MessageList.tsx
│           ├── ToolCallCard.tsx  PermissionModal.tsx  AuthCard.tsx  Composer.tsx
└── tests/
    ├── fake-agent.ts                # 进程内最小 ACP agent（SDK agent()）
    ├── fake-agent-child.ts          # stdio 子进程版（子进程测试 + UI 开发替身）
    ├── agent-def.test.ts  config.test.ts  session-cache.test.ts
    ├── connection.test.ts  agent-process.test.ts  store.test.ts
    ├── app.test.ts                  # HTTP+WS 端到端（真子进程 fake agent）
    └── state.test.ts                # 前端 reducer 纯逻辑测试
```

---

### Task 0: 项目脚手架

**Files:** Create `package.json`、`tsconfig.json`、`vitest.config.ts`、`vite.config.ts`、`index.html`、`.gitignore`、`src/web/main.tsx`、`src/web/App.tsx`（占位）、`src/styles.css`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "acp-client",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "concurrently -k \"pnpm dev:server\" \"pnpm dev:web\"",
    "dev:server": "tsx watch src/server/main.ts",
    "dev:web": "vite",
    "start": "tsx src/server/main.ts",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "smoke:dsh": "tsx scripts/smoke.ts dsh",
    "smoke:opencode": "tsx scripts/smoke.ts opencode"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "1.4.0",
    "@hono/node-server": "^1.14.0",
    "@hono/node-ws": "^1.1.0",
    "hono": "^4.7.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "ws": "^8.18.0",
    "zod": "^3.25.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/ws": "^8.0.0",
    "@vitejs/plugin-react": "^4.4.0",
    "concurrently": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vite": "^6.3.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "useUnknownInCatchVariables": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`、`vite.config.ts`、`index.html`、`.gitignore`**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
})
```

```ts
// vite.config.ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3111", ws: true } },
  },
  build: { outDir: "dist/web" },
})
```

```html
<!-- index.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>acp-client</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

```gitignore
# .gitignore
node_modules/
dist/
*.log
```

- [ ] **Step 4: 写最小 React 入口**

```tsx
// src/web/main.tsx
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "../styles.css"

createRoot(document.getElementById("root")!).render(<App />)
```

```tsx
// src/web/App.tsx（占位，Task 11 重写）
export function App() {
  return <div className="app">acp-client 启动中…</div>
}
```

```css
/* src/styles.css（基础变量，后续任务追加组件样式） */
:root {
  --bg: #0d1117;
  --panel: #161b22;
  --border: #2d3646;
  --text: #e6edf3;
  --muted: #8b98a9;
  --accent: #4f8ff7;
  --danger: #f78166;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
```

- [ ] **Step 5: 安装依赖并验证**

Run: `cd c:\Users\Wumd\Desktop\harness\acp-client ; git init ; pnpm install ; pnpm typecheck`
Expected: 安装成功；typecheck 通过（0 errors）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold acp-client (vite+hono+acp sdk)"
```

---

### Task 1: AgentDef 模型与内置模板

**Files:** Create `src/shared/agent-def.ts`；Test `tests/agent-def.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent-def.test.ts
import { describe, expect, it } from "vitest"
import { AgentDefSchema, BUILTIN_AGENT_DEFS } from "../src/shared/agent-def"

describe("AgentDefSchema", () => {
  it("补全默认值 args=[] env={} builtin=false", () => {
    const def = AgentDefSchema.parse({ name: "x", command: "x" })
    expect(def.args).toEqual([])
    expect(def.env).toEqual({})
    expect(def.builtin).toBe(false)
    expect(def.shell).toBeUndefined()
  })

  it("拒绝空 command", () => {
    expect(() => AgentDefSchema.parse({ name: "x", command: "" })).toThrow()
  })
})

describe("BUILTIN_AGENT_DEFS", () => {
  it("包含 dsh 与 opencode 的实测启动命令", () => {
    const dsh = BUILTIN_AGENT_DEFS.find((d) => d.name === "dsh")!
    expect(dsh.args).toEqual(["--profile", "acp"])
    const oc = BUILTIN_AGENT_DEFS.find((d) => d.name === "opencode")!
    expect(oc.args).toEqual(["acp"])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/agent-def.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/shared/agent-def.ts
import { z } from "zod"

export const AgentDefSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Windows 上 .cmd shim 需要 shell；缺省 = win32 */
  shell: z.boolean().optional(),
  builtin: z.boolean().default(false),
})

export type AgentDef = z.infer<typeof AgentDefSchema>

/** 启动命令来自对两个仓库的实测（见 CONTEXT.md「内置模板」） */
export const BUILTIN_AGENT_DEFS: AgentDef[] = [
  { name: "dsh", command: "dsh", args: ["--profile", "acp"], env: {}, builtin: true },
  { name: "opencode", command: "opencode", args: ["acp"], env: {}, builtin: true },
]
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/agent-def.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/agent-def.ts tests/agent-def.test.ts
git commit -m "feat: agent-def schema with builtin dsh/opencode templates"
```

---

### Task 2: agents.json 加载与合并

**Files:** Create `src/server/config.ts`；Test `tests/config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/config.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadAgentDefs } from "../src/server/config"

function tmpHome() {
  return mkdtempSync(path.join(tmpdir(), "acp-client-"))
}

describe("loadAgentDefs", () => {
  it("无配置文件时写入默认文件并返回内置模板", () => {
    const dir = tmpHome()
    const defs = loadAgentDefs(dir)
    expect(defs.map((d) => d.name)).toContain("dsh")
    expect(defs.map((d) => d.name)).toContain("opencode")
    const written = JSON.parse(readFileSync(path.join(dir, "agents.json"), "utf8"))
    expect(written.agents).toHaveLength(2)
  })

  it("用户同名条目覆盖模板的 command/args/env，保留 builtin 标记", () => {
    const dir = tmpHome()
    writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({
        agents: [{ name: "dsh", command: "C:/bin/dsh.exe", args: ["acp"] }],
      }),
    )
    const dsh = loadAgentDefs(dir).find((d) => d.name === "dsh")!
    expect(dsh.command).toBe("C:/bin/dsh.exe")
    expect(dsh.args).toEqual(["acp"])
    expect(dsh.builtin).toBe(true)
  })

  it("用户新增条目追加在模板之后；非法条目抛错", () => {
    const dir = tmpHome()
    writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({ agents: [{ name: "fake", command: "node" }, { name: "" }] }),
    )
    expect(() => loadAgentDefs(dir)).toThrow()
    writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({ agents: [{ name: "fake", command: "node" }] }),
    )
    expect(loadAgentDefs(dir).map((d) => d.name)).toEqual(["dsh", "opencode", "fake"])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/server/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentDefSchema, BUILTIN_AGENT_DEFS, type AgentDef } from "../shared/agent-def"

export function configDir(): string {
  return process.env.ACP_CLIENT_HOME ?? path.join(os.homedir(), ".config", "acp-client")
}

/** 读取 agents.json；不存在则用内置模板初始化。用户同名条目覆盖模板字段。 */
export function loadAgentDefs(dir: string = configDir()): AgentDef[] {
  const file = path.join(dir, "agents.json")
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ agents: BUILTIN_AGENT_DEFS }, null, 2))
    return BUILTIN_AGENT_DEFS
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as { agents?: unknown[] }
  const userDefs = (raw.agents ?? []).map((a) => AgentDefSchema.parse(a))
  const remaining = new Map(userDefs.map((d) => [d.name, d]))
  const merged = BUILTIN_AGENT_DEFS.map((b) => {
    const u = remaining.get(b.name)
    if (!u) return b
    remaining.delete(b.name)
    return { ...b, ...u, name: b.name, builtin: true }
  })
  return [...merged, ...remaining.values()]
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts tests/config.test.ts
git commit -m "feat: agents.json loading with builtin template merge"
```

---

### Task 3: 会话缓存

**Files:** Create `src/server/session-cache.ts`；Test `tests/session-cache.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/session-cache.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SessionCache } from "../src/server/session-cache"

describe("SessionCache", () => {
  it("upsert 后重新加载仍可读（持久化）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const a = new SessionCache(dir)
    a.upsert("dsh", { sessionId: "s1", cwd: "C:/proj", updatedAt: 1, title: "t" })
    const b = new SessionCache(dir)
    expect(b.list("dsh")).toEqual([{ sessionId: "s1", cwd: "C:/proj", updatedAt: 1, title: "t" }])
  })

  it("list 支持按 cwd 过滤且按 updatedAt 倒序", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const c = new SessionCache(dir)
    c.upsert("dsh", { sessionId: "s1", cwd: "C:/a", updatedAt: 1 })
    c.upsert("dsh", { sessionId: "s2", cwd: "C:/b", updatedAt: 3 })
    c.upsert("dsh", { sessionId: "s3", cwd: "C:/a", updatedAt: 2 })
    const inA = c.list("dsh", "C:/a")
    expect(inA.map((s) => s.sessionId)).toEqual(["s3", "s1"])
  })

  it("touch 更新 updatedAt；空缓存 list 返回 []", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const c = new SessionCache(dir)
    c.upsert("dsh", { sessionId: "s1", cwd: "C:/a", updatedAt: 1 })
    c.touch("dsh", "s1", 99)
    expect(c.list("dsh")[0].updatedAt).toBe(99)
    expect(c.list("nope")).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/session-cache.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/session-cache.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export type SessionMeta = { sessionId: string; cwd: string; title?: string; updatedAt: number }
type CacheData = Record<string, Record<string, SessionMeta>>

/** 会话元数据缓存（可随时丢弃重建，见 ADR-0004）。tmp+rename 原子写。 */
export class SessionCache {
  private data: CacheData = {}
  private file: string

  constructor(dir: string) {
    this.file = path.join(dir, "session-cache.json")
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as CacheData
    }
  }

  list(agentId: string, cwd?: string): SessionMeta[] {
    const all = Object.values(this.data[agentId] ?? {})
    const filtered = cwd ? all.filter((s) => s.cwd === cwd) : all
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  upsert(agentId: string, meta: SessionMeta): void {
    const bucket = (this.data[agentId] ??= {})
    const prev = bucket[meta.sessionId]
    bucket[meta.sessionId] = { ...prev, ...meta }
    this.save()
  }

  touch(agentId: string, sessionId: string, at: number): void {
    const cur = this.data[agentId]?.[sessionId]
    if (!cur) return
    cur.updatedAt = at
    this.save()
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.file)
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/session-cache.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/session-cache.ts tests/session-cache.test.ts
git commit -m "feat: session metadata cache with atomic persistence"
```

---

### Task 4: Fake Agent（测试替身 + UI 开发替身）

**Files:** Create `tests/fake-agent.ts`、`tests/fake-agent-child.ts`

fake agent 演示完整客户端回调面：`session/update` 通知、`session/request_permission` 请求、`auth_required`、`session/load` 历史重放。它**不依赖 vitest**（子进程与 UI 开发都要用）。

- [ ] **Step 1: 实现 fake-agent.ts**

```ts
// tests/fake-agent.ts
import { agent, RequestError } from "@agentclientprotocol/sdk"
import type { AgentApp, RequestPermissionOutcome, SessionUpdate } from "@agentclientprotocol/sdk"

export type FakeScript = {
  /** session/prompt 后按序推送的 update；缺省 = 一条思考+一条正文+一条工具卡 */
  updates?: SessionUpdate[]
  /** 是否在 prompt 中发起一次权限请求 */
  askPermission?: boolean
  /** session/new 直接抛 auth_required(-32000) */
  authRequired?: boolean
  /** initialize 返回的 authMethods（非空 → 客户端应显示认证指引） */
  authMethods?: Array<{ type: "agent"; id: string; name: string; description?: string }>
  stopReason?: "end_turn" | "cancelled"
}

export type FakeAgentState = {
  lastPermissionOutcome: RequestPermissionOutcome | null
  cancelled: boolean
  promptTexts: string[]
  authenticated: boolean
}

let seq = 0

export function createFakeAgent(script: FakeScript = {}): { app: AgentApp; state: FakeAgentState } {
  const state: FakeAgentState = {
    lastPermissionOutcome: null,
    cancelled: false,
    promptTexts: [],
    authenticated: false,
  }
  const defaultUpdates: SessionUpdate[] = [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[思考] 先看看目录" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好，这是 fake agent 的回复。" } },
    {
      sessionUpdate: "tool_call",
      toolCallId: "t-1",
      kind: "search",
      status: "in_progress",
      title: "grep TODO",
    },
    { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" },
  ]

  const app = agent({ name: "fake-agent" })
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, listSessions: true },
      authMethods: script.authMethods ?? [],
    }))
    .onRequest("authenticate", () => {
      state.authenticated = true
      return {}
    })
    .onRequest("session/new", (ctx) => {
      if (script.authRequired && !state.authenticated) {
        throw new RequestError(-32000, "Authentication required: run `fake auth login`")
      }
      return { sessionId: `fake-${++seq}` }
    })
    .onRequest("session/load", () => {
      // 重放两块历史，随后正常返回
      void ctx.agent // load 历史通过通知推送，见 prompt 流程复用
      return {}
    })
    .onRequest("session/list", () => ({
      sessions: [{ sessionId: "fake-1", cwd: ctx0cwd, title: "fake 会话一", updatedAt: Date.now() }],
    }))
    .onNotification("session/cancel", () => {
      state.cancelled = true
    })
    .onRequest("session/prompt", async (ctx) => {
      state.promptTexts.push(JSON.stringify(ctx.params.prompt))
      const sessionId = ctx.params.sessionId
      const updates = script.updates ?? defaultUpdates
      for (const update of updates) {
        await ctx.client.notify("session/update", { sessionId, update })
      }
      if (script.askPermission) {
        const res = await ctx.client.request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "t-perm", kind: "execute", status: "pending", title: "rm -rf /" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })
        state.lastPermissionOutcome = res.outcome
      }
      return { stopReason: script.stopReason ?? "end_turn" }
    })
  return { app, state }
}

// session/list 用的 cwd 占位（由测试按需覆盖；此处保持实现简单）
const ctx0cwd = "C:/"
```

> 注：`session/list` 里 `ctx0cwd` 为占位值。`ListSessionsResponse.sessions: SessionInfo[]`（`{ sessionId, cwd, title?, updatedAt }`）。若 TS 对未使用变量报错，删除 `ctx0cwd` 并在 handler 内直接写 `cwd: "C:/"`。

- [ ] **Step 2: 实现 stdio 子进程版**

```ts
// tests/fake-agent-child.ts
// 用途：① 子进程集成测试 ② UI 开发时的 fake agent（agents.example.json 有对应条目）
import { Writable, Readable } from "node:stream"
import process from "node:process"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { createFakeAgent } from "./fake-agent"

const { app } = createFakeAgent({
  askPermission: process.env.FAKE_ASK_PERMISSION === "1",
  authRequired: process.env.FAKE_AUTH_REQUIRED === "1",
})
app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
```

- [ ] **Step 3: 验证子进程可独立启动**

Run: `$env:FAKE_ASK_PERMISSION="0"; "…" | node --import tsx tests/fake-agent-child.ts` 后 Ctrl+C
Expected: 进程保持运行（stdin 开着），无报错输出；Ctrl+C 退出。（实际操作：起一个终端跑它，确认无异常即可）

- [ ] **Step 4: Commit**

```bash
git add tests/fake-agent.ts tests/fake-agent-child.ts
git commit -m "test: fake ACP agent (in-process + stdio child)"
```

---

### Task 5: 连接层 connection.ts

**Files:** Create `src/server/connection.ts`；Test `tests/connection.test.ts`

- [ ] **Step 1: 写失败测试（进程内直连 fake agent，无传输）**

```ts
// tests/connection.test.ts
import { describe, expect, it } from "vitest"
import type { RequestPermissionOutcome, SessionNotification } from "@agentclientprotocol/sdk"
import { buildClientApp } from "../src/server/connection"
import { createFakeAgent } from "./fake-agent"

function setup(script: Parameters<typeof createFakeAgent>[0]) {
  const { app: fakeApp, state } = createFakeAgent(script)
  const updates: SessionNotification[] = []
  let permissionResolve: ((o: RequestPermissionOutcome) => void) | null = null
  const clientApp = buildClientApp({
    onUpdate: (n) => updates.push(n),
    onRequestPermission: () =>
      new Promise<RequestPermissionOutcome>((resolve) => {
        permissionResolve = resolve
      }),
  })
  const conn = clientApp.connect(fakeApp)
  return { conn, state, updates, answerPermission: (o: RequestPermissionOutcome) => permissionResolve!(o) }
}

const INIT = {
  protocolVersion: 1 as const,
  clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } },
  clientInfo: { name: "acp-client", version: "0.1.0" },
}

describe("buildClientApp", () => {
  it("initialize 握手成功且收到 authMethods", async () => {
    const { conn } = setup({ authMethods: [{ type: "agent", id: "login", name: "Login" }] })
    const info = await conn.agent.request("initialize", INIT)
    expect(info.protocolVersion).toBe(1)
    expect(info.authMethods).toHaveLength(1)
    conn.close()
  })

  it("session/new → prompt：按序收到 update，最终 stopReason=end_turn", async () => {
    const { conn, updates } = setup({})
    await conn.agent.request("initialize", INIT)
    const { sessionId } = await conn.agent.request("session/new", { cwd: "C:/tmp", mcpServers: [] })
    const done = conn.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    })
    // 等 updates 流入后再等待 prompt 返回
    await vi_waitFor(() => updates.length >= 4)
    const res = await done
    expect(res.stopReason).toBe("end_turn")
    expect(updates[0].update.sessionUpdate).toBe("agent_thought_chunk")
    expect(updates.map((u) => u.sessionId)).toContain(sessionId)
    conn.close()
  })

  it("权限请求桥接：客户端选择映射为 optionId 返回给 agent", async () => {
    const { conn, updates, state, answerPermission } = setup({ askPermission: true })
    await conn.agent.request("initialize", INIT)
    const { sessionId } = await conn.agent.request("session/new", { cwd: "C:/tmp", mcpServers: [] })
    const done = conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
    await vi_waitFor(() => updates.some((u) => u.update.sessionUpdate === "tool_call"))
    answerPermission({ outcome: "selected", optionId: "allow" })
    await done
    expect(state.lastPermissionOutcome).toEqual({ outcome: "selected", optionId: "allow" })
    conn.close()
  })
})

async function vi_waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/connection.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/server/connection.ts
import {
  PROTOCOL_VERSION,
  client,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type InitializeResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
  type WritableStream as _W,
} from "@agentclientprotocol/sdk"
import { Writable, Readable } from "node:stream"

export type AcpHandlers = {
  onUpdate(n: SessionNotification): void
  onRequestPermission(req: RequestPermissionRequest): Promise<RequestPermissionOutcome>
}

export type AcpConnection = {
  agent: ClientContext
  info: InitializeResponse
  closed: Promise<void>
  close(): void
}

const CLIENT_INFO = { name: "acp-client", title: "ACP Client", version: "0.1.0" } as const

/** 注册客户端回调面（session/update + request_permission）。 */
export function buildClientApp(h: AcpHandlers, name = CLIENT_INFO.name): ClientApp {
  return client({ name })
    .onNotification("session/update", (ctx) => {
      h.onUpdate(ctx.params)
    })
    .onRequest("session/request_permission", async (ctx) => ({
      outcome: await h.onRequestPermission(ctx.params),
    }))
}

/** 连接一条 ACP stream 并完成 initialize 握手。 */
export async function connectAcp(stream: Stream, h: AcpHandlers): Promise<AcpConnection> {
  const conn: ClientConnection = buildClientApp(h).connect(stream)
  try {
    const info = await conn.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // v1 不实现客户端 fs 回调（agent 自己读写文件）；声明 terminal-auth 能力（opencode 检查 _meta["terminal-auth"]）
      clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } },
      clientInfo: CLIENT_INFO,
    })
    return { agent: conn.agent, info, closed: conn.closed, close: () => conn.close() }
  } catch (e) {
    conn.close()
    throw e
  }
}

/** 把子进程 stdio 变成 ACP stream（agent-process 也可能用）。 */
export function stdioToStream(stdin: Writable, stdout: Readable): Stream {
  return ndJsonStream(
    Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
  )
}

/** agentCapabilities 的窄化读取（避免 any，容忍字段缺失）。
 *  实测（Task 5 修正）：listSessions 不是顶层字段，list/resume 能力挂在 agentCapabilities.sessionCapabilities 下。 */
export type CoreCaps = { loadSession?: boolean; sessionCapabilities?: { list?: unknown; resume?: unknown; close?: unknown } }
export function capsOf(info: InitializeResponse): CoreCaps {
  return (info.agentCapabilities ?? {}) as CoreCaps
}
export function canList(info: InitializeResponse): boolean {
  return capsOf(info).sessionCapabilities?.list != null
}
```

> 顶部 `WritableStream as _W` 是 DOM 全局与 SDK 类型重名时的保险；若 typecheck 无冲突则删除该行与 `_W`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/connection.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/connection.ts tests/connection.test.ts
git commit -m "feat: ACP client connection layer with permission bridge"
```

---

### Task 6: agent-process.ts（spawn + stdio 接线）

**Files:** Create `src/server/agent-process.ts`；Test `tests/agent-process.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent-process.test.ts
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { RequestPermissionOutcome, SessionNotification } from "@agentclientprotocol/sdk"
import { spawnAgentProcess } from "../src/server/agent-process"
import { connectAcp } from "../src/server/connection"

const CHILD = path.resolve("tests/fake-agent-child.ts")

describe("spawnAgentProcess", () => {
  it("通过真实 stdio 完成 initialize + prompt + 杀进程", async () => {
    const proc = spawnAgentProcess({
      name: "fake",
      command: process.execPath,
      args: ["--import", "tsx", CHILD],
      env: {},
      builtin: false,
    })
    const updates: SessionNotification[] = []
    const acp = await connectAcp(proc.stream, {
      onUpdate: (n) => updates.push(n),
      onRequestPermission: () => Promise.resolve<RequestPermissionOutcome>({ outcome: "cancelled" }),
    })
    expect(acp.info.protocolVersion).toBe(1)

    const { sessionId } = await acp.agent.request("session/new", { cwd: "C:/tmp", mcpServers: [] })
    const done = acp.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] })
    const start = Date.now()
    while (updates.length < 4 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20))
    const res = await done
    expect(res.stopReason).toBe("end_turn")

    proc.kill()
    const exit = await proc.exit
    expect(exit.code ?? exit.signal).toBeTruthy()
    await acp.closed
  }, 15000)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/agent-process.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/server/agent-process.ts
import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import type { Stream } from "@agentclientprotocol/sdk"
import { stdioToStream } from "./connection"
import type { AgentDef } from "../shared/agent-def"

export type AgentProcess = {
  stream: Stream
  proc: ChildProcess
  /** stderr 尾部（诊断用，最多 4KB） */
  readonly stderrTail: string
  exit: Promise<{ code: number | null; signal: string | null }>
  kill(): void
}

export function spawnAgentProcess(def: AgentDef): AgentProcess {
  const proc = spawn(def.command, def.args, {
    env: { ...process.env, ...def.env },
    // Windows 的 dsh/opencode 是 .cmd shim，必须走 shell
    shell: def.shell ?? process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stream = stdioToStream(proc.stdin!, proc.stdout!)
  let tail = ""
  proc.stderr!.on("data", (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4096)
  })
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }))
    proc.once("error", () => resolve({ code: null, signal: null }))
  })
  return { stream, proc, get stderrTail() { return tail }, exit, kill: () => proc.kill() }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/agent-process.test.ts`
Expected: PASS (1 test)。若 `--import tsx` 报错，改用 `command: "npx", args: ["tsx", CHILD]`（Windows 已有 shell:true）。

- [ ] **Step 5: Commit**

```bash
git add src/server/agent-process.ts tests/agent-process.test.ts
git commit -m "feat: agent process spawning with stdio ACP wiring"
```

---

### Task 7: AgentStore（编排核心）

**Files:** Create `src/server/store.ts`；Test `tests/store.test.ts`

Store 职责：per-agent `{ def, proc, acp, status }` 运行时、状态机（stopped/starting/ready/error/needs-auth）、权限请求挂起表（requestId → resolver）、`auth_required` 捕获、崩溃检测（非主动 stop → status stopped）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/store.test.ts
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { AgentStore, type StoreEvents } from "../src/server/store"
import type { AgentStatusView } from "../src/shared/bridge-protocol"

const CHILD = path.resolve("tests/fake-agent-child.ts")
const FAKE_DEF = {
  name: "fake",
  command: process.execPath,
  args: ["--import", "tsx", CHILD],
  env: {} as Record<string, string>,
  builtin: false,
} as const

function recorder() {
  const events: { kind: string; [k: string]: unknown }[] = []
  const statusStack: string[] = []
  const eventsOverride: Partial<StoreEvents> = {}
  const base: StoreEvents = {
    onAgentStatus: (_id, view) => {
      statusStack.push(view.status)
      events.push({ kind: "status", status: view.status, view })
    },
    onSessionUpdate: (_id, n: SessionNotification) => events.push({ kind: "update", n }),
    onPermissionRequest: (p) => events.push({ kind: "perm", ...p }),
    onPermissionDone: (requestId) => events.push({ kind: "permDone", requestId }),
    onPromptDone: (agentId, sessionId, stopReason) => events.push({ kind: "done", agentId, sessionId, stopReason }),
    onPromptError: (agentId, sessionId, message) => events.push({ kind: "promptError", agentId, sessionId, message }),
    onSessionOpened: (agentId, sessionId, cwd) => events.push({ kind: "opened", agentId, sessionId, cwd }),
    onSessionList: (agentId, sessions) => events.push({ kind: "list", agentId, sessions }),
    ...eventsOverride,
  }
  return { events, statusStack, eventsOverride, base }
}

describe("AgentStore", () => {
  it("start → ready；newSession/prompt 全链路", async () => {
    const r = recorder()
    const store = new AgentStore([FAKE_DEF as never], r.base)
    await store.start("fake")
    expect(store.statusOf("fake")).toBe("ready")

    const sessionId = await store.newSession("fake", "C:/tmp")
    expect(sessionId).toMatch(/^fake-/)
    await store.prompt("fake", sessionId, "hello")
    expect(r.events.some((e) => e.kind === "update")).toBe(true)
    expect(r.events.some((e) => e.kind === "done" && e.stopReason === "end_turn")).toBe(true)

    store.stop("fake")
    expect(store.statusOf("fake")).toBe("stopped")
  }, 15000)

  it("权限请求：浏览器应答经 store 回到 agent", async () => {
    const r = recorder()
    const store = new AgentStore([{ ...FAKE_DEF, env: { FAKE_ASK_PERMISSION: "1" } } as never], r.base)
    await store.start("fake")
    const sessionId = await store.newSession("fake", "C:/tmp")
    const done = store.prompt("fake", sessionId, "go")
    await vi_waitFor(() => r.events.some((e) => e.kind === "perm"))
    const perm = r.events.find((e) => e.kind === "perm")! as { requestId: number; options: { optionId: string }[] }
    expect(perm.options.map((o) => o.optionId)).toEqual(["allow", "reject"])
    store.respondPermission(perm.requestId, "allow")
    await done
    expect(r.events.some((e) => e.kind === "permDone")).toBe(true)
    store.stop("fake")
  }, 15000)

  it("authRequired 时 newSession 报 auth_required → status 变 needs-auth；authenticate 后可建会话", async () => {
    const r = recorder()
    const store = new AgentStore(
      [{ ...FAKE_DEF, env: { FAKE_AUTH_REQUIRED: "1" }, args: [...FAKE_DEF.args] } as never],
      r.base,
    )
    await store.start("fake")
    await expect(store.newSession("fake", "C:/tmp")).rejects.toThrow(/auth/i)
    expect(store.statusOf("fake")).toBe("needs-auth")
    await store.authenticate("fake")
    const sessionId = await store.newSession("fake", "C:/tmp")
    expect(sessionId).toMatch(/^fake-/)
    store.stop("fake")
  }, 15000)

  it("进程崩溃 → status stopped（手动重启策略，见共识）", async () => {
    const r = recorder()
    const store = new AgentStore([FAKE_DEF as never], r.base)
    await store.start("fake")
    const proc = store.processOf("fake")!
    proc.kill()
    await vi_waitFor(() => store.statusOf("fake") === "stopped")
    store.stop("fake")
  }, 15000)
})

async function vi_waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 20))
  }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/store.ts
import { RequestError } from "@agentclientprotocol/sdk"
import type {
  PermissionOption,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { AgentDef } from "../shared/agent-def"
import type { AgentStatusView, SessionMetaView } from "../shared/bridge-protocol"
import { spawnAgentProcess, type AgentProcess } from "./agent-process"
import { connectAcp, capsOf, canList, type AcpConnection } from "./connection"

export type AgentStatus = "stopped" | "starting" | "ready" | "error" | "needs-auth"

export type StoreEvents = {
  onAgentStatus(agentId: string, view: AgentStatusView): void
  onSessionUpdate(agentId: string, n: SessionNotification): void
  onPermissionRequest(p: {
    requestId: number
    agentId: string
    sessionId: string
    toolCall: ToolCallUpdate
    options: PermissionOption[]
  }): void
  onPermissionDone(requestId: number): void
  onPromptDone(agentId: string, sessionId: string, stopReason: string): void
  onPromptError(agentId: string, sessionId: string | null, message: string): void
  onSessionOpened(agentId: string, sessionId: string, cwd: string): void
  onSessionList(agentId: string, sessions: SessionMetaView[]): void
}

type Runtime = {
  def: AgentDef
  proc: AgentProcess | null
  acp: AcpConnection | null
  status: AgentStatus
  errorMsg?: string
  authErrorCommand?: string
}

const AUTH_REQUIRED = -32000

export class AgentStore {
  private agents = new Map<string, Runtime>()
  private pending = new Map<number, (o: RequestPermissionOutcome) => void>()
  private permSeq = 0

  constructor(defs: AgentDef[], private events: StoreEvents) {
    for (const def of defs) {
      this.agents.set(def.name, { def, proc: null, acp: null, status: "stopped" })
    }
  }

  list(): AgentStatusView[] {
    return [...this.agents.values()].map((r) => this.view(r))
  }

  statusOf(agentId: string): AgentStatus {
    return this.rt(agentId).status
  }

  processOf(agentId: string): AgentProcess | null {
    return this.rt(agentId).proc
  }

  async start(agentId: string): Promise<void> {
    const r = this.rt(agentId)
    if (r.status === "starting" || r.status === "ready") return
    this.setStatus(r, "starting")
    try {
      const proc = spawnAgentProcess(r.def)
      r.proc = proc
      const acp = await connectAcp(proc.stream, {
        onUpdate: (n) => this.events.onSessionUpdate(agentId, n),
        onRequestPermission: (req) => this.handlePermission(agentId, req),
      })
      r.acp = acp
      // 崩溃检测：非主动 stop 的退出 → stopped（v1 手动重启策略）
      void proc.exit.then(() => {
        if (r.status !== "stopped") {
          r.acp = null
          r.proc = null
          this.setStatus(r, "stopped")
        }
      })
      void acp.closed.then(() => {
        this.rejectPendingCancelled()
      })
      this.setStatus(r, "ready")
    } catch (e) {
      r.proc = null
      r.acp = null
      r.errorMsg = String((e as Error)?.message ?? e)
      this.setStatus(r, "error")
    }
  }

  stop(agentId: string): void {
    const r = this.rt(agentId)
    r.status = "stopped" // 先置位，让 exit 回调走 stopped 分支
    r.acp?.close()
    r.acp = null
    r.proc?.kill()
    r.proc = null
    this.rejectPendingCancelled()
    this.events.onAgentStatus(agentId, this.view(r))
  }

  /** 新建会话；auth_required 时转入 needs-auth 并抛错。 */
  async newSession(agentId: string, cwd: string): Promise<string> {
    const { acp } = this.ready(agentId)
    try {
      const res = await acp.agent.request("session/new", { cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, res.sessionId, cwd)
      return res.sessionId
    } catch (e) {
      if (e instanceof RequestError && e.code === AUTH_REQUIRED) {
        const r = this.rt(agentId)
        const m = r.acp?.info.authMethods?.[0]
        r.authErrorCommand = m && m.type === "terminal" ? [m.id, ...(m as { args?: string[] }).args ?? []].join(" ") : undefined
        this.setStatus(r, "needs-auth")
        throw new Error(`需要认证：${m?.name ?? m?.id ?? "unknown"}（请在系统终端完成登录后重试）`)
      }
      throw e
    }
  }

  async authenticate(agentId: string): Promise<void> {
    const r = this.rt(agentId)
    const method = r.acp?.info.authMethods?.[0]
    if (!method) throw new Error("该 agent 未声明认证方式")
    await r.acp!.agent.request("authenticate", { methodId: method.id })
    this.setStatus(r, "ready")
  }

  async prompt(agentId: string, sessionId: string, text: string): Promise<void> {
    const { acp } = this.ready(agentId)
    try {
      const res = await acp.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text" as const, text }],
      })
      this.events.onPromptDone(agentId, sessionId, res.stopReason)
    } catch (e) {
      this.events.onPromptError(agentId, sessionId, String((e as Error)?.message ?? e))
    }
  }

  cancel(agentId: string, sessionId: string): void {
    const { acp } = this.ready(agentId)
    void acp.agent.notify("session/cancel", { sessionId })
  }

  async listSessions(agentId: string, cwd?: string): Promise<SessionMetaView[]> {
    const { acp } = this.ready(agentId)
    if (!canList(acp.info)) return []
    const res = await acp.agent.request("session/list", { cwd: cwd ?? null })
    const views = res.sessions.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt ?? Date.now(),
    }))
    this.events.onSessionList(agentId, views)
    return views
  }

  /** 恢复会话：优先 load（重放历史），否则 resume，能力都不支持 → "unsupported"。 */
  async openSession(agentId: string, sessionId: string, cwd: string): Promise<"loaded" | "resumed" | "unsupported"> {
    const { acp } = this.ready(agentId)
    const caps = capsOf(acp.info)
    if (caps.loadSession === true) {
      await acp.agent.request("session/load", { sessionId, cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, sessionId, cwd)
      return "loaded"
    }
    try {
      await acp.agent.request("session/resume", { sessionId, cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, sessionId, cwd)
      return "resumed"
    } catch {
      return "unsupported"
    }
  }

  respondPermission(requestId: number, optionId: string | null): void {
    const resolve = this.pending.get(requestId)
    if (!resolve) return
    this.pending.delete(requestId)
    this.events.onPermissionDone(requestId)
    resolve(optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId })
  }

  // —— 内部 ——

  private handlePermission(agentId: string, req: RequestPermissionRequest): Promise<RequestPermissionOutcome> {
    const requestId = ++this.permSeq
    return new Promise<RequestPermissionOutcome>((resolve) => {
      this.pending.set(requestId, resolve)
      this.events.onPermissionRequest({
        requestId,
        agentId,
        sessionId: req.sessionId,
        toolCall: req.toolCall,
        options: req.options,
      })
    })
  }

  private rejectPendingCancelled(): void {
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id)
      this.events.onPermissionDone(id)
      resolve({ outcome: "cancelled" })
    }
  }

  private ready(agentId: string): { acp: AcpConnection } {
    const r = this.rt(agentId)
    if (!r.acp) throw new Error(`agent ${agentId} 未就绪（当前 ${r.status}）`)
    return { acp: r.acp }
  }

  private rt(agentId: string): Runtime {
    const r = this.agents.get(agentId)
    if (!r) throw new Error(`未知 agent: ${agentId}`)
    return r
  }

  private view(r: Runtime): AgentStatusView {
    const caps = r.acp ? capsOf(r.acp.info) : {}
    return {
      agentId: r.def.name,
      name: r.def.name,
      builtin: r.def.builtin,
      status: r.status,
      error: r.status === "error" ? r.errorMsg : undefined,
      loadSupported: caps.loadSession === true,
      listSupported: caps.sessionCapabilities?.list != null,
      authMethods:
        r.acp?.info.authMethods?.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          type: m.type,
        })) ?? [],
    }
  }

  private setStatus(r: Runtime, status: AgentStatus): void {
    r.status = status
    this.events.onAgentStatus(r.def.name, this.view(r))
  }
}
```

> `AgentStatusView.authMethods` 需含 `type` 字段 → 在 Task 8 的 `bridge-protocol.ts` 定义为 `{ id; name; description?; type: "agent" | "terminal" }[]`；本任务先建 `bridge-protocol.ts` 的最小骨架（只放类型，无逻辑），或把 Task 8 提前。**执行顺序：先做 Task 8 Step 1（仅类型文件），再跑本任务测试。**

- [ ] **Step 4: 创建 bridge-protocol.ts（仅类型部分）**

```ts
// src/shared/bridge-protocol.ts
export type AgentAuthMethodView = {
  id: string
  name: string
  description?: string
  type: "agent" | "terminal"
}

export type AgentStatusView = {
  agentId: string
  name: string
  builtin: boolean
  status: "stopped" | "starting" | "ready" | "error" | "needs-auth"
  error?: string
  loadSupported: boolean
  listSupported: boolean
  authMethods: AgentAuthMethodView[]
}

export type SessionMetaView = { sessionId: string; cwd: string; title?: string; updatedAt: string | number }

export type BridgeCommand =
  | { type: "agent.start"; agentId: string }
  | { type: "agent.stop"; agentId: string }
  | { type: "session.new"; agentId: string; cwd: string }
  | { type: "session.open"; agentId: string; sessionId: string; cwd: string }
  | { type: "session.list"; agentId: string; cwd?: string }
  | { type: "session.prompt"; agentId: string; sessionId: string; text: string }
  | { type: "session.cancel"; agentId: string; sessionId: string }
  | { type: "permission.respond"; requestId: number; optionId: string | null }
  | { type: "auth.retry"; agentId: string }

export type BridgeEvent =
  | { type: "snapshot"; agents: AgentStatusView[] }
  | { type: "agent.status"; agent: AgentStatusView }
  | { type: "session.list"; agentId: string; sessions: SessionMetaView[] }
  | { type: "session.opened"; agentId: string; sessionId: string; cwd: string }
  | { type: "session.update"; agentId: string; sessionId: string; update: unknown }
  | { type: "prompt.done"; agentId: string; sessionId: string; stopReason: string }
  | { type: "prompt.error"; agentId: string; sessionId: string | null; message: string }
  | { type: "permission.request"; requestId: number; agentId: string; sessionId: string; toolCall: unknown; options: unknown[] }
  | { type: "permission.done"; requestId: number }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run tests/store.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/store.ts src/shared/bridge-protocol.ts tests/store.test.ts
git commit -m "feat: AgentStore orchestration (lifecycle, permission, auth, recovery)"
```

---

### Task 8: Hono app + WS 桥 + main 入口

**Files:** Create `src/server/app.ts`、`src/server/main.ts`；Test `tests/app.test.ts`

- [ ] **Step 1: 写失败测试（HTTP 鉴权 + WS 端到端，真子进程 fake agent）**

```ts
// tests/app.test.ts
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import type { BridgeCommand, BridgeEvent } from "../src/shared/bridge-protocol"
import { createHarness, type Harness } from "./app-harness"

const CHILD = path.resolve("tests/fake-agent-child.ts")

describe("app", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness([
      { name: "fake", command: process.execPath, args: ["--import", "tsx", CHILD], env: {}, builtin: false },
    ])
  })
  afterAll(() => h.close())

  it("未带 token 的 HTTP 请求 → 401；带 token → 200", async () => {
    const no = await h.request("/api/health")
    expect(no.status).toBe(401)
    const ok = await h.request(`/api/health?token=${h.token}`)
    expect(ok.status).toBe(200)
  })

  it("WS 全链路：snapshot → agent.start → session.new → prompt 收流", async () => {
    const ws = await h.connectWs()
    const snapshot = (await ws.next())!
    expect(snapshot.type).toBe("snapshot")

    ws.send({ type: "agent.start", agentId: "fake" } satisfies BridgeCommand)
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")

    ws.send({ type: "session.new", agentId: "fake", cwd: "C:/tmp" } satisfies BridgeCommand)
    const opened = await ws.next((e) => e.type === "session.opened")
    const sessionId = (opened as { sessionId: string }).sessionId

    ws.send({ type: "session.prompt", agentId: "fake", sessionId, text: "hi" } satisfies BridgeCommand)
    const sawUpdate = await ws.next((e) => e.type === "session.update")
    expect((sawUpdate as { update: { sessionUpdate: string } }).update.sessionUpdate).toBeTruthy()
    const done = await ws.next((e) => e.type === "prompt.done")
    expect((done as { stopReason: string }).stopReason).toBe("end_turn")
    ws.close()
  }, 20000)

  it("权限流：permission.request → permission.respond → permission.done", async () => {
    // 用带 FAKE_ASK_PERMISSION 的第二个 agent
    const h2 = await createHarness([
      {
        name: "fakeperm",
        command: process.execPath,
        args: ["--import", "tsx", CHILD],
        env: { FAKE_ASK_PERMISSION: "1" },
        builtin: false,
      },
    ])
    const ws = await h2.connectWs()
    await ws.next() // snapshot
    ws.send({ type: "agent.start", agentId: "fakeperm" })
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")
    ws.send({ type: "session.new", agentId: "fakeperm", cwd: "C:/tmp" })
    const opened = (await ws.next((e) => e.type === "session.opened")) as { sessionId: string }
    ws.send({ type: "session.prompt", agentId: "fakeperm", sessionId: opened.sessionId, text: "go" })
    const perm = (await ws.next((e) => e.type === "permission.request")) as { requestId: number }
    ws.send({ type: "permission.respond", requestId: perm.requestId, optionId: "reject" })
    const doneEv = (await ws.next((e) => e.type === "permission.done")) as { requestId: number }
    expect(doneEv.requestId).toBe(perm.requestId)
    await ws.next((e) => e.type === "prompt.done")
    h2.close()
  }, 20000)
})
```

- [ ] **Step 2: 写测试脚手架 app-harness.ts**

```ts
// tests/app-harness.ts
import { serve } from "@hono/node-server"
import { WebSocket } from "ws"
import type { BridgeCommand, BridgeEvent } from "../src/shared/bridge-protocol"
import { createApp, createHub } from "../src/server/app"
import { SessionCache } from "../src/server/session-cache"
import { AgentStore, type StoreEvents } from "../src/server/store"
import type { AgentDef } from "../src/shared/agent-def"

export type Harness = {
  token: string
  port: number
  request(path: string): Promise<Response>
  connectWs(): Promise<{ next(pred?: (e: BridgeEvent) => boolean): Promise<BridgeEvent | null>; send(c: BridgeCommand): void; close(): void }>
  close(): Promise<void>
}

export async function createHarness(defs: AgentDef[]): Promise<Harness> {
  const token = "test-token"
  const hub = createHub()
  const cache = new SessionCache(h.cacheDir)
  const store = new AgentStore(defs, wireEvents(hub, cache, undefined))
  const { app, injectWebSocket } = createApp({ token, store, hub, cache })
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  injectWebSocket(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as { port: number }).port

  return {
    token,
    port,
    request: (p) => fetch(`http://127.0.0.1:${port}${p}`),
    connectWs: () => connectWs(port, token),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function wireEvents(...args: unknown[]): StoreEvents {
  // 与 src/server/main.ts 的 wireStoreEvents 同构；Task 8 Step 4 实现后从 main 导出复用
  throw new Error("implemented in Step 4")
}

async function connectWs(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  const queue: BridgeEvent[] = []
  const waiters: Array<{ pred?: (e: BridgeEvent) => boolean; resolve: (e: BridgeEvent) => void }> = []
  ws.on("message", (raw) => {
    const e = JSON.parse(String(raw)) as BridgeEvent
    const i = waiters.findIndex((w) => !w.pred || w.pred(e))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(e)
    else queue.push(e)
  })
  return {
    next: (pred?: (e: BridgeEvent) => boolean) =>
      queue.length
        ? Promise.resolve(shift(queue, pred))
        : new Promise<BridgeEvent | null>((resolve) => waiters.push({ pred, resolve })),
    send: (c: BridgeCommand) => ws.send(JSON.stringify(c)),
    close: () => ws.close(),
  }
  function shift(q: BridgeEvent[], pred?: (e: BridgeEvent) => boolean): BridgeEvent | null {
    if (!pred) return q.shift() ?? null
    const i = q.findIndex(pred)
    return i >= 0 ? q.splice(i, 1)[0] : null
  }
}
```

> 说明：`next()` 对「已缓冲事件里找匹配」和「等待未来事件」都要生效——上面 `next` 的 queue 分支需要同样处理 pred 不匹配的情况；实现时把逻辑统一为：若 queue 中有匹配则返回；否则挂 waiter。若 queue 有事件但不匹配 pred，**不要**丢弃，继续挂 waiter（修正 `next` 的 queue 分支：`const i = pred ? q.findIndex(pred) : 0; return i >= 0 ? q.splice(i,1)[0] : waitFor()`）。

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run tests/app.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 app.ts 与 main.ts**

```ts
// src/server/app.ts
import { createNodeWebSocket } from "@hono/node-ws"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import type { WSContext } from "hono/ws"
import { existsSync } from "node:fs"
import type { BridgeCommand, BridgeEvent } from "../shared/bridge-protocol"
import type { SessionCache } from "./session-cache"
import type { AgentStore, StoreEvents } from "./store"

export type Hub = {
  emit(e: BridgeEvent): void
  subscribe(fn: (e: BridgeEvent) => void): () => void
}

export function createHub(): Hub {
  const subs = new Set<(e: BridgeEvent) => void>()
  return {
    emit: (e) => subs.forEach((fn) => fn(e)),
    subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
  }
}

/** store 事件 → bridge 事件（main 与测试共用）。 */
export function wireStoreEvents(hub: Hub, cache: SessionCache, listSessionsOf?: (agentId: string, cwd?: string) => Promise<unknown>): StoreEvents {
  return {
    onAgentStatus: (_agentId, view) => hub.emit({ type: "agent.status", agent: view }),
    onSessionUpdate: (agentId, n) => {
      hub.emit({ type: "session.update", agentId, sessionId: n.sessionId, update: n.update })
    },
    onPermissionRequest: (p) => hub.emit({ type: "permission.request", ...p }),
    onPermissionDone: (requestId) => hub.emit({ type: "permission.done", requestId }),
    onPromptDone: (agentId, sessionId, stopReason) => hub.emit({ type: "prompt.done", agentId, sessionId, stopReason }),
    onPromptError: (agentId, sessionId, message) => hub.emit({ type: "prompt.error", agentId, sessionId, message }),
    onSessionOpened: (agentId, sessionId, cwd) => hub.emit({ type: "session.opened", agentId, sessionId, cwd }),
    onSessionList: (agentId, sessions) => hub.emit({ type: "session.list", agentId, sessions }),
  }
}

export type AppDeps = { token: string; store: AgentStore; hub: Hub; cache: SessionCache; staticRoot?: string }

export function createApp(deps: AppDeps) {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  const sockets = new Set<WSContext>()
  const broadcast = (e: BridgeEvent) => {
    const s = JSON.stringify(e)
    for (const w of sockets) w.send(s)
  }
  deps.hub.subscribe(broadcast)

  // 鉴权：HTTP 与 WS 升级共用（浏览器 WS 无法带 header，用 query token）
  app.use("/api/*", async (c, next) => {
    const t = c.req.query("token") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
    if (t !== deps.token) return c.text("unauthorized", 401)
    await next()
  })

  app.get("/api/health", (c) => c.json({ ok: true }))

  app.get(
    "/api/ws",
    upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => {
        sockets.add(ws)
        ws.send(JSON.stringify({ type: "snapshot", agents: deps.store.list() } satisfies BridgeEvent))
      },
      onMessage: (evt, ws) => {
        const cmd = JSON.parse(String(evt.data)) as BridgeCommand
        void dispatch(ws, cmd)
      },
      onClose: (_evt, ws) => sockets.delete(ws),
    })),
  )

  async function dispatch(ws: WSContext, cmd: BridgeCommand): Promise<void> {
    const s = deps.store
    try {
      switch (cmd.type) {
        case "agent.start":
          await s.start(cmd.agentId)
          break
        case "agent.stop":
          s.stop(cmd.agentId)
          break
        case "session.new": {
          const sessionId = await s.newSession(cmd.agentId, cmd.cwd)
          ws.send(JSON.stringify({ type: "session.opened", agentId: cmd.agentId, sessionId, cwd: cmd.cwd } satisfies BridgeEvent))
          break
        }
        case "session.open": {
          const mode = await s.openSession(cmd.agentId, cmd.sessionId, cmd.cwd)
          if (mode === "unsupported") {
            ws.send(JSON.stringify({ type: "prompt.error", agentId: cmd.agentId, sessionId: cmd.sessionId, message: "该 agent 不支持会话恢复" } satisfies BridgeEvent))
          }
          break
        }
        case "session.list":
          await s.listSessions(cmd.agentId, cmd.cwd)
          break
        case "session.prompt":
          void s.prompt(cmd.agentId, cmd.sessionId, cmd.text)
          break
        case "session.cancel":
          s.cancel(cmd.agentId, cmd.sessionId)
          break
        case "permission.respond":
          s.respondPermission(cmd.requestId, cmd.optionId)
          break
        case "auth.retry":
          await s.authenticate(cmd.agentId).catch((e) => {
            ws.send(JSON.stringify({ type: "prompt.error", agentId: cmd.agentId, sessionId: null, message: String((e as Error).message ?? e) } satisfies BridgeEvent))
          })
          break
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "prompt.error", agentId: "agentId" in cmd ? cmd.agentId : "", sessionId: null, message: String((e as Error)?.message ?? e) } satisfies BridgeEvent))
    }
  }

  // 生产静态服务（dev 由 vite 5173 提供，走 proxy）
  if (deps.staticRoot && existsSync(deps.staticRoot)) {
    app.use("*", serveStatic({ root: deps.staticRoot }))
    app.get("*", serveStatic({ root: deps.staticRoot, rewriteRequestPath: () => "/index.html" }))
  }

  return { app, injectWebSocket }
}
```

```ts
// src/server/main.ts
import crypto from "node:crypto"
import { existsSync } from "node:fs"
import { serve } from "@hono/node-server"
import { configDir, loadAgentDefs } from "./config"
import { createApp, createHub, wireStoreEvents } from "./app"
import { SessionCache } from "./session-cache"
import { AgentStore } from "./store"

const token = crypto.randomBytes(24).toString("base64url")
const dir = configDir()
const defs = loadAgentDefs(dir)
const hub = createHub()
const cache = new SessionCache(dir)
const store = new AgentStore(defs, wireStoreEvents(hub, cache))
const { app, injectWebSocket } = createApp({ token, store, hub, cache, staticRoot: "dist/web" })

const port = Number(process.env.ACP_CLIENT_PORT ?? 3111)
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" })
injectWebSocket(server)

console.log(`\n  acp-client 已启动 → http://127.0.0.1:${port}/?token=${token}\n  agents: ${defs.map((d) => d.name).join(", ")}\n`)
```

> `wireStoreEvents` 的 `cache` 参数在 v1 用于 `onSessionOpened` 时更新缓存：把实现补全为在 `onSessionOpened` 里 `cache.upsert(agentId, { sessionId, cwd, updatedAt: Date.now() })`；`onSessionUpdate` 里 `cache.touch(agentId, n.sessionId, Date.now())`。上方骨架已留参数，实现时补这两行。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run tests/app.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/main.ts tests/app.test.ts tests/app-harness.ts
git commit -m "feat: hono server with token auth, ws bridge, static serving"
```

---

### Task 9: 前端状态机 state.ts

**Files:** Create `src/web/state.ts`；Test `tests/state.test.ts`

- [ ] **Step 1: 写失败测试（纯 reducer 逻辑）**

```ts
// tests/state.test.ts
import { describe, expect, it } from "vitest"
import { initialFrontState, reduceEvent } from "../src/web/state"
import type { BridgeEvent } from "../src/shared/bridge-protocol"

const key = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

describe("reduceEvent", () => {
  it("agent_message_chunk 合并进同一个 assistant 块", () => {
    let s = initialFrontState()
    const aid = "a1", sid = "s1"
    s = reduceEvent(s, { type: "session.opened", agentId: aid, sessionId: sid, cwd: "C:/" } as BridgeEvent)
    const upd = (text: string) => ({ type: "session.update", agentId: aid, sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }) as BridgeEvent
    s = reduceEvent(s, upd("你好，"))
    s = reduceEvent(s, upd("世界"))
    const blocks = s.blocks[key(aid, sid)]!
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: "assistant-text", text: "你好，世界" })
  })

  it("tool_call → tool_call_update 按 toolCallId 打补丁", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "grep", status: "in_progress" } } as BridgeEvent)
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } } as BridgeEvent)
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: "tool", toolCallId: "t1", status: "completed", title: "grep" })
  })

  it("未知 variant 宽容降级为 unknown 块（ADR-0003）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "plan_update", entries: [] } } as BridgeEvent)
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks.at(-1)!.kind).toBe("unknown")
  })

  it("permission.request 设置挂起态，permission.done 清除", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "permission.request", requestId: 7, agentId: "a", sessionId: "s", toolCall: {}, options: [] } as BridgeEvent)
    expect(s.permission?.requestId).toBe(7)
    s = reduceEvent(s, { type: "permission.done", requestId: 7 } as BridgeEvent)
    expect(s.permission).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/state.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/web/state.ts
import { create } from "zustand"
import type { BridgeEvent, SessionMetaView } from "../shared/bridge-protocol"

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; toolCallId: string; title?: string; toolKind?: string; status?: string; content?: unknown[] }
  | { kind: "unknown"; sessionUpdate: string }

export type PermissionView = { requestId: number; agentId: string; sessionId: string; toolCall: unknown; options: Array<{ optionId: string; name: string; kind: string }> }

export type FrontState = {
  agents: Record<string, import("../shared/bridge-protocol").AgentStatusView>
  sessions: Record<string, SessionMetaView[]>
  blocks: Record<string, Block[]>
  openOrder: string[]
  activeKey: string | null
  permission: PermissionView | null
  busy: Record<string, boolean>
  connected: boolean
}

export const initialFrontState: FrontState = {
  agents: {},
  sessions: {},
  blocks: {},
  openOrder: [],
  activeKey: null,
  permission: null,
  busy: {},
  connected: false,
}

export const sessionKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(textOf).join("")
  if (content && typeof content === "object" && (content as { type?: string }).type === "text") {
    return (content as { text?: string }).text ?? ""
  }
  return content == null ? "" : `[${(content as { type?: string }).type ?? "content"}]`
}

function withBlocks(s: FrontState, agentId: string, sessionId: string, fn: (blocks: Block[]) => Block[]): FrontState {
  const k = sessionKey(agentId, sessionId)
  return { ...s, blocks: { ...s.blocks, [k]: fn(s.blocks[k] ?? []) } }
}

function reduceSessionUpdate(s: FrontState, agentId: string, sessionId: string, update: any): FrontState {
  const kind = update?.sessionUpdate as string | undefined
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
    const target = kind === "agent_message_chunk" ? "assistant-text" : kind === "agent_thought_chunk" ? "thought" : "user"
    const text = textOf((update as { content?: unknown }).content)
    return withBlocks(s, agentId, sessionId, (blocks) => {
      const last = blocks.at(-1)
      if (last && last.kind === target) {
        return [...blocks.slice(0, -1), { ...last, text: (last as { text: string }).text + text }]
      }
      return [...blocks, { kind: target, text } as Block]
    })
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const u = update as { toolCallId: string; title?: string; kind?: string; status?: string; content?: unknown[] }
    return withBlocks(s, agentId, sessionId, (blocks) => {
      const i = blocks.findIndex((b) => b.kind === "tool" && b.toolCallId === u.toolCallId)
      if (i < 0) {
        return [...blocks, { kind: "tool", toolCallId: u.toolCallId, title: u.title, toolKind: u.kind, status: u.status, content: u.content }]
      }
      const prev = blocks[i] as Extract<Block, { kind: "tool" }>
      const merged = { ...prev, title: u.title ?? prev.title, toolKind: u.kind ?? prev.toolKind, status: u.status ?? prev.status, content: u.content ?? prev.content }
      return [...blocks.slice(0, i), merged, ...blocks.slice(i + 1)]
    })
  }
  return withBlocks(s, agentId, sessionId, (blocks) => [
    ...blocks,
    { kind: "unknown", sessionUpdate: String(kind ?? "unknown") },
  ])
}

export function reduceEvent(s: FrontState, e: BridgeEvent): FrontState {
  switch (e.type) {
    case "snapshot":
      return { ...s, agents: Object.fromEntries(e.agents.map((a) => [a.agentId, a])) }
    case "agent.status":
      return { ...s, agents: { ...s.agents, [e.agent.agentId]: e.agent } }
    case "session.list":
      return { ...s, sessions: { ...s.sessions, [e.agentId]: e.sessions } }
    case "session.opened": {
      const k = sessionKey(e.agentId, e.sessionId)
      const openOrder = s.openOrder.includes(k) ? s.openOrder : [...s.openOrder, k]
      return { ...s, openOrder, activeKey: k, blocks: { ...s.blocks, [k]: s.blocks[k] ?? [] } }
    }
    case "session.update":
      return reduceSessionUpdate(s, e.agentId, e.sessionId, e.update)
    case "prompt.done": {
      const busy = { ...s.busy, [sessionKey(e.agentId, e.sessionId)]: false }
      return { ...s, busy }
    }
    case "prompt.error": {
      const k2 = e.sessionId ? sessionKey(e.agentId, e.sessionId) : ""
      const busy = { ...s.busy, ...(k2 ? { [k2]: false } : {}) }
      return { ...s, busy, lastError: e.message } as FrontState & { lastError: string }
    }
    case "permission.request":
      return { ...s, permission: { requestId: e.requestId, agentId: e.agentId, sessionId: e.sessionId, toolCall: e.toolCall, options: e.options as PermissionView["options"] } }
    case "permission.done":
      return s.permission?.requestId === e.requestId ? { ...s, permission: null } : s
    default:
      return s
  }
}

export const useFront = create<FrontState & { apply: (e: BridgeEvent) => void }>((set) => ({
  ...initialFrontState,
  apply: (e) => set((s) => reduceEvent(s, e)),
}))
```

> `lastError` 不在 `FrontState` 里——把 `lastError?: string` 直接加进 `FrontState` 定义，删掉 `as FrontState & { lastError }` 的补丁写法（上面实现处直接改）。`prompt.error` 的 sessionId 可能与打开的会话无关：仍按 key 关闭 busy，UI 在顶部横幅显示 lastError。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/state.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/state.ts tests/state.test.ts
git commit -m "feat: frontend state reducer with tolerant update handling"
```

---

### Task 10: WS 客户端 + UI 组件 + i18n

**Files:** Create `src/web/ws.ts`、`src/web/i18n.ts`、`src/web/App.tsx`（重写）、`src/web/components/*.tsx`；Modify `src/styles.css`

无组件单测（逻辑已在 state.ts 覆盖）；验收 = `pnpm dev` + fake agent 手动过一遍清单（见 Task 12）。

- [ ] **Step 1: ws.ts（连接 + token + 自动重连）**

```ts
// src/web/ws.ts
import type { BridgeCommand, BridgeEvent } from "../shared/bridge-protocol"

let ws: WebSocket | null = null
let retry = 0

export function bridgeToken(): string {
  return new URLSearchParams(window.location.search).get("token") ?? ""
}

export function connectBridge(onEvent: (e: BridgeEvent) => void, onState: (connected: boolean) => void): () => void {
  const open = () => {
    ws = new WebSocket(`ws://${window.location.host}/api/ws?token=${bridgeToken()}`)
    ws.onopen = () => { retry = 0; onState(true) }
    ws.onmessage = (m) => onEvent(JSON.parse(String(m.data)) as BridgeEvent)
    ws.onclose = () => {
      onState(false)
      if (retry++ < 10) setTimeout(open, Math.min(1000 * 2 ** retry, 10000))
    }
  }
  open()
  return () => { if (ws) ws.onclose = null; ws?.close() }
}

export function sendCommand(cmd: BridgeCommand): void {
  ws?.send(JSON.stringify(cmd))
}
```

- [ ] **Step 2: i18n.ts**

```ts
// src/web/i18n.ts
// 中文文案集中此处；键结构为后续 en 预留（共识 Q10）
export const zh = {
  title: "ACP 客户端",
  start: "启动",
  stop: "停止",
  restarting: "已停止，点击启动",
  offline: "Agent 进程已退出",
  error: "出错",
  needsAuth: "需要认证",
  authGuide: "请在你的系统终端运行以下命令完成登录，然后点击重试：",
  retryAuth: "重试",
  newSession: "新建会话",
  cwdPlaceholder: "项目目录的绝对路径",
  listSessions: "会话列表",
  loadUnsupported: "该 agent 不支持会话恢复",
  send: "发送",
  cancel: "停止生成",
  composerPlaceholder: "输入消息，Enter 发送，Shift+Enter 换行",
  permissionTitle: "权限请求",
  permissionFrom: "Agent 请求执行以下操作：",
  unknownUpdate: "未知的更新类型",
  disconnected: "与服务端断开，重连中…",
} as const
export type I18n = typeof zh
export const t = zh
```

- [ ] **Step 3: 组件（完整实现）**

```tsx
// src/web/components/AgentSidebar.tsx
import { useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function AgentSidebar() {
  const agents = useFront((s) => s.agents)
  const [cwd, setCwd] = useState("C:/")
  return (
    <aside className="sidebar">
      {Object.values(agents).map((a) => (
        <div key={a.agentId} className={`agent agent-${a.status}`}>
          <div className="agent-head">
            <b>{a.name}</b>
            <span className="badge">{t[a.status as keyof typeof t] ?? a.status}</span>
          </div>
          {a.status === "stopped" && <button onClick={() => sendCommand({ type: "agent.start", agentId: a.agentId })}>{t.start}</button>}
          {a.status === "ready" && <button onClick={() => sendCommand({ type: "agent.stop", agentId: a.agentId })}>{t.stop}</button>}
          {(a.status === "ready" || a.status === "needs-auth") && (
            <div className="new-session">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={t.cwdPlaceholder} />
              <button onClick={() => sendCommand({ type: "session.new", agentId: a.agentId, cwd })} disabled={a.status !== "ready"}>
                {t.newSession}
              </button>
              {a.listSupported && (
                <button onClick={() => sendCommand({ type: "session.list", agentId: a.agentId, cwd })}>{t.listSessions}</button>
              )}
            </div>
          )}
          {a.status === "error" && <div className="err">{a.error}</div>}
          <SessionList agentId={a.agentId} />
        </div>
      ))}
    </aside>
  )
}

function SessionList({ agentId }: { agentId: string }) {
  const sessions = useFront((s) => s.sessions[agentId]) ?? []
  if (!sessions.length) return null
  return (
    <ul className="session-list">
      {sessions.map((s) => (
        <li key={s.sessionId}>
          <button onClick={() => sendCommand({ type: "session.open", agentId, sessionId: s.sessionId, cwd: s.cwd })}>
            {s.title ?? s.sessionId}
          </button>
        </li>
      ))}
    </ul>
  )
}
```

```tsx
// src/web/components/SessionView.tsx
import { useFront } from "../state"
import { MessageList } from "./MessageList"
import { Composer } from "./Composer"
import { t } from "../i18n"

export function SessionView() {
  const activeKey = useFront((s) => s.activeKey)
  if (!activeKey) return <main className="main empty">选择或新建会话</main>
  const [agentId, sessionId] = activeKey.split(":")
  return (
    <main className="main">
      <MessageList agentId={agentId} sessionId={sessionId} />
      <Composer agentId={agentId} sessionId={sessionId} />
    </main>
  )
}
```

```tsx
// src/web/components/MessageList.tsx
import { useEffect, useRef } from "react"
import { useFront } from "../state"
import { ToolCallCard } from "./ToolCallCard"
import { t } from "../i18n"

export function MessageList({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const blocks = useFront((s) => s.blocks[`${agentId}:${sessionId}`]) ?? []
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [blocks.length])
  return (
    <div className="messages">
      {blocks.map((b, i) => {
        if (b.kind === "tool") return <ToolCallCard key={b.toolCallId + i} block={b} />
        if (b.kind === "unknown") return <div key={i} className="unknown">{t.unknownUpdate}: {b.sessionUpdate}</div>
        return (
          <div key={i} className={`msg msg-${b.kind}`}>
            <pre>{b.text}</pre>
          </div>
        )
      })}
      <div ref={bottom} />
    </div>
  )
}
```

```tsx
// src/web/components/ToolCallCard.tsx
import type { Block } from "../state"

export function ToolCallCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const statusIcon = { pending: "…", in_progress: "⏳", completed: "✔", failed: "✘" }[block.status ?? "pending"] ?? "·"
  return (
    <div className={`tool tool-${block.status ?? "pending"}`}>
      <div className="tool-head">
        <span>{statusIcon}</span>
        <b>{block.title ?? block.toolCallId}</b>
        {block.toolKind && <span className="badge">{block.toolKind}</span>}
      </div>
      {Array.isArray(block.content) && (
        <pre className="tool-content">{JSON.stringify(block.content, null, 2)}</pre>
      )}
    </div>
  )
}
```

```tsx
// src/web/components/PermissionModal.tsx
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function PermissionModal() {
  const p = useFront((s) => s.permission)
  if (!p) return null
  return (
    <div className="modal-mask">
      <div className="modal">
        <h3>{t.permissionTitle}</h3>
        <p>{t.permissionFrom}</p>
        <pre className="tool-content">{JSON.stringify(p.toolCall, null, 2)}</pre>
        <div className="modal-actions">
          {p.options.map((o) => (
            <button key={o.optionId} className={o.kind.startsWith("allow") ? "primary" : ""} onClick={() => sendCommand({ type: "permission.respond", requestId: p.requestId, optionId: o.optionId })}>
              {o.name}
            </button>
          ))}
          <button onClick={() => sendCommand({ type: "permission.respond", requestId: p.requestId, optionId: null })}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  )
}
```

```tsx
// src/web/components/AuthCard.tsx
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function AuthCard() {
  const agents = useFront((s) => s.agents)
  const needs = Object.values(agents).filter((a) => a.status === "needs-auth")
  if (!needs.length) return null
  return (
    <div className="auth-card">
      {needs.map((a) => (
        <div key={a.agentId}>
          <b>{a.name}</b> — {t.needsAuth}
          <p>{t.authGuide}</p>
          <code>{a.authMethods[0]?.description ?? a.authMethods[0]?.name ?? "（查看 agent 文档）"}</code>
          <button onClick={() => sendCommand({ type: "auth.retry", agentId: a.agentId })}>{t.retryAuth}</button>
        </div>
      ))}
    </div>
  )
}
```

```tsx
// src/web/components/Composer.tsx
import { useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function Composer({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [text, setText] = useState("")
  const busy = useFront((s) => s.busy[`${agentId}:${sessionId}`]) ?? false
  const status = useFront((s) => s.agents[agentId]?.status)
  const disabled = busy || status !== "ready"
  return (
    <div className="composer">
      <textarea
        value={text}
        disabled={disabled}
        placeholder={t.composerPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            if (!text.trim() || disabled) return
            sendCommand({ type: "session.prompt", agentId, sessionId, text })
            setText("")
          }
        }}
      />
      {busy ? (
        <button onClick={() => sendCommand({ type: "session.cancel", agentId, sessionId })}>{t.cancel}</button>
      ) : (
        <button disabled={disabled} onClick={() => { sendCommand({ type: "session.prompt", agentId, sessionId, text }); setText("") }}>
          {t.send}
        </button>
      )}
    </div>
  )
}
```

> prompt 的用户消息块在 `session/update` 里通常不回放（agent 不回推 user chunk）→ Composer 发送后直接本地补一个 user 块：在 `sendCommand({type:"session.prompt"...})` 前，向 store 派发一个本地合成事件？——**不做**。保持「服务端事件唯一事实源」，v1 的 user 消息回显依赖 agent 是否回推 `user_message_chunk`（dsh/opencode 均在 load 重放时回推；实时回显为已知取舍，记入 Task 12 验收清单观察项）。

- [ ] **Step 4: App.tsx 组装 + styles.css 追加**

```tsx
// src/web/App.tsx
import { useEffect } from "react"
import { connectBridge } from "./ws"
import { useFront } from "./state"
import { AgentSidebar } from "./components/AgentSidebar"
import { SessionView } from "./components/SessionView"
import { PermissionModal } from "./components/PermissionModal"
import { AuthCard } from "./components/AuthCard"
import { t } from "./i18n"

export function App() {
  const apply = useFront((s) => s.apply)
  const connected = useFront((s) => s.connected)
  useEffect(() => connectBridge(apply, (c) => useFront.setState({ connected: c })), [apply])
  return (
    <div className="app">
      {!connected && <div className="banner">{t.disconnected}</div>}
      <AuthCard />
      <div className="layout">
        <AgentSidebar />
        <SessionView />
      </div>
      <PermissionModal />
    </div>
  )
}
```

```css
/* src/styles.css 追加 */
.app { display: flex; flex-direction: column; height: 100vh; }
.banner, .auth-card { padding: 8px 16px; background: #3a2b1e; border-bottom: 1px solid var(--border); font-size: 13px; }
.auth-card code { display: block; margin: 6px 0; padding: 6px; background: #0a0e14; border-radius: 6px; }
.layout { display: flex; flex: 1; min-height: 0; }
.sidebar { width: 260px; border-right: 1px solid var(--border); padding: 12px; overflow-y: auto; background: var(--panel); }
.agent { border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.agent-ready .badge { color: #3fd68f; }
.agent-needs-auth .badge { color: #f7b84f; }
.agent-error .badge, .err { color: var(--danger); }
.badge { font-size: 11px; margin-left: 8px; }
.new-session { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.new-session input { flex: 1; min-width: 120px; }
input, textarea, button { background: #0a0e14; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font: inherit; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
button.primary { border-color: var(--accent); }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.main.empty { align-items: center; justify-content: center; color: var(--muted); }
.messages { flex: 1; overflow-y: auto; padding: 16px 24px; display: flex; flex-direction: column; gap: 10px; }
.msg pre { white-space: pre-wrap; word-break: break-word; font: inherit; padding: 10px 14px; border-radius: 10px; }
.msg-user pre { background: #1d2a3f; align-self: flex-end; max-width: 80%; }
.msg-assistant-text pre { background: var(--panel); }
.msg-thought pre { color: var(--muted); font-style: italic; background: transparent; }
.tool { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--panel); font-size: 13px; }
.tool-completed { border-color: #2b4a35; } .tool-failed { border-color: #4a2b2b; }
.tool-head { display: flex; gap: 8px; align-items: center; }
.tool-content { margin-top: 6px; font-size: 12px; color: var(--muted); max-height: 240px; overflow: auto; }
.unknown { color: var(--muted); font-size: 12px; }
.composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.composer textarea { flex: 1; height: 64px; resize: none; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; width: min(560px, 92vw); }
.modal-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.session-list { list-style: none; margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.session-list button { width: 100%; text-align: left; font-size: 12.5px; }
```

- [ ] **Step 5: 全量验证**

Run: `pnpm typecheck ; pnpm test`
Expected: typecheck 0 errors；全部测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/web src/styles.css
git commit -m "feat: browser UI (sidebar, chat, tool cards, permission modal, auth card)"
```

---

### Task 11: agents.example.json + dev 联调验证

**Files:** Create `agents.example.json`

- [ ] **Step 1: 写示例配置（含 fake agent，UI 无需真实 harness 即可联调）**

```json
{
  "agents": [
    { "name": "dsh", "command": "dsh", "args": ["--profile", "acp"], "env": {}, "builtin": true },
    { "name": "opencode", "command": "opencode", "args": ["acp"], "env": {}, "builtin": true },
    {
      "name": "fake",
      "command": "node",
      "args": ["--import", "tsx", "C:/Users/Wumd/Desktop/harness/acp-client/tests/fake-agent-child.ts"],
      "env": { "FAKE_ASK_PERMISSION": "1" }
    }
  ]
}
```

- [ ] **Step 2: 手动联调清单**

复制到 `%USERPROFILE%\.config\acp-client\agents.json`，然后：

Run: `pnpm dev`
打开 `http://localhost:5173/?token=`（token 从 server 终端输出复制；vite dev 时 proxy 透传，用 server 打印的 URL 换 host:port 即可）

验收清单（fake agent）：
1. fake agent 显示「启动」→ 点击 → 变「ready」
2. 新建会话 → 发消息 → 看到思考块、回复块、工具卡（in_progress → completed）
3. 触发权限弹窗 → 点 Reject → 会话继续结束（stopReason end_turn）
4. 断开 server（Ctrl+C）→ UI 顶部出现重连横幅；重启 server → 自动恢复

- [ ] **Step 3: Commit**

```bash
git add agents.example.json
git commit -m "chore: agents.example.json with fake agent for UI development"
```

---

### Task 12: 真实 harness 冒烟脚本（可选执行）

**Files:** Create `scripts/smoke.ts`

- [ ] **Step 1: 实现**

```ts
// scripts/smoke.ts
// 用法: pnpm smoke:dsh [cwd]   |   pnpm smoke:opencode [cwd]
// 前提: 对应 CLI 已安装并在 PATH；仅用于人工验证，不进 CI
import { loadAgentDefs } from "../src/server/config"
import { spawnAgentProcess } from "../src/server/agent-process"
import { connectAcp } from "../src/server/connection"

async function main() {
  const name = process.argv[2]
  const cwd = process.argv[3] ?? process.cwd()
  const def = loadAgentDefs().find((d) => d.name === name)
  if (!def) throw new Error(`未知 agent: ${name}`)

  console.log(`[smoke] 启动 ${def.command} ${def.args.join(" ")}`)
  const proc = spawnAgentProcess(def)
  const acp = await connectAcp(proc.stream, {
    onUpdate: (n) => {
      const u = n.update as { sessionUpdate: string; content?: { text?: string }; title?: string; status?: string }
      if (u.sessionUpdate.endsWith("_chunk")) console.log(`  [${u.sessionUpdate}]`, u.content?.text ?? "")
      else console.log(`  [${u.sessionUpdate}]`, u.title ?? u.status ?? "")
    },
    onRequestPermission: async (req) => {
      console.log(`  [权限请求]`, req.toolCall.title, "→ 自动拒绝")
      return { outcome: { outcome: "selected", optionId: req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId } }
    },
  })
  console.log(`[smoke] protocolVersion=${acp.info.protocolVersion} authMethods=${acp.info.authMethods.length}`)

  const { sessionId } = await acp.agent.request("session/new", { cwd, mcpServers: [] })
  console.log(`[smoke] sessionId=${sessionId}`)
  const res = await acp.agent.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "用一句话介绍这个目录里有什么，不要执行任何工具。" }],
  })
  console.log(`[smoke] stopReason=${res.stopReason}`)
  proc.kill()
  await proc.exit
  process.exit(0)
}

main().catch((e) => {
  console.error("[smoke] 失败:", e)
  process.exit(1)
})
```

- [ ] **Step 2: 对真实 harness 逐个冒烟（人工）**

Run: `pnpm smoke:dsh C:\Users\Wumd\Desktop\harness` 与 `pnpm smoke:opencode C:\Users\Wumd\Desktop\harness`
Expected: 各自打印 update 流与 `stopReason=end_turn`。任何失败记录到任务备注（如 PATH 里没有 dsh/opencode、Windows shell shim 问题）。

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "feat: optional real-harness smoke script"
```

---

### Task 13: 收尾验证

- [ ] **Step 1: 全量门禁**

Run: `pnpm typecheck ; pnpm test ; pnpm build`
Expected: typecheck 0 errors；测试全绿（≥15 tests）；`dist/web` 产出。

- [ ] **Step 2: 生产模式单端口验证**

Run: `pnpm build ; pnpm start`
打开终端打印的 `http://127.0.0.1:3111/?token=...`（Hono 直接服务 dist/web + WS）。
Expected: UI 正常；fake agent 全链路可用。

- [ ] **Step 3: 最终提交**

```bash
git add -A
git commit -m "chore: v1 complete (agent processes, permission bridge, chat UI)"
```

---

## 覆盖对照（共识 → 任务）

| 共识决策 | 任务 |
|---|---|
| 每 agent 长驻进程 + session 绑 cwd（ADR-0002） | Task 6/7 |
| 单 SDK 1.4.0 + 宽容解析（ADR-0003） | Task 5/9（unknown variant → placeholder 块） |
| transcript 归 agent + 会话缓存（ADR-0004） | Task 3/7（openSession 走 load/resume） |
| 权限 UI（v1 硬底线） | Task 5/7/8/10（PermissionModal） |
| 认证指引卡片（Q8-B） | Task 7（needs-auth + authenticate）/ Task 10（AuthCard） |
| 手动重启 + session/load 恢复（Q11-A） | Task 7（exit → stopped，不自动重启） |
| 127.0.0.1 + 随机 token（Q12-B） | Task 8（main.ts + 鉴权中间件） |
| fake agent 测试进 CI + 真实冒烟可选（Q13-C） | Task 4-8 全部 CI；Task 12 可选 |
| 仅全局 agents.json（Q14-A） | Task 2 |
| pnpm/单包/中文+i18n 键（Q15/Q10） | Task 0/10 |

## 已知取舍（写给实现者）

1. **user 消息实时回显**：依赖 agent 回推 `user_message_chunk`；不回推时 v1 不本地合成（服务端事件唯一事实源）。若验收体验差，v1.1 在 `session.prompt` 命令处理里广播一个本地 `session.update`。
2. **`spawn(shell:true)` 的参数拼接**：Windows 下 args 含空格需自行加引号；内置模板不受影响。
3. **prompt 进行中关页面**：pending permission 在连接关闭时已由 store 兜底 resolve cancelled；prompt 继续在 server 侧跑完（transcript 在 agent 侧，不丢）。
