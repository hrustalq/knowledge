import { onBeforeUnmount, ref } from 'vue'
import { api } from '@/shared/api/client'
import { getWorkspaceId } from '@/shared/api/api'

/** After a failed wait, before the next one: a dropped connection should not spin. */
const RETRY_MS = 3000

/**
 * Watches the workspace's connections while another tab is at a provider
 * (#564). Holds `GET /v1/connections/wait` open in a loop — the API answers
 * the moment a connection, an App installation or the caller's GitHub
 * identity changes, or after ~25 s with nothing — and calls `onChange` on
 * every change, whether or not this tab has focus. Regaining focus also calls
 * it, as the fallback when the poll is down.
 *
 * Client-only: `start()` is called from a click, and everything stops on
 * `stop()` or unmount, aborting the request in flight.
 */
export function useConnectionsWait(onChange: () => unknown) {
  const waiting = ref(false)
  let controller: AbortController | null = null
  const onFocus = () => void onChange()

  async function loop(signal: AbortSignal) {
    let since: string | undefined
    while (!signal.aborted) {
      try {
        const res = await api.get('/v1/connections/wait', {
          query: { workspaceId: getWorkspaceId(), ...(since ? { since } : {}) },
          signal,
        })
        if (res.changed) await onChange()
        since = res.fingerprint
      } catch {
        if (signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }
  }

  function start() {
    stop()
    controller = new AbortController()
    waiting.value = true
    window.addEventListener('focus', onFocus)
    void loop(controller.signal)
  }

  function stop() {
    controller?.abort()
    controller = null
    waiting.value = false
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
  }

  onBeforeUnmount(stop)
  /** One look now, for a "check again" button: the poll keeps running beside it. */
  const check = () => void onChange()
  return { start, stop, check, waiting }
}
