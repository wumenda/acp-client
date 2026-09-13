// src/server/main.ts
import crypto from "node:crypto"
import { serve } from "@hono/node-server"
import { createApp, createHub, wireStoreEvents } from "./app"
import { AcpLog } from "./acp-log"
import { configDir, loadAgentDefs } from "./config"
import { FsGate } from "./fs-proxy"
import { TerminalManager } from "./terminal-manager"
import { RegistryService } from "./registry/service"
import { SessionCache } from "./session-cache"
import { AgentStore, startAutoAgents } from "./store"

const token = crypto.randomBytes(24).toString("base64url")

// SDK close 的预期噪音（tests/setup.ts 有详细说明）：记录但不让它影响进程
process.on("unhandledRejection", (reason) => {
  const msg = (reason as Error)?.message ?? String(reason)
  if (msg === "ACP connection closed") return
  console.error("[acp-client] unhandledRejection:", reason)
})

const dir = configDir()
const defs = loadAgentDefs(dir)
const hub = createHub()
const cache = new SessionCache(dir)
const log = new AcpLog()
const events = wireStoreEvents(hub, cache, log)
// fs 代理（P2-17）：会话 cwd 取自缓存（session.new/open 时建档），作为子树判定依据
const fsGate = new FsGate(
  (agentId, sessionId) => cache.list(agentId).find((s) => s.sessionId === sessionId)?.cwd,
  { onConfirm: (req) => events.onFsConfirm!(req), onDone: (requestId) => events.onFsDone!(requestId) },
)
// terminal 代理（P2-18）：命令执行一律确认
const terminals = new TerminalManager({
  onConfirm: (req) => events.onTermConfirm!(req),
  onDone: (requestId) => events.onTermDone!(requestId),
})
const store = new AgentStore(defs, events, fsGate, terminals)
// ACP Registry（P2-21）：索引缓存 + 安装/卸载编排；安装即动态注册，卸载先停再移除
const registry = new RegistryService({
  home: dir,
  events: {
    onSnapshot: (v) => hub.emit({ type: "registry.snapshot", ...v }),
    onProgress: (p) => hub.emit({ type: "registry.progress", ...p }),
    onInstalled: (def) => store.addAgent(def),
    onUninstalled: (id) => { try { store.stop(id) } catch { /* 未启动 */ } store.removeAgent(id) },
  },
})
const { app, injectWebSocket } = createApp({ token, store, hub, cache, log, staticRoot: "dist/web", fsGate, terminals, registry })

const port = Number(process.env.ACP_CLIENT_PORT ?? 3111)
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" })
injectWebSocket(server)

const autoStarted = startAutoAgents(store, defs)
console.log(`\n  acp-client 已启动 → http://127.0.0.1:${port}/?token=${token}\n  agents: ${defs.map((d) => d.name).join(", ")}\n  autoStart: ${autoStarted.join(", ") || "（无）"}\n`)
