// src/web/components/AuthCard.tsx
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function AuthCard() {
  const agents = useFront((s) => s.agents)
  const needs = Object.values(agents).filter((a) => a.status === "needs-auth")
  if (!needs.length) return null
  return (
    <div className="auth-card">
      {needs.map((a) => (
        <div key={a.agentId}>
          <b>{a.name}</b> — {t.needsAuth}
          <p>{t.authGuide}</p>
          <code>{a.authMethods[0]?.description ?? a.authMethods[0]?.name ?? "（查看 agent 文档）"}</code>
          <button onClick={() => sendCommand({ type: "auth.retry", agentId: a.agentId })}>{t.retryAuth}</button>
        </div>
      ))}
    </div>
  )
}
