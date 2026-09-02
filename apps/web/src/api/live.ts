// Live tracked-entity updates: WebSocket client for /v1/events/ws.
// Speaks the strict @knowledge/contracts protocol (LiveClientMessage /
// LiveServerMessage), authenticates with ?token= (same as SSE), reconnects
// with backoff and re-subscribes automatically. Access control lives
// server-side (viewer role per subscribed workspace); tracking configuration
// is per-subscription (events / documents filters).
import type {
  ApiErrorPayload,
  KnowledgeEvent,
  LiveClientMessage,
  LiveServerMessage,
  LiveTrackingConfig,
} from '@knowledge/contracts'
import { getToken } from '@/lib/api'

export type LiveEventListener = (event: KnowledgeEvent) => void
export type LiveErrorListener = (error: ApiErrorPayload) => void

function wsBase(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined
  if (explicit) return explicit
  // Dev: straight to the API (the Vite middleware proxy does not upgrade WS).
  if (import.meta.env.DEV) return 'ws://localhost:3000'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api`
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export class LiveClient {
  private socket: WebSocket | null = null
  private reconnectDelay = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /** Desired subscriptions — replayed on every (re)connect. */
  private readonly subscriptions = new Map<string, LiveTrackingConfig | undefined>()
  private readonly eventListeners = new Set<LiveEventListener>()
  private readonly errorListeners = new Set<LiveErrorListener>()

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(): void {
    if (import.meta.env.SSR || this.socket || this.closed) return
    const token = getToken()
    const url = `${wsBase()}/v1/events/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const socket = new WebSocket(url)
    this.socket = socket

    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS
      for (const [workspaceId, tracking] of this.subscriptions) {
        this.send({ type: 'subscribe', workspaceId, tracking })
      }
    }
    socket.onmessage = (msg) => {
      let parsed: LiveServerMessage
      try {
        parsed = JSON.parse(msg.data as string) as LiveServerMessage
      } catch {
        return
      }
      if (parsed.type === 'event') {
        for (const listener of this.eventListeners) listener(parsed.event)
      } else if (parsed.type === 'error') {
        for (const listener of this.errorListeners) listener(parsed.error)
      }
    }
    socket.onclose = (ev) => {
      this.socket = null
      // 4401 = auth refused — reconnecting with the same token is pointless.
      if (this.closed || ev.code === 4401) return
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    }
    socket.onerror = () => {
      /* onclose fires next and owns reconnection */
    }
  }

  /** Track a workspace (ACL-checked server-side). Re-subscribing replaces the tracking config. */
  subscribe(workspaceId: string, tracking?: LiveTrackingConfig): void {
    this.subscriptions.set(workspaceId, tracking)
    this.send({ type: 'subscribe', workspaceId, tracking })
  }

  unsubscribe(workspaceId: string): void {
    this.subscriptions.delete(workspaceId)
    this.send({ type: 'unsubscribe', workspaceId })
  }

  onEvent(listener: LiveEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onError(listener: LiveErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = null
  }

  private send(message: LiveClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }
}
