import { onBeforeUnmount, ref } from 'vue'
import { apiUrl } from '@/shared/api/api'

/**
 * One audio element for the whole memo list (#884): a row's player is a
 * remote control for it, so starting a second memo stops the first without
 * the rows knowing about each other. Nothing is created, and nothing is
 * fetched, until a person presses play.
 */
export function useMemoListPlayer() {
  const current = ref<string | null>(null)
  const playing = ref(false)
  const time = ref(0)
  const duration = ref(0)
  let audio: HTMLAudioElement | null = null

  function element(): HTMLAudioElement {
    if (audio) return audio
    const a = new Audio()
    a.preload = 'none'
    a.addEventListener('timeupdate', () => (time.value = a.currentTime))
    a.addEventListener('durationchange', () => (duration.value = Number.isFinite(a.duration) ? a.duration : 0))
    a.addEventListener('play', () => (playing.value = true))
    a.addEventListener('pause', () => (playing.value = false))
    a.addEventListener('ended', () => (time.value = 0))
    a.addEventListener('error', () => (playing.value = false))
    audio = a
    return a
  }

  function toggle(memoId: string) {
    const a = element()
    if (current.value !== memoId) {
      current.value = memoId
      time.value = 0
      duration.value = 0
      a.src = apiUrl(`/v1/memos/${memoId}/audio`)
    } else if (!a.paused) {
      a.pause()
      return
    }
    void a.play().catch(() => (playing.value = false))
  }

  /** Only the memo that is loaded can be sought: the others have no audio here yet. */
  function seek(memoId: string, seconds: number) {
    if (!audio || current.value !== memoId) return
    audio.currentTime = Math.max(0, seconds)
    time.value = audio.currentTime
  }

  onBeforeUnmount(() => {
    audio?.pause()
    audio = null
  })

  return { current, playing, time, duration, toggle, seek }
}
export type MemoListPlayer = ReturnType<typeof useMemoListPlayer>

/**
 * The strip's bar heights, 0..1, from the memo's id. They are not the
 * recording's loudness: that would mean decoding the whole file per row. The
 * same memo always draws the same strip, which is all a row needs to be
 * recognisable.
 */
export function memoBars(memoId: string, count = 28): number[] {
  let seed = 2166136261
  for (let i = 0; i < memoId.length; i += 1) seed = Math.imul(seed ^ memoId.charCodeAt(i), 16777619)
  return Array.from({ length: count }, () => {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9
    return 0.25 + ((seed >>> 0) % 1000) / 1000 * 0.75
  })
}
