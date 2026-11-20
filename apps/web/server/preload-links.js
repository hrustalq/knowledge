// Preload tags for the chunks one SSR render used (#1332).
//
// The shell's HTML preloads only its entry graph, so a route's own chunks
// (and the locale catalogue) used to start only after `main` had downloaded
// and run: a second, serial wave. The server already knows what it rendered.
// `ssrContext.modules` names every SFC the render drew; the client build's SSR
// manifest maps each to its chunk and CSS, and its build manifest gives the
// chunk's static imports, which a modulepreload does not fetch by itself.
//
// Plain JS on purpose: server.js is unbundled Node.

/**
 * @param {{
 *   ssrManifest: Record<string, string[]>,
 *   manifest: Record<string, { file: string, imports?: string[], css?: string[] }>,
 *   template: string,
 * }} build the client build's two manifests and the shell they serve
 * @returns {(modules: Iterable<string> | undefined) => string}
 *   tags for every file those modules need that the shell does not already load
 */
export function createPreloadLinks({ ssrManifest, manifest, template }) {
  const chunkOf = new Map(Object.values(manifest).map((chunk) => [`/${chunk.file}`, chunk]))
  // The entry's own script, modulepreloads and stylesheets. Its graph is all
  // in here, so the walk stops at the first file it meets from it.
  const inShell = new Set([...template.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))

  return (modules) => {
    const files = new Set()
    const add = (file) => {
      if (files.has(file) || inShell.has(file)) return
      files.add(file)
      const chunk = chunkOf.get(file)
      for (const key of chunk?.imports ?? []) if (manifest[key]) add(`/${manifest[key].file}`)
      for (const css of chunk?.css ?? []) add(`/${css}`)
    }
    for (const id of modules ?? []) for (const file of ssrManifest[id] ?? []) add(file)
    // `crossorigin` as Vite writes it, so the module loader and its CSS helper
    // reuse these fetches. A stylesheet is preloaded, not linked: it must not
    // hold the first paint back.
    return [...files]
      .map((file) =>
        file.endsWith('.css')
          ? `<link rel="preload" as="style" crossorigin href="${file}">`
          : file.endsWith('.js')
            ? `<link rel="modulepreload" crossorigin href="${file}">`
            : '',
      )
      .join('')
  }
}
