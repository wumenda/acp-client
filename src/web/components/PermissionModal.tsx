// src/web/components/PermissionModal.tsx
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function PermissionModal() {
  const p = useFront((s) => s.permission)
  if (!p) return null
  return (
    <div className="modal-mask">
      <div className="modal">
        <h3>{t.permissionTitle}</h3>
        <p>{t.permissionFrom}</p>
        <pre className="tool-content">{JSON.stringify(p.toolCall, null, 2)}</pre>
        <div className="modal-actions">
          {p.options.map((o) => (
            <button key={o.optionId} className={o.kind.startsWith("allow") ? "primary" : ""} onClick={() => sendCommand({ type: "permission.respond", requestId: p.requestId, optionId: o.optionId })}>
              {o.name}
            </button>
          ))}
          <button onClick={() => sendCommand({ type: "permission.respond", requestId: p.requestId, optionId: null })}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  )
}
