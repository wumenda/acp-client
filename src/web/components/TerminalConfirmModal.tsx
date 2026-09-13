// src/web/components/TerminalConfirmModal.tsx
// terminal 代理确认弹窗（P2-18）：agent 请求执行命令需用户放行；多个请求排队逐个应答。
import { useEffect } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function TerminalConfirmModal() {
  const r = useFront((s) => s.termConfirm)
  const queueSize = useFront((s) => s.termConfirms.length)
  useEffect(() => {
    if (!r) return
    const onKey = (e: KeyboardEvent) => {
      // 键盘操作（与 fs 弹窗同约定）：Escape 拒绝；Enter 允许
      if (e.key === "Escape") sendCommand({ type: "term.respond", requestId: r.requestId, allowed: false })
      if (e.key === "Enter") sendCommand({ type: "term.respond", requestId: r.requestId, allowed: true })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [r])
  if (!r) return null
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label={t.termTitle}>
        <h3>
          {t.termTitle}
          {queueSize > 1 && <span className="perm-queue">（{queueSize - 1} {t.permQueueSuffix}）</span>}
        </h3>
        <p>{t.termFrom}</p>
        <div className="fs-target">
          <span className="fs-target-label">{t.termCommand}</span>
          <code className="fs-path">{[r.command, ...r.args].join(" ")}</code>
        </div>
        {r.cwd && (
          <div className="fs-target">
            <span className="fs-target-label">{t.termCwd}</span>
            <code className="fs-path">{r.cwd}</code>
          </div>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={() => sendCommand({ type: "term.respond", requestId: r.requestId, allowed: true })}>
            {t.fsAllow}
          </button>
          <button className="danger" onClick={() => sendCommand({ type: "term.respond", requestId: r.requestId, allowed: false })}>
            {t.fsDeny}
          </button>
        </div>
      </div>
    </div>
  )
}
