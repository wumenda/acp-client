// src/server/app.ts
import { createNodeWebSocket } from "@hono/node-ws"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import type { WSContext } from "hono/ws"
import { existsSync } from "node:fs"
import type { BridgeCommand, BridgeEvent, RegistrySnapshot, SessionMetaView } from "../shared/bridge-protocol"
import type { AcpLog } from "./acp-log"
import type { FsGate } from "./fs-proxy"
import type { TerminalManager } from "./terminal-manager"
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
export function wireStoreEvents(hub: Hub, cache: SessionCache, log?: AcpLog): StoreEvents {
  return {
    onAgentStatus: (_agentId, view) => hub.emit({ type: "agent.status", agent: view }),
    onSessionUpdate: (agentId, n) => {
      cache.touch(agentId, n.sessionId, Date.now())
      // 动态标题：agent 生成标题后同步进缓存，刷新后仍可见（P1-8）
      const u = n.update as { sessionUpdate?: string; title?: unknown }
      if (u?.sessionUpdate === "session_info_update" && typeof u.title === "string" && u.title.length > 0) {
        cache.setTitle(agentId, n.sessionId, u.title)
      }
      hub.emit({ type: "session.update", agentId, sessionId: n.sessionId, update: n.update })
    },
    onAcpLog: log
      ? (agentId, dir, data) => log.push(agentId, dir, data)
      : undefined,
    onPermissionRequest: (p) => hub.emit({ type: "permission.request", ...p }),
    onPermissionDone: (requestId) => hub.emit({ type: "permission.done", requestId }),
    // fs 代理确认（P2-17）：confirm → 浏览器弹窗；done → 移除弹窗（应答/取消/断连统一收场）
    onFsConfirm: (p) => hub.emit({ type: "fs.confirm", ...p }),
    onFsDone: (requestId) => hub.emit({ type: "fs.done", requestId }),
    // terminal 代理确认（P2-18）：同构 fs 确认流
    onTermConfirm: (p) => hub.emit({ type: "term.confirm", ...p }),
    onTermDone: (requestId) => hub.emit({ type: "term.done", requestId }),
    // elicitation（P2-19）：form/url 请求转发浏览器；done 统一收场
    onElicitationRequest: (p) => hub.emit({ type: "elicitation.request", ...p }),
    onElicitationDone: (requestId, action) => hub.emit({ type: "elicitation.done", requestId, ...(action ? { action } : {}) }),
    onPromptDone: (agentId, sessionId, stopReason) => hub.emit({ type: "prompt.done", agentId, sessionId, stopReason }),
    onPromptError: (agentId, sessionId, message) => hub.emit({ type: "prompt.error", agentId, sessionId, message }),
    onSessionOpened: (agentId, sessionId, cwd, meta) => {
      cache.upsert(agentId, { sessionId, cwd, updatedAt: Date.now() })
      // 已缓存的动态标题随 opened 带回：恢复会话瞬间即显示名字，而非 ses_xxx
      const title = cache.list(agentId).find((s) => s.sessionId === sessionId)?.title
      hub.emit({ type: "session.opened", agentId, sessionId, cwd, ...(title ? { title } : {}), ...(meta ?? {}) })
    },
    onSessionList: (agentId, sessions) => hub.emit({ type: "session.list", agentId, sessions }),
  }
}

export type AppDeps = { token: string; store: AgentStore; hub: Hub; cache: SessionCache; log?: AcpLog; staticRoot?: string; fsGate?: FsGate; terminals?: TerminalManager; registry?: RegistryPort }

