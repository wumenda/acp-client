// src/web/components/PermissionModal.tsx
import { useEffect, useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront, savePermissionRules } from "../state"

export function PermissionModal() {
  const p = useFront((s) => s.permission)
  const queueSize = useFront((s) => s.permissions.length)
  const [remember, setRemember] = useState(false)
  useEffect(() => {
    if (!p) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") sendCommand({ type: "permission.respond", requestId: p.requestId, optionId: null })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [p])
  const respond = (optionId: string | null) => {
    if (!p) return
    // 权限记忆（§2.4-23）：勾选后按 agent+工具类型 记住该选项，同类请求自动应答
    if (remember && optionId !== null) savePermissionRules(p.agentId, toolKindOf(p.toolCall), optionId)
    sendCommand({ type: "permission.respond", requestId: p.requestId, optionId })
  }
  if (!p) return null
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true">
        <h3>
          {t.permissionTitle}
          {queueSize > 1 && <span className="perm-queue">（{queueSize - 1} {t.permQueueSuffix}）</span>}
        </h3>
        <p>{t.permissionFrom}</p>
        <pre className="tool-content">{JSON.stringify(p.toolCall, null, 2)}</pre>
        <div className="modal-actions">
          {p.options.map((o) => (
            <button
              key={o.optionId}
              className={o.kind.startsWith("allow") ? "primary" : o.kind.startsWith("reject") ? "danger" : ""}
              onClick={() => respond(o.optionId)}
            >
              {o.name}
            </button>
          ))}
          <button onClick={() => respond(null)}>{t.cancel}</button>
        </div>
        <label className="perm-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t.rememberChoice}
        </label>
      </div>
    </div>
  )
}

function toolKindOf(toolCall: unknown): string {
  const k = (toolCall as { kind?: unknown } | null)?.kind
  return typeof k === "string" ? k : "other"
}
