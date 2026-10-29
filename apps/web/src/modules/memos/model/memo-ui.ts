import type { Component } from 'vue'
import { CircleCheck, CircleDashed, FileAudio, Loader2, Sparkles, TriangleAlert, Upload } from 'lucide-vue-next'
import type { MemoStatus } from '@knowledge/contracts'

/**
 * Memos (#551): how a memo's status reads. Icon plus hue, never hue alone —
 * the `connector-ui.ts` shape. The lifecycle emerald/amber/red belong to
 * indexing (DESIGN.md), so in-flight work takes the primary ink and the end
 * states take the panel ramp.
 */
export const MEMO_STATUS_ICON: Record<MemoStatus, Component> = {
  pending: Upload,
  uploaded: CircleDashed,
  transcribing: Loader2,
  transcribed: FileAudio,
  analysing: Sparkles,
  done: CircleCheck,
  failed: TriangleAlert,
}

export const MEMO_STATUS_CLASS: Record<MemoStatus, string> = {
  pending: 'text-muted-foreground',
  uploaded: 'text-muted-foreground',
  transcribing: 'text-primary',
  transcribed: 'text-primary',
  analysing: 'text-primary',
  done: 'text-panel-tip-ink',
  failed: 'text-destructive',
}

/** Still moving: the list and the page poll while any memo is. */
export function isMemoInFlight(status: MemoStatus): boolean {
  return status !== 'done' && status !== 'failed'
}

/**
 * The length a file declares, read by the browser before anything uploads, so
 * an over-long recording is refused at the door. `null` when the browser cannot
 * decode the container — the worker's ffprobe is the real check either way.
 */
export function readDurationSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const done = (value: number | null) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), 5000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      clearTimeout(timer)
      done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null)
    }
    audio.onerror = () => {
      clearTimeout(timer)
      done(null)
    }
    audio.src = url
  })
}

/** The cited segment nearest the start of the recording — where a proposal's evidence begins. */
export function segmentAt(segments: ReadonlyArray<{ i: number; start: number; end: number }>, seconds: number): number | null {
  let found: number | null = null
  for (const s of segments) {
    if (s.start > seconds) break
    found = s.i
  }
  return found
}
