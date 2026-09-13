// tests/app.test.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { BridgeCommand } from "../src/shared/bridge-protocol"
import { createHarness, type Harness } from "./app-harness"

const CHILD = path.resolve("tests/fake-agent-child.ts")

// shell:true 下 args 只拼接不转义（DEP0190），含空格路径需自带引号（同 store.test 的做法）
const FAKE_DEF = {
  name: "fake",
  command: `"${process.execPath}"`,
  args: ["--import", "tsx", `"${CHILD}"`],
  env: {},
  autoStart: false,
  builtin: false,
}

describe("app", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness([{ ...FAKE_DEF }])
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
    const snapshot = (await ws.next((e) => e.type === "snapshot")) as { agents: { agentId: string }[] }
    expect(snapshot.agents.map((a) => a.agentId)).toEqual(["fake"])

    ws.send({ type: "agent.start", agentId: "fake" } satisfies BridgeCommand)
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")

    ws.send({ type: "session.new", agentId: "fake", cwd: "C:/tmp" } satisfies BridgeCommand)
    const opened = (await ws.next((e) => e.type === "session.opened")) as { sessionId: string }
    const sessionId = opened.sessionId

    ws.send({ type: "session.prompt", agentId: "fake", sessionId, text: "hi" } satisfies BridgeCommand)
    const echo = (await ws.next((e) => e.type === "session.update")) as {
      update: { sessionUpdate: string; content?: { type: string; text: string } }
    }
    expect(echo.update.sessionUpdate).toBe("user_message_chunk")
    expect(echo.update.content).toMatchObject({ type: "text", text: "hi" })
    await ws.next((e) => e.type === "session.update")
    const done = await ws.next((e) => e.type === "prompt.done")
    expect((done as { stopReason: string }).stopReason).toBe("end_turn")
    ws.close()
  }, 20000)

  it("权限流：permission.request → permission.respond → permission.done", async () => {
    // 用带 FAKE_ASK_PERMISSION 的第二个 agent
    const h2 = await createHarness([
      {
        name: "fakeperm",
        command: `"${process.execPath}"`,
        args: ["--import", "tsx", `"${CHILD}"`],
        env: { FAKE_ASK_PERMISSION: "1" },
        autoStart: false,
        builtin: false,
      },
    ])
    const ws = await h2.connectWs()
    await ws.next((e) => e.type === "snapshot")
    ws.send({ type: "agent.start", agentId: "fakeperm" })
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")
    ws.send({ type: "session.new", agentId: "fakeperm", cwd: "C:/tmp" })
    const opened = (await ws.next((e) => e.type === "session.opened")) as { sessionId: string }
    ws.send({ type: "session.prompt", agentId: "fakeperm", sessionId: opened.sessionId, text: "go" })
    const perm = (await ws.next((e) => e.type === "permission.request")) as { requestId: number }
    expect(perm.requestId).toBeGreaterThan(0)
    ws.send({ type: "permission.respond", requestId: perm.requestId, optionId: "reject" })
    const doneEv = (await ws.next((e) => e.type === "permission.done")) as { requestId: number }
    expect(doneEv.requestId).toBe(perm.requestId)
    const done = (await ws.next((e) => e.type === "prompt.done")) as { stopReason: string }
    expect(done.stopReason).toBe("end_turn")
    ws.close()
    await h2.close()
  }, 20000)

  // —— fs 代理确认流（P2-17）：写一律确认，cwd 内读免确认 ——
  const fsDef = (env: Record<string, string>) => ({
    name: "fakefs",
    command: `"${process.execPath}"`,
    args: ["--import", "tsx", `"${CHILD}"`],
    env,
    autoStart: false,
    builtin: false,
  })

  async function startFsSession(h2: Harness, env: Record<string, string>, cwd: string) {
    const ws = await h2.connectWs()
    await ws.next((e) => e.type === "snapshot")
    ws.send({ type: "agent.start", agentId: "fakefs" } satisfies BridgeCommand)
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")
    ws.send({ type: "session.new", agentId: "fakefs", cwd } satisfies BridgeCommand)
    const opened = (await ws.next((e) => e.type === "session.opened")) as { sessionId: string }
    ws.send({ type: "session.prompt", agentId: "fakefs", sessionId: opened.sessionId, text: "go" } satisfies BridgeCommand)
    return { ws, sessionId: opened.sessionId }
  }

  async function fsChunk(ws: Awaited<ReturnType<typeof startFsSession>>["ws"]): Promise<string> {
    // fake agent 的默认正文/thought 块先行，fs/terminal/elicitation/audio 结果块以各自前缀标记
    for (;;) {
      const e = (await ws.next((x) => x.type === "session.update")) as {
        update: { sessionUpdate: string; content?: { type: string; text?: string } }
      }
      if (e.update.sessionUpdate === "agent_message_chunk" && e.update.content?.type === "text" && /^(fs-|term:|eli|audio:)/.test(e.update.content.text ?? "")) {
        return e.update.content.text ?? ""
      }
    }
  }

  it("fs 写确认流：允许 → 文件落盘 + fs.done（P2-17）", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "acp-fs-e2e-"))
    const target = path.join(cwd, "out.txt")
    const h2 = await createHarness([fsDef({ FAKE_FS_WRITE: "1", FAKE_FS_PATH: target, FAKE_FS_CONTENT: "写入内容" })])
    const { ws } = await startFsSession(h2, { FAKE_FS_WRITE: "1", FAKE_FS_PATH: target, FAKE_FS_CONTENT: "写入内容" }, cwd)

    const confirm = (await ws.next((e) => e.type === "fs.confirm")) as { requestId: number; kind: string; path: string; content: string }
    expect(confirm.kind).toBe("write")
    expect(confirm.path).toBe(path.resolve(target))
    expect(confirm.content).toBe("写入内容")
    ws.send({ type: "fs.respond", requestId: confirm.requestId, allowed: true } satisfies BridgeCommand)
    await ws.next((e) => e.type === "fs.done")
    expect(await fsChunk(ws)).toBe("fs-write:ok")
    expect(readFileSync(target, "utf8")).toBe("写入内容")
    expect((await ws.next((e) => e.type === "prompt.done")) as { stopReason: string }).toMatchObject({ stopReason: "end_turn" })
    ws.close()
    await h2.close()
  }, 20000)

  it("fs 写拒绝流：拒绝 → agent 收到错误；取消轮次 → pending 自动拒绝（P2-17）", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "acp-fs-e2e-"))
    const target = path.join(cwd, "out.txt")
    const env = { FAKE_FS_WRITE: "1", FAKE_FS_PATH: target, FAKE_FS_CONTENT: "x" }
    const h2 = await createHarness([fsDef(env)])
    const { ws } = await startFsSession(h2, env, cwd)

    const confirm = (await ws.next((e) => e.type === "fs.confirm")) as { requestId: number }
    ws.send({ type: "fs.respond", requestId: confirm.requestId, allowed: false } satisfies BridgeCommand)
    await ws.next((e) => e.type === "fs.done")
    expect(await fsChunk(ws)).toMatch(/^fs-write:denied:/)
    expect(existsSync(target)).toBe(false)
    await ws.next((e) => e.type === "prompt.done")
    ws.close()
    await h2.close()
  }, 20000)

  it("fs 取消流：session.cancel 后挂起确认自动拒绝（P2-17）", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "acp-fs-e2e-"))
    const target = path.join(cwd, "out.txt")
    const env = { FAKE_FS_WRITE: "1", FAKE_FS_PATH: target, FAKE_FS_CONTENT: "x" }
    const h2 = await createHarness([fsDef(env)])
    const { ws, sessionId } = await startFsSession(h2, env, cwd)

    await ws.next((e) => e.type === "fs.confirm")
    ws.send({ type: "session.cancel", agentId: "fakefs", sessionId } satisfies BridgeCommand)
    await ws.next((e) => e.type === "fs.done")
    expect(await fsChunk(ws)).toMatch(/^fs-write:denied:/)
    expect(existsSync(target)).toBe(false)
    ws.close()
    await h2.close()
  }, 20000)

  // —— terminal 代理确认流（P2-18）：命令执行一律确认 ——
  const termEnv = (code: string) => ({ FAKE_TERM_RUN: "1", FAKE_TERM_CODE: code })

  it("terminal 确认流：允许 → 执行 + wait/output/release 全链路（P2-18）", async () => {
    const h2 = await createHarness([fsDef(termEnv("console.log(40+2)"))])
    const { ws } = await startFsSession(h2, termEnv("console.log(40+2)"), "C:/tmp")

    const confirm = (await ws.next((e) => e.type === "term.confirm")) as { requestId: number; command: string; args: string[] }
    expect(confirm.command).toBe("node")
    expect(confirm.args[0]).toBe("-e")
    ws.send({ type: "term.respond", requestId: confirm.requestId, allowed: true } satisfies BridgeCommand)
    await ws.next((e) => e.type === "term.done")
    const msg = await fsChunk(ws)
    expect(msg).toMatch(/^term:ok:0:/)
    expect(msg).toContain("42")
    expect((await ws.next((e) => e.type === "prompt.done")) as { stopReason: string }).toMatchObject({ stopReason: "end_turn" })
    ws.close()
    await h2.close()
  }, 20000)

  it("terminal 拒绝流：拒绝 → agent 收到错误（P2-18）", async () => {
    const h2 = await createHarness([fsDef(termEnv("console.log(1)"))])
    const { ws } = await startFsSession(h2, termEnv("console.log(1)"), "C:/tmp")

    const confirm = (await ws.next((e) => e.type === "term.confirm")) as { requestId: number }
    ws.send({ type: "term.respond", requestId: confirm.requestId, allowed: false } satisfies BridgeCommand)
    await ws.next((e) => e.type === "term.done")
    expect(await fsChunk(ws)).toMatch(/^term:denied:/)
    await ws.next((e) => e.type === "prompt.done")
    ws.close()
    await h2.close()
  }, 20000)

  it("terminal 取消流：session.cancel 后挂起 create 确认自动拒绝（P2-18）", async () => {
    const h2 = await createHarness([fsDef(termEnv("console.log(1)"))])
    const { ws, sessionId } = await startFsSession(h2, termEnv("console.log(1)"), "C:/tmp")

    await ws.next((e) => e.type === "term.confirm")
    ws.send({ type: "session.cancel", agentId: "fakefs", sessionId } satisfies BridgeCommand)
    await ws.next((e) => e.type === "term.done")
    expect(await fsChunk(ws)).toMatch(/^term:denied:/)
    ws.close()
    await h2.close()
  }, 20000)

  // —— elicitation（P2-19）：form 结构化输入 + url 引导 ——
  it("elicitation form 流：accept 携带 content 回传 agent（P2-19）", async () => {
    const h2 = await createHarness([fsDef({ FAKE_ELICIT_FORM: "1" })])
    const { ws } = await startFsSession(h2, { FAKE_ELICIT_FORM: "1" }, "C:/tmp")

    const req = (await ws.next((e) => e.type === "elicitation.request")) as {
      requestId: number; message: string; mode: string; fields: Record<string, { type: string }>; required: string[]
    }
    expect(req.mode).toBe("form")
    expect(req.message).toBe("请提供部署信息")
    expect(req.required).toEqual(["name"])
    expect(Object.keys(req.fields).sort()).toEqual(["confirm", "name", "replicas"])
    ws.send({
      type: "elicitation.respond",
      requestId: req.requestId,
      action: "accept",
      content: { name: "web", replicas: 3, confirm: true },
    } satisfies BridgeCommand)
    await ws.next((e) => e.type === "elicitation.done")
    const msg = await fsChunk(ws)
    expect(msg).toBe(`eli:accept:${JSON.stringify({ name: "web", replicas: 3, confirm: true })}`)
    await ws.next((e) => e.type === "prompt.done")
    ws.close()
    await h2.close()
  }, 20000)

  it("elicitation decline / cancel 流（P2-19）", async () => {
    const h2 = await createHarness([fsDef({ FAKE_ELICIT_FORM: "1" })])
    const { ws, sessionId } = await startFsSession(h2, { FAKE_ELICIT_FORM: "1" }, "C:/tmp")

    const req = (await ws.next((e) => e.type === "elicitation.request")) as { requestId: number }
    ws.send({ type: "elicitation.respond", requestId: req.requestId, action: "decline" } satisfies BridgeCommand)
    await ws.next((e) => e.type === "elicitation.done")
    expect(await fsChunk(ws)).toBe("eli:decline:null")
    await ws.next((e) => e.type === "prompt.done")

    // cancel：挂起时取消轮次 → action cancel
    ws.send({ type: "session.prompt", agentId: "fakefs", sessionId, text: "go" } satisfies BridgeCommand)
    const req2 = (await ws.next((e) => e.type === "elicitation.request")) as { requestId: number }
    ws.send({ type: "session.cancel", agentId: "fakefs", sessionId } satisfies BridgeCommand)
    const done2 = (await ws.next((e) => e.type === "elicitation.done")) as { requestId: number; action?: string }
    expect(done2.requestId).toBe(req2.requestId)
    expect(done2.action).toBe("cancel")
    expect(await fsChunk(ws)).toBe("eli:cancel:null")
    ws.close()
    await h2.close()
  }, 20000)

  it("elicitation url 流：accept 引导 → agent complete 通知 → UI 清理（P2-19）", async () => {
    const h2 = await createHarness([fsDef({ FAKE_ELICIT_URL: "1" })])
    const { ws } = await startFsSession(h2, { FAKE_ELICIT_URL: "1" }, "C:/tmp")

    const req = (await ws.next((e) => e.type === "elicitation.request")) as {
      requestId: number; mode: string; url?: string; elicitationId?: string
    }
    expect(req.mode).toBe("url")
    expect(req.url).toBe("https://example.com/login")
    expect(req.elicitationId).toMatch(/^eli-/)
    ws.send({ type: "elicitation.respond", requestId: req.requestId, action: "accept" } satisfies BridgeCommand)
    // fake-agent 收到 accept 后发 elicitation/complete → 第二次 done（无 action）清理 UI
    const done = (await ws.next((e) => e.type === "elicitation.done")) as { requestId: number; action?: string }
    expect(done.requestId).toBe(req.requestId)
    expect(done.action).toBe("accept")
    expect(await fsChunk(ws)).toBe("eli-url:accept")
    await ws.next((e) => e.type === "prompt.done")
    ws.close()
    await h2.close()
  }, 20000)

  it("音频附件链路：audioSupported 公告 + audio ContentBlock 到达 agent（P2-20）", async () => {
    const h2 = await createHarness([fsDef({ FAKE_PROMPT_CAPS: "1" })])
    const ws = await h2.connectWs()
    await ws.next((e) => e.type === "snapshot")
    ws.send({ type: "agent.start", agentId: "fakefs" } satisfies BridgeCommand)
    // 一次消费：ready 事件的 agent 视图同时用于能力断言
    const ready = (await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")) as { agent: { audioSupported: boolean; imageSupported: boolean } }
    expect(ready.agent.audioSupported).toBe(true)
    expect(ready.agent.imageSupported).toBe(true)
    ws.send({ type: "session.new", agentId: "fakefs", cwd: "C:/tmp" } satisfies BridgeCommand)
    await ws.next((e) => e.type === "session.opened")
    // dataURL 音频附件 → app 层转 audio ContentBlock → fake-agent 回推 audio:<mime>
    const audioDataUrl = "data:audio/wav;base64,UklGRiQ=" // 极小 WAV 头
    ws.send({ type: "session.prompt", agentId: "fakefs", sessionId: "fake-1", text: "听一下", attachments: [audioDataUrl] } satisfies BridgeCommand)
    expect(await fsChunk(ws)).toBe("audio:audio/wav")
    ws.close()
    await h2.close()
  }, 20000)
})
