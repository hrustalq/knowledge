// The member app's saved theme (same origin, same key), applied before paint.
// A file rather than an inline script so the console's CSP is script-src 'self'.
try {
  var t = localStorage.getItem('kn_theme')
  if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  }
} catch (e) {}
