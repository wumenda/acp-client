// src/web/components/MessageList.tsx
import { useEffect, useRef } from "react"
import { useFront } from "../state"
import { ToolCallCard } from "./ToolCallCard"
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
        if (b.kind === "unknown") return <div key={i} className="unknown">{t.unknownUpdate}: {b.sessionUpdate}</div>
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
