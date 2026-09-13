// tests/state.test.ts
import { describe, expect, it } from "vitest"
import { initialFrontState, reduceEvent, enqueuePrompt, takeQueuedPrompt } from "../src/web/state"
import type { BridgeEvent } from "../src/shared/bridge-protocol"

const key = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

describe("输入排队（§2.4-21）", () => {
  it("busy 期间入队，轮末按 FIFO 取出队首", () => {
    enqueuePrompt("q", "s1", { text: "one" })
    enqueuePrompt("q", "s1", { text: "two" })
    enqueuePrompt("q", "s2", { text: "other-session" })
    expect(takeQueuedPrompt("q", "s1")).toEqual({ text: "one" })
    expect(takeQueuedPrompt("q", "s1")).toEqual({ text: "two" })
    expect(takeQueuedPrompt("q", "s1")).toBeNull()
    expect(takeQueuedPrompt("q", "s2")).toEqual({ text: "other-session" })
    expect(takeQueuedPrompt("q", "s2")).toBeNull()
  })
})

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
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "totally_new_variant", x: 1 } } as BridgeEvent)
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks.at(-1)!.kind).toBe("unknown")
  })

  it("permission 队列：多请求逐个应答（§2.4-24）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "permission.request", requestId: 1, agentId: "a", sessionId: "s", toolCall: {}, options: [] } as BridgeEvent)
    s = reduceEvent(s, { type: "permission.request", requestId: 2, agentId: "a", sessionId: "s", toolCall: {}, options: [] } as BridgeEvent)
    expect(s.permissions.map((p) => p.requestId)).toEqual([1, 2])
    expect(s.permission?.requestId).toBe(1) // 先到的展示
    s = reduceEvent(s, { type: "permission.done", requestId: 1 } as BridgeEvent)
    expect(s.permissions.map((p) => p.requestId)).toEqual([2])
    expect(s.permission?.requestId).toBe(2) // 队列推进
    s = reduceEvent(s, { type: "permission.done", requestId: 2 } as BridgeEvent)
    expect(s.permission).toBeNull()
  })

  it("plan update 整表替换同一个 plan 块；plan_removed 移除（P1-9）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    const upd = (entries: unknown, kind = "plan") =>
      ({ type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: kind, entries } }) as BridgeEvent
    s = reduceEvent(s, upd([{ content: "定位问题", priority: "high", status: "completed" }, { content: "修复", priority: "high", status: "in_progress" }]))
    s = reduceEvent(s, upd([{ content: "修复", priority: "high", status: "completed" }]))
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: "plan", entries: [{ content: "修复", status: "completed" }] })
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "plan_removed", planId: "p1" } } as BridgeEvent)
    expect(s.blocks[key("a", "s")]).toHaveLength(0)
  })

  it("plan_update（unstable）仅渲染 items 形态，file/markdown 忽略", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "plan_update", plan: { type: "items", planId: "p1", entries: [{ content: "A", priority: "low", status: "pending" }] } },
    } as BridgeEvent)
    expect(s.blocks[key("a", "s")]).toHaveLength(1)
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "plan_update", plan: { type: "file", planId: "p1", uri: "file:///plan.md" } },
    } as BridgeEvent)
    expect(s.blocks[key("a", "s")]).toHaveLength(1) // 不产生新块
  })

  it("available_commands_update 存命令表；current_mode_update / config_option_update 更新控制面（P1-10/11）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, {
      type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/",
      modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] },
      configOptions: [{ id: "model", name: "模型", type: "select", currentValue: "m1", options: [{ value: "m1", name: "M1" }] }],
    } as BridgeEvent)
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "审阅代码" }] },
    } as BridgeEvent)
    expect(s.commands[key("a", "s")]).toEqual([{ name: "review", description: "审阅代码" }])
    expect(s.controls[key("a", "s")]?.modes?.currentModeId).toBe("ask")
    // agent 回执模式切换
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } as BridgeEvent)
    expect(s.controls[key("a", "s")]?.modes?.currentModeId).toBe("plan")
    // agent 回执配置变化（全量）
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "config_option_update", configOptions: [{ id: "model", name: "模型", type: "select", currentValue: "m2", options: [{ value: "m2", name: "M2" }] }] },
    } as BridgeEvent)
    expect(s.controls[key("a", "s")]?.configOptions?.[0]!.currentValue).toBe("m2")
    // 以上全部不进消息流
    expect(s.blocks[key("a", "s")]).toHaveLength(0)
  })

  it("permission.request 设置挂起态，permission.done 清除", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "permission.request", requestId: 7, agentId: "a", sessionId: "s", toolCall: {}, options: [] } as BridgeEvent)
    expect(s.permission?.requestId).toBe(7)
    s = reduceEvent(s, { type: "permission.done", requestId: 7 } as BridgeEvent)
    expect(s.permission).toBeNull()
  })

  it("tool_call 的 locations/rawInput/rawOutput 随 update 合并（P1-13 / §2.4-28）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "edit", status: "in_progress", rawInput: { file: "a.ts" } },
    } as BridgeEvent)
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", locations: [{ path: "C:/x/a.ts", line: 12 }, { path: "C:/y.ts" }] },
    } as BridgeEvent)
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: "tool", status: "completed", rawInput: { file: "a.ts" },
      locations: [{ path: "C:/x/a.ts", line: 12 }, { path: "C:/y.ts" }],
    })
  })

  it("session.closed 从会话列表与视图态移除，activeKey 落回最近标签（P1-15）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.list", agentId: "a", sessions: [{ sessionId: "s1", cwd: "C:/", updatedAt: 1 }, { sessionId: "s2", cwd: "C:/", updatedAt: 2 }] } as BridgeEvent)
    s = { ...s, openOrder: ["a:s1", "a:s2"], activeKey: "a:s2" }
    s = reduceEvent(s, { type: "session.closed", agentId: "a", sessionId: "s2", deleted: true } as BridgeEvent)
    expect(s.sessions.a!.map((x) => x.sessionId)).toEqual(["s1"])
    expect(s.openOrder).toEqual(["a:s1"])
    expect(s.activeKey).toBe("a:s1")
  })

  it("usage_update 记录上下文占用与费用，不进入消息流（P1-7）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, {
      type: "session.update", agentId: "a", sessionId: "s",
      update: { sessionUpdate: "usage_update", used: 12345, size: 200000, cost: { amount: 0.042, currency: "USD" } },
    } as BridgeEvent)
    expect(s.usage[key("a", "s")]).toEqual({ used: 12345, size: 200000, costAmount: 0.042, costCurrency: "USD" })
    expect(s.blocks[key("a", "s")]).toHaveLength(0)
    // 后续更新为全量替换
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "usage_update", used: 13000, size: 200000 } } as BridgeEvent)
    expect(s.usage[key("a", "s")]).toEqual({ used: 13000, size: 200000 })
  })

  it("session_info_update 实时更新侧栏会话标题（P1-8）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.list", agentId: "a", sessions: [{ sessionId: "s1", cwd: "C:/", updatedAt: 1 }] } as BridgeEvent)
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s1", update: { sessionUpdate: "session_info_update", title: "修复登录 bug" } } as BridgeEvent)
    expect(s.sessions.a![0]!.title).toBe("修复登录 bug")
    // 未建档的会话不产生任何状态变化
    const before = s
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "ghost", update: { sessionUpdate: "session_info_update", title: "x" } } as BridgeEvent)
    expect(s).toBe(before)
  })

  it("snapshot 恢复服务端缓存会话；localStorage 的 activeKey 失效时落回空态（P0-3）", () => {
    let s = initialFrontState()
    s = reduceEvent(s, {
      type: "snapshot",
      agents: [],
      sessions: { a: [{ sessionId: "s1", cwd: "C:/", title: "历史会话", updatedAt: 5 }] },
    } as BridgeEvent)
    expect(s.sessions.a).toHaveLength(1)
    // activeKey 不在 openOrder 中（首次进入无视图态）→ 空态
    expect(s.activeKey).toBeNull()
    // 有 openOrder 但缓存中不存在该会话 → 清空 activeKey
    s = { ...s, openOrder: ["a:gone"], activeKey: "a:gone" }
    s = reduceEvent(s, { type: "snapshot", agents: [], sessions: {} } as BridgeEvent)
    expect(s.activeKey).toBeNull()
  })

  it("messageId 相同的分片合并为一条；不同 messageId 分裂；无 messageId 维持相邻合并", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    const chunk = (text: string, messageId?: string) =>
      ({ type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) } }) as BridgeEvent
    s = reduceEvent(s, chunk("A1", "m1"))
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } } } as unknown as BridgeEvent)
    s = reduceEvent(s, chunk("A2", "m1")) // 思考块插入后，m1 仍应并回第一块
    s = reduceEvent(s, chunk("B1", "m2")) // 新消息
    s = reduceEvent(s, chunk("tail")) // 无 messageId：与最后一块（assistant）合并
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ kind: "assistant-text", text: "A1A2" })
    expect(blocks[1]!.kind).toBe("thought")
    expect(blocks[2]).toMatchObject({ kind: "assistant-text", text: "B1tail" })
  })

  it("prompt.done 非 end_turn 时追加 notice 块；end_turn 不追加", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, { type: "prompt.done", agentId: "a", sessionId: "s", stopReason: "max_tokens" } as BridgeEvent)
    expect(s.blocks[key("a", "s")]!.at(-1)).toMatchObject({ kind: "notice", level: "warn" })
    s = reduceEvent(s, { type: "prompt.done", agentId: "a", sessionId: "s", stopReason: "end_turn" } as BridgeEvent)
    expect(s.blocks[key("a", "s")]!.at(-1)!.kind).toBe("notice") // 仍是上一条 notice
    expect(s.blocks[key("a", "s")]).toHaveLength(1)
  })

  it("prompt.error（有会话）落为 error notice 块；无会话时仅记 lastError", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "session.opened", agentId: "a", sessionId: "s", cwd: "C:/" } as BridgeEvent)
    s = reduceEvent(s, { type: "prompt.error", agentId: "a", sessionId: "s", message: "boom" } as BridgeEvent)
    expect(s.blocks[key("a", "s")]!.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "boom" })
    s = reduceEvent(s, { type: "prompt.error", agentId: "a", sessionId: null, message: "global" } as BridgeEvent)
    expect(s.lastError).toBe("global")
    expect(s.blocks[key("a", "s")]).toHaveLength(1)
  })

  it("registry.snapshot 填充列表；registry.progress 推进", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "registry.snapshot", agents: [{ id: "a", name: "A", version: "1.0.0", kind: "npx", supported: true, installed: false, updateAvailable: false }], fetchedAt: 1, stale: false } as BridgeEvent)
    expect(s.registry?.agents).toHaveLength(1)
    s = reduceEvent(s, { type: "registry.progress", id: "a", stage: "downloading" } as BridgeEvent)
    expect(s.registry?.progress["a"]?.stage).toBe("downloading")
    s = reduceEvent(s, { type: "registry.progress", id: "a", stage: "done" } as BridgeEvent)
    expect(s.registry?.progress["a"]?.stage).toBe("done")
  })
})
