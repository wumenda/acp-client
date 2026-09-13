// src/web/components/RegistryModal.tsx
// ACP Registry（P2-21）：浏览/安装/更新/卸载公共 agent 目录
import { useEffect } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

const STAGE_TEXT: Record<string, string> = {
  downloading: "下载中…",
  verifying: "校验中…",
  extracting: "解压中…",
  registering: "注册中…",
  done: "",
  error: "失败",
}

export function RegistryModal({ onClose }: { onClose: () => void }) {
  const registry = useFront((s) => s.registry)
  // 打开时若无数据则强制刷新一次（有缓存则由 onOpen snapshot 即时填充）
  useEffect(() => {
    if (!useFront.getState().registry) sendCommand({ type: "registry.refresh" })
  }, [])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal registry" onClick={(e) => e.stopPropagation()}>
        <div className="registry-head">
          <div>
            <h3>{t.registryTitle}</h3>
            <p className="registry-sub">{t.registrySubtitle}</p>
          </div>
          <div className="registry-head-actions">
            {registry?.stale && <span className="muted">{t.registryStale}</span>}
            <button onClick={() => sendCommand({ type: "registry.refresh" })}>{t.registryRefresh}</button>
            <button onClick={onClose}>{t.registryClose}</button>
          </div>
        </div>
        {!registry && <div className="muted">{t.registryLoading}</div>}
        {registry && registry.agents.length === 0 && <div className="muted">{t.registryEmpty}</div>}
        <ul className="registry-list">
          {registry?.agents.map((a) => {
            const prog = registry.progress[a.id]
            const busy = prog != null && !["done", "error"].includes(prog.stage)
            return (
              <li key={a.id} className={`registry-item${a.supported ? "" : " disabled"}`}>
                {a.icon && <img className="registry-icon" src={a.icon} alt="" width={16} height={16} />}
                <div className="registry-main">
                  <div className="registry-line">
                    <b>{a.name}</b>
                    <span className="muted">v{a.version}</span>
                    <span className="badge">{a.kind}</span>
                    {a.installed && (
                      <span className="badge ok">
                        {t.registryInstalled}
                        {a.installedVersion !== a.version ? ` v${a.installedVersion}` : ""}
                      </span>
                    )}
                    {a.updateAvailable && <span className="badge update">{t.registryUpdate} v{a.version}</span>}
                    {!a.supported && <span className="badge">{t.registryUnsupported}</span>}
                  </div>
                  {a.description && <div className="muted desc">{a.description}</div>}
                  <div className="muted meta">
                    {a.authors?.length ? `${t.registryBy}: ${a.authors.join(", ")}` : ""}
                    {a.license ? ` · ${t.registryLicense}: ${a.license}` : ""}
                  </div>
                  {prog && prog.stage !== "done" && (
                    <div className={prog.stage === "error" ? "err" : "muted"}>
                      {prog.stage === "error" ? `${STAGE_TEXT.error}: ${prog.message ?? ""}` : STAGE_TEXT[prog.stage]}
                    </div>
                  )}
                </div>
                <div className="registry-actions">
                  {a.installed ? (
                    <button disabled={busy} onClick={() => sendCommand({ type: "registry.uninstall", id: a.id })}>
                      {t.registryUninstall}
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={!a.supported || busy}
                      onClick={() => sendCommand({ type: "registry.install", id: a.id })}
                    >
                      {busy ? t.registryInstalling : t.registryInstall}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
