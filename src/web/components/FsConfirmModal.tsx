// src/web/components/FsConfirmModal.tsx
// fs 代理确认弹窗（P2-17）：写操作与 cwd 外读需用户放行；多个请求排队逐个应答。
import { useEffect } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function FsConfirmModal() {
  const r = useFront((s) => s.fsConfirm)
  const queueSize = useFront((s) => s.fsConfirms.length)
  useEffect(() => {
    if (!r) return
    const onKey = (e: KeyboardEvent) => {
      // 键盘操作（与权限弹窗同约定）：Escape 拒绝；Enter 允许
      if (e.key === "Escape") sendCommand({ type: "fs.respond", requestId: r.requestId, allowed: false })
      if (e.key === "Enter") sendCommand({ type: "fs.respond", requestId: r.requestId, allowed: true })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [r])
  if (!r) return null
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label={r.kind === "write" ? t.fsWriteTitle : t.fsReadTitle}>
        <h3>
          {r.kind === "write" ? t.fsWriteTitle : t.fsReadTitle}
          {queueSize > 1 && <span className="perm-queue">（{queueSize - 1} {t.permQueueSuffix}）</span>}
        </h3>
        <p>{t.fsFrom}</p>
        <div className="fs-target">
          <span className="fs-target-label">{t.fsTarget}</span>
          <code className="fs-path">{r.path}</code>
        </div>
        {r.kind === "write" && typeof r.content === "string" && (
          <>
            <div className="fs-preview-label">{t.fsWritePreview}</div>
            <pre className="tool-content">{r.content}</pre>
          </>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={() => sendCommand({ type: "fs.respond", requestId: r.requestId, allowed: true })}>
            {t.fsAllow}
          </button>
          <button className="danger" onClick={() => sendCommand({ type: "fs.respond", requestId: r.requestId, allowed: false })}>
            {t.fsDeny}
          </button>
        </div>
      </div>
    </div>
  )
}
