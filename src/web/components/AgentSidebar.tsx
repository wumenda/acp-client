// src/web/components/AgentSidebar.tsx
import { useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function AgentSidebar() {
  const agents = useFront((s) => s.agents)
  const [cwd, setCwd] = useState("C:/")
  return (
    <aside className="sidebar">
      {Object.values(agents).map((a) => (
        <div key={a.agentId} className={`agent agent-${a.status}`}>
          <div className="agent-head">
            <b>{a.name}</b>
            <span className="badge">{t[a.status as keyof typeof t] ?? a.status}</span>
          </div>
          {a.status === "stopped" && <button onClick={() => sendCommand({ type: "agent.start", agentId: a.agentId })}>{t.start}</button>}
          {a.status === "ready" && <button onClick={() => sendCommand({ type: "agent.stop", agentId: a.agentId })}>{t.stop}</button>}
          {(a.status === "ready" || a.status === "needs-auth") && (
            <div className="new-session">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={t.cwdPlaceholder} />
              <button onClick={() => sendCommand({ type: "session.new", agentId: a.agentId, cwd })} disabled={a.status !== "ready"}>
                {t.newSession}
              </button>
              {a.listSupported && (
                <button onClick={() => sendCommand({ type: "session.list", agentId: a.agentId, cwd })}>{t.listSessions}</button>
              )}
            </div>
          )}
          {a.status === "error" && <div className="err">{a.error}</div>}
          <SessionList agentId={a.agentId} />
        </div>
      ))}
    </aside>
  )
}

function SessionList({ agentId }: { agentId: string }) {
  const sessions = useFront((s) => s.sessions[agentId]) ?? []
  if (!sessions.length) return null
  return (
    <ul className="session-list">
      {sessions.map((s) => (
        <li key={s.sessionId}>
          <button onClick={() => sendCommand({ type: "session.open", agentId, sessionId: s.sessionId, cwd: s.cwd })}>
            {s.title ?? s.sessionId}
          </button>
        </li>
      ))}
    </ul>
  )
}
