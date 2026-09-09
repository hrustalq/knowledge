import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * Copy-to-clipboard with a short-lived result.
 *
 * The failure state is not decorative: the clipboard API is unavailable on
 * insecure origins and can be denied outright, and these buttons hand over a
 * whole document bundle. A button that silently did nothing would leave someone
 * pasting the last thing they copied into their agent.
 */
export function useCopy(resetMs = 1500): {
  state: Ref<'idle' | 'copied' | 'failed'>
  copy: (text: string) => Promise<void>
} {
  const state = ref<'idle' | 'copied' | 'failed'>('idle')
  let timer: ReturnType<typeof setTimeout> | null = null

  function settle(next: 'copied' | 'failed') {
    state.value = next
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => (state.value = 'idle'), resetMs)
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      settle('copied')
    } catch {
      settle('failed')
    }
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  return { state, copy }
}
