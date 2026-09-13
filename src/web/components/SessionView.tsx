// src/web/components/SessionView.tsx
import { sendCommand } from "../ws"
import { useFront } from "../state"
import { MessageList } from "./MessageList"
import { Composer } from "./Composer"
import { GlassSelect } from "./GlassSelect"
import { t } from "../i18n"

export function SessionView() {
  const activeKey = useFront((s) => s.activeKey)
  if (!activeKey) {
    return (
      <main className="main empty">
        <div className="empty-hint">
          <div className="empty-title">{t.emptyTitle}</div>
          <p>{t.emptyHint}</p>
          <div className="empty-keys">
            <span><span className="kbd">Enter</span> {t.emptyKeySend}</span>
            <span><span className="kbd">Shift+Enter</span> {t.emptyKeyNewline}</span>
          </div>
        </div>
      </main>
    )
  }
  const [agentId, sessionId] = activeKey.split(":")
  return (
    <main className="main glass-panel">
      <SessionControls agentId={agentId} sessionId={sessionId} />
      <MessageList agentId={agentId} sessionId={sessionId} />
      <Composer agentId={agentId} sessionId={sessionId} />
    </main>
  )
}

/** 会话控制栏（P1-11）：modes 切换 + configOptions（model / thought level 等）。 */
function SessionControls({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const ctrl = useFront((s) => s.controls[`${agentId}:${sessionId}`])
  if (!ctrl?.modes && !ctrl?.configOptions?.length) return null
  const setMode = (modeId: string) => sendCommand({ type: "session.set_mode", agentId, sessionId, modeId })
  const setConfig = (configId: string, value: string | boolean) =>
    sendCommand({ type: "session.set_config_option", agentId, sessionId, configId, value })
  return (
    <div className="session-controls">
      {ctrl.modes && ctrl.modes.availableModes.length > 1 && (
        <GlassSelect
          ariaLabel={t.sessionMode}
          value={ctrl.modes.currentModeId}
          options={ctrl.modes.availableModes.map((m) => ({ value: m.id, name: m.name }))}
          onChange={setMode}
        />
      )}
      {(ctrl.configOptions ?? []).map((o) =>
        o.type === "boolean" ? (
          <label key={o.id} className="config-bool">
            <input type="checkbox" checked={o.currentValue} onChange={(e) => setConfig(o.id, e.target.checked)} />
            {o.name}
          </label>
        ) : (
          <GlassSelect
            key={o.id}
            ariaLabel={o.name}
            value={o.currentValue}
            options={o.options}
            onChange={(v) => setConfig(o.id, v)}
          />
        ),
      )}
    </div>
  )
}
