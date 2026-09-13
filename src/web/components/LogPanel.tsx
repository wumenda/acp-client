// src/web/components/LogPanel.tsx
// ACP 线上日志面板（§2.4-26）：订阅 acp.log（独立 bus），展示最近 N 条，支持暂停滚动
import { useEffect, useRef, useState } from "react"
import { sendCommand } from "../ws"
import { logBus, useFront } from "../state"
import { t } from "../i18n"

type LogLine = { id: number; agentId: string; dir: "in" | "out"; data: string }
const MAX_LINES = 500
let seq = 0

export function LogPanel({ onClose }: { onClose: () => void }) {
  const agents = useFront((s) => s.agents)
  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 订阅 server 日志流（打开面板 → subscribe；关闭 → unsubscribe）
    sendCommand({ type: "log.subscribe", on: true })
    const off = logBus.subscribe((e) => {
      if (pausedRef.current) return
      setLines((prev) => {
        const next = [...prev, { id: ++seq, ...e }]
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
      })
    })
    return () => {
      off()
      sendCommand({ type: "log.subscribe", on: false })
    }
  }, [])

  useEffect(() => {
    if (!paused) bottom.current?.scrollIntoView({ block: "end" })
  }, [lines.length, paused])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal log-modal" role="dialog" aria-modal="true" aria-label={t.logTitle} onClick={(e) => e.stopPropagation()}>
        <div className="log-head">
          <h3>{t.logTitle}</h3>
          <button className="icon-btn" onClick={() => setPaused((v) => !v)} aria-label={paused ? t.resume : t.pause} title={paused ? t.resume : t.pause}>
            {paused ? "▶" : "⏸"}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t.closeTab} title={t.closeTab}>×</button>
        </div>
        <div className="log-body">
          {lines.length === 0 && <div className="log-empty">{t.logEmpty}</div>}
          {lines.map((l) => (
            <div key={l.id} className={`log-line log-${l.dir}`}>
              <span className="log-agent">{agents[l.agentId]?.name ?? l.agentId}</span>
              <span className="log-dir">{l.dir === "in" ? "←" : "→"}</span>
              <code>{l.data}</code>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>
    </div>
  )
}
