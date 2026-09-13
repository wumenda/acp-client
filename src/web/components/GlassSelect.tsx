// src/web/components/GlassSelect.tsx
// 玻璃拟态下拉：原生 <select> 弹层在 Windows 上由系统渲染、无法跟随主题，故用 button + 浮层实现。
import { useEffect, useRef, useState } from "react"

type Opt = { value: string; name: string }

export function GlassSelect({ value, options, onChange, ariaLabel }: {
  value: string
  options: Opt[]
  onChange: (v: string) => void
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  const current = options[idx]

  // 外部点击 / Esc 关闭（Esc 挂 document：不依赖焦点是否在组件内）
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const commit = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIdx(idx)
        setOpen(true)
      }
      return
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false) }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(options.length - 1, (i < 0 ? idx : i) + 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(0, (i < 0 ? idx : i) - 1)) }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const pick = options[activeIdx < 0 ? idx : activeIdx]
      if (pick) commit(pick.value)
    } else if (e.key === "Tab") setOpen(false)
  }

  return (
    <div className={`gselect${open ? " is-open" : ""}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="gselect-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => { setActiveIdx(idx); setOpen((v) => !v) }}
      >
        <span className="gselect-value">{current?.name ?? value}</span>
        <svg className="gselect-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="gselect-pop glass-panel" role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`gselect-option${o.value === value ? " is-selected" : ""}${i === activeIdx ? " is-active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => commit(o.value)}
            >
              <span className="gselect-check" aria-hidden="true">{o.value === value ? "✓" : ""}</span>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
