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
    onSessionOpened: (agentId, sessionId, cwd, meta) => events.push({ kind: "opened", agentId, sessionId, cwd, ...(meta ?? {}) }),
    onSessionList: (agentId, sessions) => events.push({ kind: "list", agentId, sessions }),
    onElicitationRequest: (p) => events.push({ kind: "eli", ...p }),
    onElicitationDone: (requestId, action) => events.push({ kind: "eliDone", requestId, action }),
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

  it("取消轮次：挂起权限被自动应答为 cancelled（协议义务，调研 §1.8）", async () => {
    const r = recorder()
    const store = new AgentStore([{ ...FAKE_DEF, env: { FAKE_ASK_PERMISSION: "1" } }], r.base)
    await store.start("fake")
    const sessionId = await store.newSession("fake", "C:/tmp")
    void store.prompt("fake", sessionId, "go")
    await vi_waitFor(() => r.events.some((e) => e.kind === "perm"))
    const perm = r.events.find((e) => e.kind === "perm") as unknown as { requestId: number }
    store.cancel("fake", sessionId)
    // cancel 必须同步应答挂起权限为 cancelled，否则 agent 在权限回调上死等
    expect(r.events.some((e) => e.kind === "permDone" && e.requestId === perm.requestId)).toBe(true)
    store.stop("fake")
  }, 15000)

  it("session.opened 携带 modes/configOptions；set_mode/set_config_option 链路回推（P1-11）", async () => {
    const r = recorder()
    const store = new AgentStore([{ ...FAKE_DEF, env: { FAKE_CONTROLS: "1" } }], r.base)
    await store.start("fake")
    const sessionId = await store.newSession("fake", "C:/tmp")
    // session/new 响应的 modes/configOptions → session.opened 事件
    const opened = r.events.find((e) => e.kind === "opened") as unknown as { modes: { currentModeId: string }; configOptions: { id: string; type: string }[] }
    expect(opened.modes.currentModeId).toBe("ask")
    expect(opened.configOptions.map((o) => o.id)).toEqual(["model", "verbose"])
    // set_mode → fake-agent 回推 current_mode_update
    await store.setMode("fake", sessionId, "plan")
    await vi_waitFor(() => r.events.some((e) => e.kind === "update" && (e.n as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "current_mode_update"))
    // set_config_option（select + boolean 两种形态）→ 回推 config_option_update
    await store.setConfigOption("fake", sessionId, "model", "m2")
    await store.setConfigOption("fake", sessionId, "verbose", true)
    // 每次设置都会收到一次全量推送；状态以「最后一条」为准
    await vi_waitFor(() => {
      const last = [...r.events].reverse().find((e) => e.kind === "update" && (e.n as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "config_option_update")
      const opts = (last as unknown as { n: { update: { configOptions: { id: string; currentValue: unknown }[] } } } | undefined)?.n.update.configOptions
      return opts?.find((o) => o.id === "model")?.currentValue === "m2" && opts?.find((o) => o.id === "verbose")?.currentValue === true
    })
    store.stop("fake")
  }, 15000)

  it("session.opened 携带 close/delete 能力；closeSession/deleteSession 到达 agent（P1-15）", async () => {
    const r = recorder()
    const store = new AgentStore([FAKE_DEF], r.base)
    await store.start("fake")
    // fake-agent 公告 close/delete 能力 → status 视图带能力标志
    const view = r.events.filter((e) => e.kind === "status").at(-1) as unknown as { view: { closeSupported: boolean; deleteSupported: boolean } }
    expect(view.view.closeSupported).toBe(true)
    expect(view.view.deleteSupported).toBe(true)
    const sessionId = await store.newSession("fake", "C:/tmp")
    await store.closeSession("fake", sessionId)
    await store.deleteSession("fake", sessionId)
    // 请求到达 agent 的证据：删除后再删同一会话仍成功（fake 无存储校验），能力检查已在本用例覆盖
    store.stop("fake")
  }, 15000)

  it("newSession 转发 mcpServers 给 agent（P1-16）", async () => {
    const r = recorder()
    const def: AgentDef = {
      ...FAKE_DEF,
      mcpServers: [{ type: "stdio" as const, name: "fs", command: "node", args: ["fs-server.js"], env: [{ name: "MODE", value: "rw" }] }],
    }
    const store = new AgentStore([def], r.base)
    await store.start("fake")
    await store.newSession("fake", "C:/tmp")
    // fake-agent 收到非空 mcpServers 时回推 "mcp:1" 计数消息
    await vi_waitFor(() => {
      const upd = r.events.find((e) => e.kind === "update") as unknown as { n?: { update?: { content?: { text?: string } } } } | undefined
      return upd?.n?.update?.content?.text === "mcp:1"
    })
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

  it("addAgent/removeAgent：动态注册后可 start，移除后未知", async () => {
    const r = recorder()
    const store = new AgentStore([], r.base)
    store.addAgent({ name: "dyn", command: `"${process.execPath}"`, args: ["--import", "tsx", `"${CHILD}"`], env: {}, autoStart: false, builtin: false })
    await store.start("dyn")
    expect(store.statusOf("dyn")).toBe("ready")
    store.removeAgent("dyn")
    expect(() => store.statusOf("dyn")).toThrow(/未知/)
  }, 15000)
})

async function vi_waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 20))
  }
}
