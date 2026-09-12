// tests/app-harness.ts
// 起真实 HTTP+WS server（随机端口），提供 request / connectWs / close。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "@hono/node-server"
import { WebSocket } from "ws"
import type { BridgeCommand, BridgeEvent } from "../src/shared/bridge-protocol"
import { createApp, createHub, wireStoreEvents } from "../src/server/app"
import { SessionCache } from "../src/server/session-cache"
import { AgentStore } from "../src/server/store"
import type { AgentDef } from "../src/shared/agent-def"

export type WsClient = {
  next(pred?: (e: BridgeEvent) => boolean): Promise<BridgeEvent>
  send(c: BridgeCommand): void
  close(): void
}

export type Harness = {
  token: string
  port: number
  request(path: string): Promise<Response>
  connectWs(): Promise<WsClient>
  close(): Promise<void>
}

export async function createHarness(defs: AgentDef[]): Promise<Harness> {
  const token = "test-token"
  const hub = createHub()
  const cacheDir = mkdtempSync(path.join(tmpdir(), "acp-client-app-"))
  const cache = new SessionCache(cacheDir)
  const store = new AgentStore(defs, wireStoreEvents(hub, cache))
  const { app, injectWebSocket } = createApp({ token, store, hub, cache })
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  injectWebSocket(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as { port: number }).port

  const clients: WebSocket[] = []
  return {
    token,
    port,
    request: (p) => fetch(`http://127.0.0.1:${port}${p}`),
    connectWs: () => connectWs(port, token, clients),
    // 先断开所有 WS 客户端，否则 server.close() 会等既有连接而挂起
    close: async () => {
      for (const c of clients) c.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function connectWs(port: number, token: string, clients: WebSocket[]): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`)
  clients.push(ws)
  // 必须在 await open 之前注册：本地回环下 snapshot 帧可能与 101 同包到达，
  // open 之后再注册 listener 会丢掉已 emit 的 message（EventEmitter 无监听即丢弃）
  const queue: BridgeEvent[] = []
  const waiters: Array<{ pred?: (e: BridgeEvent) => boolean; resolve: (e: BridgeEvent) => void }> = []
  ws.on("message", (raw) => {
    const e = JSON.parse(String(raw)) as BridgeEvent
    const i = waiters.findIndex((w) => !w.pred || w.pred(e))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(e)
    else queue.push(e)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  return {
    // 统一语义：queue 中有匹配（或无 pred）则返回；否则挂 waiter 等未来事件。
    // 不匹配的缓冲事件保留在 queue 中，不丢弃。
    next: (pred?: (e: BridgeEvent) => boolean) => {
      const i = pred ? queue.findIndex(pred) : 0
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise<BridgeEvent>((resolve) => waiters.push({ pred, resolve }))
    },
    send: (c) => ws.send(JSON.stringify(c)),
    close: () => ws.close(),
  }
}
