// src/web/components/MessageList.tsx
import { useEffect, useRef, useState } from "react"
import { useFront, type Block } from "../state"
import { ToolCallCard } from "./ToolCallCard"
import { Markdown } from "./Markdown"
import { t } from "../i18n"

export function MessageList({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const blocks = useFront((s) => s.blocks[`${agentId}:${sessionId}`]) ?? []
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [blocks.length])
  return (
    <div className="messages">
      {blocks.map((b, i) => {
        if (b.kind === "tool") return <ToolCallCard key={b.toolCallId + i} block={b} />
        if (b.kind === "plan") return <PlanCard key={i} entries={b.entries} />
        if (b.kind === "notice") {
          return (
            <div key={i} className={`notice notice-${b.level}`}>
              <span>{b.text}</span>
            </div>
          )
        }
        if (b.kind === "unknown") return <div key={i} className="unknown">{t.unknownUpdate}: {b.sessionUpdate}</div>
        // 流式 chunk 可能先到空文本，跳过渲染避免空气泡（块仍保留在 state 中继续累积）
        if (!b.text.trim()) return null
        if (b.kind === "thought") return <ThoughtBlock key={i} text={b.text} />
        // 协议：agent_message_chunk 为 Markdown；用户输入保持原样回显
        if (b.kind === "assistant-text") {
          return (
            <div key={i} className="msg msg-assistant-text">
              <Markdown text={b.text} />
            </div>
          )
        }
        return (
          <div key={i} className={`msg msg-${b.kind}`}>
            <pre>{b.text}</pre>
          </div>
        )
      })}
      <div ref={bottom} />
    </div>
  )
}

/** 任务计划卡（P1-9）：plan update 整表替换，状态徽章跟随 agent 推送 */
function PlanCard({ entries }: { entries: { content: string; priority: string; status: string }[] }) {
  const done = entries.filter((e) => e.status === "completed").length
  return (
    <div className="plan-card" aria-label={t.planTitle}>
      <div className="plan-head">
        <span className="plan-title">{t.planTitle}</span>
        <span className="badge">{done}/{entries.length}</span>
      </div>
      <ul>
        {entries.map((e, i) => (
          <li key={i} className={`plan-entry status-${e.status}`}>
            <span className="plan-status" aria-label={e.status}>
              {e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : "○"}
            </span>
            <span className="plan-content">{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 思考块：默认折叠为单行预览，点击展开全文 */
function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((v) => !v)
  return (
    <div className={`msg msg-thought${open ? " expanded" : ""}`}>
      <div
        className="thought-head clickable"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle() } }}
      >
        <span className="thought-icon">✦</span>
        <span className="thought-preview" title={text}>{text}</span>
        <svg
          className="chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? "none" : "rotate(-90deg)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
      {open && <Markdown text={text} />}
    </div>
  )
}
