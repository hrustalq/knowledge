// The SSR splice: the rendered parts into the HTML template.
//
// Plain JS on purpose: server.js is unbundled Node, and Dockerfile.web copies
// this directory next to it.

/**
 * @param {string} template index.html or reader.html, already transformed in dev
 * @param {{ lang: string, css: string, title?: string | null, head?: string | null, html?: string | null }} parts
 *   `title` already escaped; omitted, the template keeps its own
 * @returns {string}
 */
export function spliceTemplate(template, { lang, css, title, head, html }) {
  // Function replacers only (#1100): a string replacement expands `$&`, `` $` ``
  // and `$'`, and head (the store's state) and html carry page titles.
  let out = template.replace(`<!--app-lang-->`, () => lang).replace(`<!--app-css-->`, () => css)
  if (title !== undefined) out = out.replace(`<title>Knowledge</title>`, () => `<title>${title ?? 'Knowledge'}</title>`)
  return out.replace(`<!--app-head-->`, () => head ?? '').replace(`<!--app-html-->`, () => html ?? '')
}
