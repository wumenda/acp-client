// src/web/ws.ts
import type { BridgeCommand, BridgeEvent } from "../shared/bridge-protocol"

let ws: WebSocket | null = null
let retry = 0

export function bridgeToken(): string {
  return new URLSearchParams(window.location.search).get("token") ?? ""
}

export function connectBridge(onEvent: (e: BridgeEvent) => void, onState: (connected: boolean) => void): () => void {
  const open = () => {
    ws = new WebSocket(`ws://${window.location.host}/api/ws?token=${bridgeToken()}`)
    ws.onopen = () => { retry = 0; onState(true) }
    ws.onmessage = (m) => onEvent(JSON.parse(String(m.data)) as BridgeEvent)
    ws.onclose = () => {
      onState(false)
      if (retry++ < 10) setTimeout(open, Math.min(1000 * 2 ** retry, 10000))
    }
  }
  open()
  return () => { if (ws) ws.onclose = null; ws?.close() }
}

export function sendCommand(cmd: BridgeCommand): void {
  ws?.send(JSON.stringify(cmd))
}
