import { onScopeDispose, ref, type Ref } from 'vue'

/**
 * #1040: the theme is a setting (profile settings), not a top-bar toggle, and
 * it follows the device unless someone chose. `system` stores nothing — the
 * pre-paint script in index.html reads an absent `kn_theme` as "ask the
 * device" — and `followSystemTheme` keeps an open page in step with it.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_KEY = 'kn_theme'
const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export function getThemePreference(): ThemePreference {
  if (import.meta.env.SSR) return 'system'
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function applyDark(dark: boolean): void {
  if (document.documentElement.classList.contains('dark') === dark) return
  document.documentElement.classList.toggle('dark', dark)
  for (const listener of listeners) listener(dark)
}

export function setThemePreference(pref: ThemePreference): void {
  if (import.meta.env.SSR) return
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* storage unavailable — the theme still applies for this page */
  }
  applyDark(pref === 'system' ? darkQuery().matches : pref === 'dark')
}

/** Called once on the client: a device switching to dark mode switches the app while it is on `system`. */
export function followSystemTheme(): void {
  if (import.meta.env.SSR) return
  darkQuery().addEventListener('change', (e) => {
    if (getThemePreference() === 'system') applyDark(e.matches)
  })
}

/** Dark/light toggle (the public reader's). The initial class is set pre-paint by an inline script in index.html. */
export function toggleTheme(): void {
  if (import.meta.env.SSR) return
  const dark = document.documentElement.classList.toggle('dark')
  try {
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
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
