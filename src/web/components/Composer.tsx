// src/web/components/Composer.tsx
import { useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function Composer({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [text, setText] = useState("")
  const busy = useFront((s) => s.busy[`${agentId}:${sessionId}`]) ?? false
  const status = useFront((s) => s.agents[agentId]?.status)
  const disabled = busy || status !== "ready"
  return (
    <div className="composer">
      <textarea
        value={text}
        disabled={disabled}
        placeholder={t.composerPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            if (!text.trim() || disabled) return
            sendCommand({ type: "session.prompt", agentId, sessionId, text })
            setText("")
          }
        }}
      />
      {busy ? (
        <button onClick={() => sendCommand({ type: "session.cancel", agentId, sessionId })}>{t.cancel}</button>
      ) : (
        <button disabled={disabled} onClick={() => { sendCommand({ type: "session.prompt", agentId, sessionId, text }); setText("") }}>
          {t.send}
        </button>
      )}
    </div>
  )
}
