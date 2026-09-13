// src/web/components/ElicitationModal.tsx
// elicitation 弹窗（P2-19）：form 模式按 requestedSchema 渲染表单；url 模式引导用户打开链接。
// 多请求排队逐个应答；accept 时收集 content（number/integer/boolean/array 按协议类型转换）。
// ElicitationPropertySchema 是宽松联合（含自定义扩展），先归一为 FieldView 再渲染。
import { useEffect, useMemo, useState } from "react"
import type { ElicitationPropertySchema } from "../../shared/bridge-protocol"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront, type ElicitationView } from "../state"

type FieldValue = string | number | boolean | string[]

type FieldView = {
  type: "string" | "number" | "boolean" | "select" | "multiselect"
  label: string
  description?: string
  options?: Array<{ value: string; name: string }>
  isInteger?: boolean
  defaultValue?: FieldValue
}

/** 宽松 schema → 视图模型：未知 type 降级为字符串输入（ADR-0003 宽容降级） */
function normalize(name: string, s: ElicitationPropertySchema): FieldView {
  const raw = s as { type: string; title?: unknown; description?: unknown; default?: unknown; enum?: unknown; oneOf?: unknown; items?: { enum?: unknown } }
  const label = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : name
  const description = typeof raw.description === "string" && raw.description.length > 0 ? raw.description : undefined
  const base = { label, description }
  const def = typeof raw.default === "string" || typeof raw.default === "number" || typeof raw.default === "boolean" ? raw.default : undefined
  if (raw.type === "boolean") return { type: "boolean", ...base, defaultValue: raw.default === true }
  if (raw.type === "number" || raw.type === "integer") {
    return { type: "number", isInteger: raw.type === "integer", ...base, defaultValue: typeof raw.default === "number" ? raw.default : undefined }
  }
  if (raw.type === "array") {
    // multi-select：options 来自 items.enum；缺省时退化为逗号分隔文本输入
    const itemEnum = raw.items?.enum
    if (Array.isArray(itemEnum)) {
      const options = itemEnum.filter((v): v is string => typeof v === "string").map((v) => ({ value: v, name: v }))
      if (options.length) return { type: "multiselect", options, ...base, defaultValue: Array.isArray(raw.default) ? raw.default.filter((v): v is string => typeof v === "string") : undefined }
    }
    return { type: "multiselect", ...base }
  }
  if (Array.isArray(raw.oneOf)) {
    const options = raw.oneOf.flatMap((o) =>
      o && typeof o === "object" && typeof (o as { const?: unknown }).const === "string"
        ? [{ value: (o as { const: string }).const, name: String((o as { title?: unknown }).title ?? (o as { const: string }).const) }]
        : [],
    )
    if (options.length) return { type: "select", options, ...base, defaultValue: typeof def === "string" ? def : undefined }
  }
  if (Array.isArray(raw.enum)) {
    const options = raw.enum.filter((v): v is string => typeof v === "string").map((v) => ({ value: v, name: v }))
    if (options.length) return { type: "select", options, ...base, defaultValue: typeof def === "string" ? def : undefined }
  }
  return { type: "string", ...base, defaultValue: typeof def === "string" ? def : undefined }
}