/** registry 服务端口（结构类型弱依赖：app.ts 不反向依赖 RegistryService 具体类型，P2-21） */
export type RegistryPort = {
  refresh(force: boolean): Promise<void>
  install(id: string): Promise<void>
  uninstall(id: string): void
  view(): RegistrySnapshot
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  const sockets = new Set<WSContext>()
  const logSubs = new Map<WSContext, () => void>()
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
        // 刷新恢复（P0-3）：snapshot 携带缓存的会话元数据，前端据此还原侧栏与活跃会话
        const sessions: Record<string, SessionMetaView[]> = {}
        for (const a of deps.store.list()) {
          sessions[a.agentId] = deps.cache.list(a.agentId).map((m) => ({
            sessionId: m.sessionId,
            cwd: m.cwd,
            title: m.title,
            updatedAt: m.updatedAt,
          }))
        }
        ws.send(JSON.stringify({ type: "snapshot", agents: deps.store.list(), sessions } satisfies BridgeEvent))
        // registry snapshot 补发（P2-21）：已有缓存数据时立即下发（refresh 异步补推后续变化）
        if (deps.registry && deps.registry.view().fetchedAt > 0) {
          ws.send(JSON.stringify({ type: "registry.snapshot", ...deps.registry.view() } satisfies BridgeEvent))
        }
      },
      onMessage: (evt, ws) => {
        const cmd = JSON.parse(String(evt.data)) as BridgeCommand
        void dispatch(ws, cmd)
      },
      onClose: (_evt, ws) => {
        sockets.delete(ws)
        logSubs.get(ws)?.()
        logSubs.delete(ws)
      },
    })),
  )

  async function dispatch(ws: WSContext, cmd: BridgeCommand): Promise<void> {
    const s = deps.store
    // session.closed 等定向回执经 hub 全量广播（会话列表对所有客户端可见性一致）
    const hubEmit = (e: BridgeEvent) => deps.hub.emit(e)
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
          // 刷新恢复时 agent 往往尚未就绪：先拉起进程再恢复会话（失败由 catch 上报）
          if (s.statusOf(cmd.agentId) !== "ready") await s.start(cmd.agentId)
          const mode = await s.openSession(cmd.agentId, cmd.sessionId, cmd.cwd)
          if (mode === "unsupported") {
            ws.send(JSON.stringify({ type: "prompt.error", agentId: cmd.agentId, sessionId: cmd.sessionId, message: "该 agent 不支持会话恢复" } satisfies BridgeEvent))
          }
          break
        }
        case "session.list":
          await s.listSessions(cmd.agentId, cmd.cwd)
          break
        case "session.prompt": {
          // 附件输入（P2-20）：dataURL → ContentBlock；image/* → 图片，audio/* → 音频（base64）
          const attachments = (cmd.attachments ?? []).map((dataUrl) => {
            const m = /^data:(image\/[-\w.]+|audio\/[-\w.]+);base64,(.+)$/s.exec(dataUrl)
            if (!m) throw new Error(`无法解析附件数据`)
            const [, mime, data] = m
            return mime.startsWith("audio/")
              ? { type: "audio" as const, mimeType: mime, data }
              : { type: "image" as const, mimeType: mime, data }
          })
          // 本地回显：立即广播 user_message_chunk，用户消息即时上屏（agent 侧是否回放与本次无关）；
          // 无附件时保持单 content 对象（与常见 agent 行为一致），有附件时回显完整 ContentBlock 序列
          const echo: unknown = attachments.length ? [...attachments, { type: "text", text: cmd.text }] : { type: "text", text: cmd.text }
          deps.hub.emit({
            type: "session.update",
            agentId: cmd.agentId,
            sessionId: cmd.sessionId,
            update: { sessionUpdate: "user_message_chunk", content: echo },
          } satisfies BridgeEvent)
          // 协议 ContentBlock 序列：附件在前文本在后（PromptRequest.prompt）
          void s.prompt(cmd.agentId, cmd.sessionId, [{ type: "text" as const, text: cmd.text }, ...attachments])
          break
        }
        case "session.cancel":
          s.cancel(cmd.agentId, cmd.sessionId)
          break
        case "session.close":
          await s.closeSession(cmd.agentId, cmd.sessionId)
          hubEmit({ type: "session.closed", agentId: cmd.agentId, sessionId: cmd.sessionId, deleted: false })
          break
        case "session.delete":
          await s.deleteSession(cmd.agentId, cmd.sessionId)
          deps.cache.remove(cmd.agentId, cmd.sessionId)
          hubEmit({ type: "session.closed", agentId: cmd.agentId, sessionId: cmd.sessionId, deleted: true })
          break
        case "log.subscribe": {
          // ACP 日志面板（§2.4-26）：订阅后先回放最近快照，再增量推送
          logSubs.get(ws)?.()
          logSubs.delete(ws)
          if (cmd.on && deps.log) {
            const { recent, unsubscribe } = deps.log.subscribe((e) => {
              if (ws.readyState === 1) ws.send(JSON.stringify(e))
            })
            for (const item of recent) {
              if (ws.readyState === 1) ws.send(JSON.stringify(item))
            }
            logSubs.set(ws, unsubscribe)
          }
          break
        }
        case "session.set_mode":
          await s.setMode(cmd.agentId, cmd.sessionId, cmd.modeId)
          break
        case "session.set_config_option":
          await s.setConfigOption(cmd.agentId, cmd.sessionId, cmd.configId, cmd.value)
          break
        case "permission.respond":
          s.respondPermission(cmd.requestId, cmd.optionId)
          break
        case "fs.respond":
          deps.fsGate?.respond(cmd.requestId, cmd.allowed)
          break
        case "term.respond":
          deps.terminals?.respond(cmd.requestId, cmd.allowed)
          break
        case "elicitation.respond":
          s.respondElicitation(cmd.requestId, cmd.action, cmd.content)
          break
        case "auth.retry":
          await s.authenticate(cmd.agentId).catch((e) => {
            ws.send(JSON.stringify({ type: "prompt.error", agentId: cmd.agentId, sessionId: null, message: String((e as Error).message ?? e) } satisfies BridgeEvent))
          })
          break
        case "registry.refresh":
          void deps.registry?.refresh(true).catch((e) => {
            hubEmit({ type: "prompt.error", agentId: "", sessionId: null, message: `registry 刷新失败: ${String((e as Error).message ?? e)}` })
          })
          break
        case "registry.install":
          // 异步长任务；失败进度经 events.onProgress(error) 广播，此处兜底 hub 广播错误详情
          void deps.registry?.install(cmd.id).catch((e) => {
            hubEmit({ type: "prompt.error", agentId: cmd.id, sessionId: null, message: `安装失败: ${String((e as Error).message ?? e)}` })
          })
          break
        case "registry.uninstall":
          deps.registry?.uninstall(cmd.id)
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
