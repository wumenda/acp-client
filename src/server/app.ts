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

/** store 事件 → bridge 事件（main 与测试 harness 共用），并维护会话缓存。 */
export function wireStoreEvents(hub: Hub, cache: SessionCache): StoreEvents {
  return {
    onAgentStatus: (_agentId, view) => hub.emit({ type: "agent.status", agent: view }),
    onSessionUpdate: (agentId, n) => {
      cache.touch(agentId, n.sessionId, Date.now())
      hub.emit({ type: "session.update", agentId, sessionId: n.sessionId, update: n.update })
    },
    onPermissionRequest: (p) => hub.emit({ type: "permission.request", ...p }),
    onPermissionDone: (requestId) => hub.emit({ type: "permission.done", requestId }),
    onPromptDone: (agentId, sessionId, stopReason) => hub.emit({ type: "prompt.done", agentId, sessionId, stopReason }),
    onPromptError: (agentId, sessionId, message) => hub.emit({ type: "prompt.error", agentId, sessionId, message }),
    onSessionOpened: (agentId, sessionId, cwd) => {
      cache.upsert(agentId, { sessionId, cwd, updatedAt: Date.now() })
      hub.emit({ type: "session.opened", agentId, sessionId, cwd })
    },
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
    for (const w of sockets) {
      // socket 关闭瞬间 readyState 可能已非 OPEN，此时 send 会抛错
      if (w.readyState === 1) w.send(s)
    }
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
