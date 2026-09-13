// tests/registry-app.test.ts
// ACP Registry（P2-21）WS 全链路 e2e：fixture registry（binary 条目，archive 测试现场打包真
// launcher 脚本）→ registry.install（下载/校验/解压/注册）→ agent.start → session 全链路 → uninstall
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { BridgeEvent } from "../src/shared/bridge-protocol"
import { platformTarget } from "../src/server/registry/schema"
import { createHarness, type Harness } from "./app-harness"

const CHILD = path.resolve("tests/fake-agent-child.ts")
const AGENT_ID = "fake-registry-agent"
const TARGET = platformTarget() // 测试机本身就是受支持平台
const LAUNCHER = process.platform === "win32" ? "agent.cmd" : "agent.sh"

let http: Server
let registryUrl: string
let archiveUrl: string
let work: string

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "reg-e2e-"))
  // 包内是平台 launcher 脚本：解压后经固化的 AgentDef 直接启动 fake agent 子进程
  const pkg = path.join(work, "pkg")
  mkdirSync(pkg, { recursive: true })
  // shell:true 下 args 只拼接不转义（DEP0190），CHILD 路径自带引号
  if (process.platform === "win32") {
    writeFileSync(path.join(pkg, LAUNCHER), `@node --import tsx "${CHILD}" %*\r\n`)
  } else {
    writeFileSync(path.join(pkg, LAUNCHER), `#!/bin/sh\nexec node --import tsx '${CHILD}' "$@"\n`)
  }
  spawnSync("tar", ["-czf", path.join(work, "a.tgz"), "-C", pkg, "."])
  const buf = readFileSync(path.join(work, "a.tgz"))
  const fixtureSha = createHash("sha256").update(buf).digest("hex")

  http = createServer((req, res) => {
    if (req.url === "/a.tgz") { res.end(buf); return }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      version: "1.0.0",
      agents: [{
        id: AGENT_ID, name: "Fake Registry Agent", version: "1.0.0", description: "e2e fixture",
        distribution: {
          binary: {
            // sha256 在 listen 后已知；archive URL 指向同一 server（listen 后赋值，请求时已就绪）
            [TARGET]: { archive: `${archiveUrl}/a.tgz`, sha256: fixtureSha, cmd: LAUNCHER },
          },
        },
      }],
    }))
  })
  // 先 listen 拿到端口，再补 archive URL（/registry.json 在请求时才序列化，闭包读变量）
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
  archiveUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  registryUrl = `${archiveUrl}/registry.json`
})

afterAll(() => {
  http.close()
  rmSync(work, { recursive: true, force: true })
})

describe("registry ws e2e", () => {
  it("install(binary) → start → session.new → prompt end_turn → uninstall", async () => {
    const h: Harness = await createHarness([], { registryUrl })
    const ws = await h.connectWs()
    await ws.next((e) => e.type === "snapshot") // onOpen 主 snapshot

    // ⓪ 拉取目录（harness 的 RegistryService autoRefresh 关闭，等价前端打开弹窗时的 refresh）
    ws.send({ type: "registry.refresh" })
    const idx = await ws.next((e) => e.type === "registry.snapshot") as Extract<BridgeEvent, { type: "registry.snapshot" }>
    expect(idx.agents.find((a) => a.id === AGENT_ID)).toMatchObject({ id: AGENT_ID, supported: true, installed: false })

    // ① 安装：progress 序列 + addAgent 广播 + snapshot(installed=true)
    ws.send({ type: "registry.install", id: AGENT_ID })
    for (const stage of ["downloading", "verifying", "extracting", "registering", "done"] as const) {
      const e = await ws.next((x) => x.type === "registry.progress" && x.id === AGENT_ID && x.stage === stage)
      expect(e).toMatchObject({ type: "registry.progress", id: AGENT_ID, stage })
    }
    const stopped = await ws.next((e) => e.type === "agent.status" && e.agent.agentId === AGENT_ID)
    expect(stopped).toMatchObject({ type: "agent.status", agent: { agentId: AGENT_ID, status: "stopped" } })
    const snap = await ws.next((e) => e.type === "registry.snapshot") as Extract<BridgeEvent, { type: "registry.snapshot" }>
    expect(snap.agents.find((a) => a.id === AGENT_ID)).toMatchObject({ installed: true, kind: "binary" })

    // ② 启动 + 会话全链路（真 launcher 子进程跑 fake agent）
    ws.send({ type: "agent.start", agentId: AGENT_ID })
    const st = await ws.next((e) => e.type === "agent.status" && e.agent.agentId === AGENT_ID && (e.agent.status === "ready" || e.agent.status === "error"))
    if (st.type === "agent.status" && st.agent.status !== "ready") throw new Error(`agent 未就绪: ${st.agent.status} ${st.agent.error ?? ""}`)
    ws.send({ type: "session.new", agentId: AGENT_ID, cwd: "C:/tmp" })
    const opened = await ws.next((e) => e.type === "session.opened" && e.agentId === AGENT_ID) as Extract<BridgeEvent, { type: "session.opened" }>
    ws.send({ type: "session.prompt", agentId: AGENT_ID, sessionId: opened.sessionId, text: "hi" })
    const done = await ws.next((e) => e.type === "prompt.done" && e.agentId === AGENT_ID) as Extract<BridgeEvent, { type: "prompt.done" }>
    expect(done.stopReason).toBe("end_turn")

    // ③ 停止 + 卸载：snapshot(installed=false)
    ws.send({ type: "agent.stop", agentId: AGENT_ID })
    await ws.next((e) => e.type === "agent.status" && e.agent.agentId === AGENT_ID && e.agent.status === "stopped")
    ws.send({ type: "registry.uninstall", id: AGENT_ID })
    const snap2 = await ws.next((e) => e.type === "registry.snapshot") as Extract<BridgeEvent, { type: "registry.snapshot" }>
    expect(snap2.agents.find((a) => a.id === AGENT_ID)).toMatchObject({ installed: false })

    ws.close()
    await h.close()
  }, 30000)
})