function FieldInput({ view, value, onChange }: { view: FieldView; value: FieldValue | undefined; onChange: (v: FieldValue | undefined) => void }) {
  if (view.type === "boolean") {
    return (
      <label className="eli-field">
        <span className="eli-label">{view.label}</span>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </label>
    )
  }
  if (view.type === "multiselect") {
    const selected = Array.isArray(value) ? value : []
    if (view.options) {
      return (
        <div className="eli-field">
          <span className="eli-label">{view.label}</span>
          <div className="eli-choices">
            {view.options.map((o) => (
              <label key={o.value}>
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))}
                />
                {o.name}
              </label>
            ))}
          </div>
        </div>
      )
    }
    return (
      <label className="eli-field">
        <span className="eli-label">{view.label}</span>
        <input value={selected.join(", ")} onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter((s) => s.length > 0))} />
      </label>
    )
  }
  if (view.type === "select") {
    return (
      <label className="eli-field">
        <span className="eli-label">{view.label}</span>
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(view.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.name}</option>
          ))}
        </select>
      </label>
    )
  }
  if (view.type === "number") {
    return (
      <label className="eli-field">
        <span className="eli-label">{view.label}</span>
        <input
          type="number"
          step={view.isInteger ? 1 : "any"}
          value={typeof value === "number" ? String(value) : (value as string) ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </label>
    )
  }
  return (
    <label className="eli-field">
      <span className="eli-label">{view.label}</span>
      <input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export function ElicitationModal() {
  const r = useFront((s) => s.elicitation)
  const queueSize = useFront((s) => s.elicitations.length)
  const [values, setValues] = useState<Record<string, FieldValue | undefined>>({})
  const [invalid, setInvalid] = useState(false)
  // 队列切换请求时重置表单
  useEffect(() => {
    setValues({})
    setInvalid(false)
  }, [r?.requestId])

  const fields = useMemo(() => Object.entries(r?.fields ?? {}).map(([name, schema]) => ({ name, view: normalize(name, schema) })), [r])

  useEffect(() => {
    if (!r || r.mode !== "form") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") sendCommand({ type: "elicitation.respond", requestId: r.requestId, action: "cancel" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [r])

  if (!r) return null

  const respond = (action: "accept" | "decline" | "cancel", content?: Record<string, FieldValue>) => {
    sendCommand({ type: "elicitation.respond", requestId: r.requestId, action, ...(content ? { content } : {}) })
  }

  const submit = () => {
    // required 校验：缺失/空串/undefined → 拒绝提交
    const content: Record<string, FieldValue> = {}
    for (const { name } of fields) {
      const v = values[name]
      if (r.required?.includes(name) && (v === undefined || v === "")) {
        setInvalid(true)
        return
      }
      if (v !== undefined) content[name] = v
    }
    setInvalid(false)
    respond("accept", content)
  }

  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label={r.mode === "url" ? t.eliUrlTitle : t.eliTitle}>
        <h3>
          {r.mode === "url" ? t.eliUrlTitle : t.eliTitle}
          {queueSize > 1 && <span className="perm-queue">（{queueSize - 1} {t.permQueueSuffix}）</span>}
        </h3>
        <p>{r.message}</p>
        {r.mode === "form" ? (
          <>
            {fields.map(({ name, view }) => (
              <FieldInput key={name} view={view} value={values[name]} onChange={(v) => setValues((s) => ({ ...s, [name]: v }))} />
            ))}
            {invalid && <p className="eli-invalid">{t.eliSubmitInvalid}</p>}
            <div className="modal-actions">
              <button className="primary" onClick={submit}>{t.eliFormAction}</button>
              <button className="danger" onClick={() => respond("decline")}>{t.eliDecline}</button>
            </div>
          </>
        ) : r.mode === "url" ? (
          <>
            {r.url && (
              <div className="fs-target">
                <code className="fs-path">{r.url}</code>
              </div>
            )}
            <p className="eli-hint">{t.eliUrlHint}</p>
            <div className="modal-actions">
              {r.url && (
                <a className="button-as-link primary" href={r.url} target="_blank" rel="noreferrer" onClick={() => respond("accept")}>
                  {t.eliOpenUrl}
                </a>
              )}
              <button className="danger" onClick={() => respond("decline")}>{t.eliDecline}</button>
            </div>
          </>
        ) : (
          // 自定义/未来 mode：知情展示，仅允许拒绝（ADR-0003 宽容降级）
          <div className="modal-actions">
            <button className="danger" onClick={() => respond("decline")}>{t.eliDecline}</button>
          </div>
        )}
      </div>
    </div>
  )
}
