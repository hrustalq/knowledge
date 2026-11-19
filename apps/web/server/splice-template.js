// The SSR splice: the rendered parts into the HTML template.
//
// Plain JS on purpose: server.js is unbundled Node, and Dockerfile.web copies
// this directory next to it.

/**
 * @param {string} template index.html or reader.html, already transformed in dev
 * @param {{ lang: string, css: string, title?: string | null, head?: string | null, html?: string | null, preload?: string }} parts
 *   `title` already escaped; omitted, the template keeps its own. `preload`
 *   goes last in <head>, after the entry's own tags, so the route's chunks
 *   queue behind the entry graph rather than ahead of it (#1332).
 * @returns {string}
 */
export function spliceTemplate(template, { lang, css, title, head, html, preload }) {
  // Function replacers only (#1100): a string replacement expands `$&`, `` $` ``
  // and `$'`, and head (the store's state) and html carry page titles.
  let out = template.replace(`<!--app-lang-->`, () => lang).replace(`<!--app-css-->`, () => css)
  if (title !== undefined) out = out.replace(`<title>Knowledge</title>`, () => `<title>${title ?? 'Knowledge'}</title>`)
  if (preload) out = out.replace(`</head>`, () => `${preload}</head>`)
  return out.replace(`<!--app-head-->`, () => head ?? '').replace(`<!--app-html-->`, () => html ?? '')
}
