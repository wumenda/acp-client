// src/web/components/Composer.tsx
import { useEffect, useRef, useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront, enqueuePrompt, takeQueuedPrompt, type UsageView, type QueuedPrompt } from "../state"

/** token 数缩写：12345 → 12.3k */
function k(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatUsage(u: UsageView): string {
  const pct = u.size > 0 ? Math.round((u.used / u.size) * 100) : 0
  const cost = u.costAmount != null && u.costCurrency != null ? ` · ${u.costCurrency === "USD" ? "$" : `${u.costCurrency} `}${u.costAmount.toFixed(4)}` : ""
  return `${t.usageContext} ${k(u.used)} / ${k(u.size)}（${pct}%）${cost}`
}

export function Composer({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<string[]>([]) // dataURL 列表（P2-20：图片 + 音频）
  const key = `${agentId}:${sessionId}`
  const busy = useFront((s) => s.busy[key]) ?? false
  const usage = useFront((s) => s.usage[key])
  const commands = useFront((s) => s.commands[key])
  const status = useFront((s) => s.agents[agentId]?.status)
  const queue = useFront((s) => s.queues[key]) ?? []
  const imageSupported = useFront((s) => s.agents[agentId]?.imageSupported) ?? false
  const audioSupported = useFront((s) => s.agents[agentId]?.audioSupported) ?? false
  const notReady = status !== "ready"
  const hasAttach = imageSupported || audioSupported

  // slash 命令补全（P1-10）：输入 "/xxx"（无空格）时给出候选；执行 = 并入 prompt（协议语义）
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null
  const [dismissed, setDismissed] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const candidates = slashQuery === null || dismissed ? [] : (commands ?? []).filter((c) => c.name.startsWith(slashQuery)).slice(0, 8)
  const showPanel = candidates.length > 0
  const complete = (name: string) => {
    setText(`/${name} `)
    setDismissed(false)
    setActiveIdx(0)
  }

  // 输入排队（§2.4-21）：busy 期间发送入队；轮次结束（busy 清空）自动提交队首
  useEffect(() => {
    if (busy || notReady) return
    const next = takeQueuedPrompt(agentId, sessionId)
    if (next) sendCommand({ type: "session.prompt", agentId, sessionId, text: next.text, attachments: next.attachments })
  }, [busy, notReady, agentId, sessionId])

  const submit = (queued: boolean) => {
    const item: QueuedPrompt = { text, attachments: attachments.length ? attachments : undefined }
    if (!text.trim() && !(queued && attachments.length)) return
    if (queued) enqueuePrompt(agentId, sessionId, item)
    else sendCommand({ type: "session.prompt", agentId, sessionId, text: item.text, attachments: item.attachments })
    setText("")
    setAttachments([])
  }

  const pickFiles = (accept: (mime: string) => boolean, files: FileList | null) => {
    if (!files) return
    for (const f of files) {
      if (!accept(f.type)) continue
      const reader = new FileReader()
      reader.onload = () => setAttachments((prev) => [...prev, String(reader.result)])
      reader.readAsDataURL(f)
    }
  }
  const imageInput = useRef<HTMLInputElement>(null)
  const audioInput = useRef<HTMLInputElement>(null)

  return (
    <div className={`composer${hasAttach ? " has-attach" : ""}`}>
      {usage && (
        <div className="usage-bar" title={t.usageContext}>
          <span className="usage-track" aria-hidden="true">
            <span className="usage-fill" style={{ width: `${Math.min(100, usage.size > 0 ? (usage.used / usage.size) * 100 : 0)}%` }} />
          </span>
          <span className="usage-text">{formatUsage(usage)}</span>
        </div>
      )}
      {queue.length > 0 && (
        <div className="queue-bar">
          {queue.map((q, i) => (
            <span key={i} className="queue-chip" title={q.text}>
              {t.queuedLabel}
              {q.text}
            </span>
          ))}
        </div>
      )}
      {showPanel && (
        <ul className="slash-panel glass-panel" role="listbox" aria-label={t.slashCommands}>
          {candidates.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === activeIdx}>
              <button
                type="button"
                className={i === activeIdx ? "is-active" : ""}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => complete(c.name)}
              >
                <b>/{c.name}</b>
                <span>{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <div className="image-preview">
          {attachments.map((src, i) => {
            const mime = /^data:([\w./-]+);/.exec(src)?.[1] ?? ""
            return (
              <span key={i} className="image-chip">
                {mime.startsWith("audio/") ? <span className="audio-chip">{mime}</span> : <img src={src} alt="" />}
                <button className="image-remove" aria-label={t.removeImage} onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </span>
            )
          })}
        </div>
      )}
      <textarea
        value={text}
        disabled={notReady}
        placeholder={t.composerPlaceholder}
        onChange={(e) => { setText(e.target.value); setDismissed(false); setActiveIdx(0) }}
        onKeyDown={(e) => {
          if (showPanel && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault()
            const dir = e.key === "ArrowDown" ? 1 : -1
            setActiveIdx((i) => (i + dir + candidates.length) % candidates.length)
            return
          }
          if (showPanel && (e.key === "Tab" || e.key === "Enter") && !e.shiftKey) {
            e.preventDefault()
            complete(candidates[activeIdx]!.name)
            return
          }
          if (showPanel && e.key === "Escape") {
            e.preventDefault()
            setDismissed(true)
            return
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            if (notReady) return
            if (!text.trim() && !attachments.length) return
            submit(busy)
          }
        }}
      />
      {imageSupported && (
        <>
          <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => { pickFiles((m) => m.startsWith("image/"), e.target.files); e.target.value = "" }} />
          <button className="attach-btn icon-btn" title={t.attachImage} aria-label={t.attachImage} onClick={() => imageInput.current?.click()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>
        </>
      )}
      {audioSupported && (
        <>
          <input ref={audioInput} type="file" accept="audio/*" multiple hidden onChange={(e) => { pickFiles((m) => m.startsWith("audio/"), e.target.files); e.target.value = "" }} />
          <button className="attach-btn icon-btn" title={t.attachAudio} aria-label={t.attachAudio} onClick={() => audioInput.current?.click()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </button>
        </>
      )}
      {busy ? (
        <button onClick={() => submit(true)} disabled={notReady || (!text.trim() && !attachments.length)} title={t.queueSend}>
          {t.queueSend}
        </button>
      ) : (
        <button className="primary" disabled={notReady || (!text.trim() && !attachments.length)} onClick={() => submit(false)}>
          {t.send}
        </button>
      )}
    </div>
  )
}
