// tests/state.test.ts
import { describe, expect, it } from "vitest"
import { initialFrontState, reduceEvent } from "../src/web/state"
import type { BridgeEvent } from "../src/shared/bridge-protocol"

const key = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

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
    s = reduceEvent(s, { type: "session.update", agentId: "a", sessionId: "s", update: { sessionUpdate: "plan_update", entries: [] } } as BridgeEvent)
    const blocks = s.blocks[key("a", "s")]!
    expect(blocks.at(-1)!.kind).toBe("unknown")
  })

  it("permission.request 设置挂起态，permission.done 清除", () => {
    let s = initialFrontState()
    s = reduceEvent(s, { type: "permission.request", requestId: 7, agentId: "a", sessionId: "s", toolCall: {}, options: [] } as BridgeEvent)
    expect(s.permission?.requestId).toBe(7)
    s = reduceEvent(s, { type: "permission.done", requestId: 7 } as BridgeEvent)
    expect(s.permission).toBeNull()
  })
})
