/**
 * Reader for the assistant's streamed turn (POST
 * /v1/assistant/threads/:id/messages/stream).
 *
 * It is `fetch` rather than `EventSource` because the turn is a POST with a
 * body — attachments, applied documents, the Ask/Agent mode. That is also the
 * better trade for auth: EventSource cannot set headers, which is why the
 * events SSE stream has to accept `?token=` in the URL; here the normal
 * Authorization header applies and no credential ever reaches a query string.
 */
import type { ApiErrorPayload, AssistantStreamFrame, PostAssistantMessageRequest } from '@knowledge/contracts'
import { errorCodeForStatus, isApiErrorPayload } from '@knowledge/contracts'
import { getToken } from '@/lib/api'

const base = import.meta.env.VITE_API_URL ?? '/api'

export interface StreamTurnOptions {
  threadId: string
  body: PostAssistantMessageRequest
  /** Aborting mid-turn stops the reading, not the turn: the server finishes and persists it. */
  signal?: AbortSignal
  onFrame: (frame: AssistantStreamFrame) => void
}

function payload(statusCode: number, message: string, path: string): ApiErrorPayload {
  return {
    statusCode,
    code: errorCodeForStatus(statusCode),
    message,
    path,
    timestamp: new Date().toISOString(),
    requestId: '',
  }
}

/**
 * Streams one turn, calling `onFrame` for every frame in order.
 *
 * Resolves when the stream ends. Failures that happen before the response
 * body exists (auth, network, a 4xx) are delivered as a terminal `error`
 * frame rather than thrown, so a caller only ever has to handle one failure
 * channel — the same one the server uses once the stream is open.
 *
 * An abort resolves silently: the user asked to stop watching, which is not
 * an error to report back to them.
 */
export async function streamAssistantTurn(opts: StreamTurnOptions): Promise<void> {
  const path = `/v1/assistant/threads/${opts.threadId}/messages/stream`
  const token = getToken()
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    })
  } catch (err) {
    if (opts.signal?.aborted) return
    opts.onFrame({ type: 'error', error: payload(0, (err as Error).message, path) })
    return
  }

  if (!response.ok || !response.body) {
    // The request failed before streaming began, so this is an ordinary API
    // error response — pass the envelope through when the filter produced one.
    let error = payload(response.status, `${response.status} ${response.statusText}`, path)
    try {
      const body: unknown = await response.json()
      if (isApiErrorPayload(body)) error = body
    } catch {
      /* non-JSON body (proxy error page) — the synthesized envelope stands */
    }
    opts.onFrame({ type: 'error', error })
    return
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  // SSE frames are separated by a blank line and can be split across chunks,
  // so whatever follows the last separator stays buffered for the next read.
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) {
          try {
            opts.onFrame(JSON.parse(data) as AssistantStreamFrame)
          } catch {
            // A frame we cannot parse is one frame lost, not a dead turn —
            // the terminal `done` frame still carries the authoritative message.
          }
        }
        sep = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) return
    opts.onFrame({ type: 'error', error: payload(0, (err as Error).message, path) })
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
