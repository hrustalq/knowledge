/** Dark/light toggle. The initial class is set pre-paint by an inline script in index.html. */
export function toggleTheme(): void {
  if (import.meta.env.SSR) return
  const dark = document.documentElement.classList.toggle('dark')
  try {
    localStorage.setItem('kn_theme', dark ? 'dark' : 'light')
  } catch {
    /* storage unavailable — theme still toggles for this page */
  }
}
