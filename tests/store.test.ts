// tests/store.test.ts
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { AgentStore, startAutoAgents, type StoreEvents } from "../src/server/store"
import type { AgentStatusView } from "../src/shared/bridge-protocol"
import type { AgentDef } from "../src/shared/agent-def"

const CHILD = path.resolve("tests/fake-agent-child.ts")

// shell:true 下 args 只拼接不转义（DEP0190），含空格路径需自带引号（同 agent-process.test 的做法）
const FAKE_DEF: AgentDef = {
  name: "fake",
  command: `"${process.execPath}"`,
  args: ["--import", "tsx", `"${CHILD}"`],
  env: {},
  autoStart: false,
  builtin: false,
}

function recorder() {
  const events: { kind: string; [k: string]: unknown }[] = []
  const statusStack: string[] = []
  const eventsOverride: Partial<StoreEvents> = {}
  const base: StoreEvents = {
    onAgentStatus: (_id, view: AgentStatusView) => {
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
    const store = new AgentStore([FAKE_DEF], r.base)
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
    const store = new AgentStore([{ ...FAKE_DEF, env: { FAKE_ASK_PERMISSION: "1" } }], r.base)
    await store.start("fake")
    const sessionId = await store.newSession("fake", "C:/tmp")
    const done = store.prompt("fake", sessionId, "go")
    await vi_waitFor(() => r.events.some((e) => e.kind === "perm"))
    const perm = r.events.find((e) => e.kind === "perm") as unknown as { requestId: number; options: { optionId: string }[] }
    expect(perm.options.map((o) => o.optionId)).toEqual(["allow", "reject"])
    store.respondPermission(perm.requestId, "allow")
    await done
    expect(r.events.some((e) => e.kind === "permDone")).toBe(true)
    store.stop("fake")
  }, 15000)

  it("authRequired 时 newSession 报 auth_required → status 变 needs-auth；authenticate 后可建会话", async () => {
    const r = recorder()
    const store = new AgentStore([{ ...FAKE_DEF, env: { FAKE_AUTH_REQUIRED: "1" } }], r.base)
    await store.start("fake")
    // store 抛出的错误文案为中文（含「认证」），正则同时兼容 auth 关键字
    await expect(store.newSession("fake", "C:/tmp")).rejects.toThrow(/认证|auth/i)
    expect(store.statusOf("fake")).toBe("needs-auth")
    await store.authenticate("fake")
    const sessionId = await store.newSession("fake", "C:/tmp")
    expect(sessionId).toMatch(/^fake-/)
    store.stop("fake")
  }, 15000)

  it("进程崩溃 → status stopped（手动重启策略，见共识）", async () => {
    const r = recorder()
    const store = new AgentStore([FAKE_DEF], r.base)
    await store.start("fake")
    const proc = store.processOf("fake")!
    proc.kill()
    await vi_waitFor(() => store.statusOf("fake") === "stopped")
    store.stop("fake")
  }, 15000)

  it("startAutoAgents 只拉起标记 autoStart 的 agent", async () => {
    const r = recorder()
    const on: AgentDef = { ...FAKE_DEF, name: "auto-on", autoStart: true }
    const off: AgentDef = { ...FAKE_DEF, name: "auto-off", autoStart: false }
    const store = new AgentStore([on, off], r.base)
    const started = startAutoAgents(store, [on, off])
    expect(started).toEqual(["auto-on"])
    await vi_waitFor(() => store.statusOf("auto-on") === "ready")
    expect(store.statusOf("auto-off")).toBe("stopped")
    store.stop("auto-on")
  }, 15000)
})

async function vi_waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 20))
  }
}
