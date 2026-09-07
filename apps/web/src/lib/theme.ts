import { onScopeDispose, ref, type Ref } from 'vue'

/** Dark/light toggle. The initial class is set pre-paint by an inline script in index.html. */
export function toggleTheme(): void {
  if (import.meta.env.SSR) return
  const dark = document.documentElement.classList.toggle('dark')
  try {
    localStorage.setItem('kn_theme', dark ? 'dark' : 'light')
  } catch {
    /* storage unavailable — theme still toggles for this page */
  }
  // Anything that renders to a *baked* output rather than to CSS — mermaid
  // SVGs, syntax themes — has to re-render on a theme flip. The class is
  // toggled imperatively, so a watcher needs an explicit signal.
  for (const listener of listeners) listener(dark)
}

type Listener = (dark: boolean) => void
const listeners = new Set<Listener>()

/**
 * Reactive theme state. Observes the class as well as our own toggle, so it
 * stays correct if the class is set by the pre-paint script or devtools.
 */
export function useTheme(): { isDark: Ref<boolean> } {
  const isDark = ref(
    !import.meta.env.SSR && typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : false,
  )
  if (import.meta.env.SSR) return { isDark }

  const listener: Listener = (dark) => {
    isDark.value = dark
  }
  listeners.add(listener)

  const observer = new MutationObserver(() => {
    isDark.value = document.documentElement.classList.contains('dark')
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

  onScopeDispose(() => {
    listeners.delete(listener)
    observer.disconnect()
  })

  return { isDark }
}
