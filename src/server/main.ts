// src/server/main.ts
import crypto from "node:crypto"
import { serve } from "@hono/node-server"
import { createApp, createHub, wireStoreEvents } from "./app"
import { configDir, loadAgentDefs } from "./config"
import { SessionCache } from "./session-cache"
import { AgentStore, startAutoAgents } from "./store"

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

const autoStarted = startAutoAgents(store, defs)
console.log(`\n  acp-client 已启动 → http://127.0.0.1:${port}/?token=${token}\n  agents: ${defs.map((d) => d.name).join(", ")}\n  autoStart: ${autoStarted.join(", ") || "（无）"}\n`)
