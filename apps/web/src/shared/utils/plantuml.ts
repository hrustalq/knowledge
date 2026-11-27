/**
 * PlantUML in the browser (docs/features/87).
 *
 * The official `@plantuml/core` engine — PlantUML compiled to JavaScript with
 * TeaVM — vendored under `public/plantuml/` (version, checksums and licences in
 * its README). No Java, no server, no eval, and nothing leaves for another
 * origin: the engine, Graphviz and the C4 stdlib are all served from here.
 *
 * Lazy on purpose: the engine is a 3 MB ES module, so it is loaded with a
 * dynamic `import()` of a runtime URL the first time a diagram is drawn. Nothing
 * app code imports statically, and the bundler cannot fold it in.
 *
 * The engine queues its own renders, but they still share one module-level
 * queue here: a theme change re-renders every block on the page, and a render
 * that settles must be paired with the dark flag it was asked for.
 */

declare global {
  interface Window {
    /** The URL prefix the engine resolves a `!include <C4/…>` bundle against; it must end with `/`. */
    PLANTUML_STDLIB_BASE?: string
    /** Viz.js 3 (Graphviz compiled to JavaScript), defined by `viz-global.js`. */
    Viz?: unknown
  }
}

/**
 * The directory the vendored engine is served from, absolute: both apps are
 * mounted at the root of their host (`vite.config.ts` sets no base), and a URL
 * prefix has to end with `/`.
 */
export const PLANTUML_DIR = '/plantuml/'

export interface PlantumlProblem {
  /** 1-based line in the author's source, when the engine named one. */
  line: number | null
  /** What PlantUML said, when it said something short enough to show; '' means the caller's own wording. */
  message: string
}

/** A diagram PlantUML could not draw: PlantUML renders an error *inside* an SVG, which this reports as a failure. */
export class PlantumlError extends Error {
  /** 1-based line in the author's source, when the engine named one. */
  readonly line: number | null

  constructor(line: number | null, message: string) {
    super(message)
    this.name = 'PlantumlError'
    this.line = line
  }
}

interface PlantumlEngine {
  renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: { dark?: boolean; maxSvgSize?: number },
  ): void
}

let loading: Promise<PlantumlEngine> | null = null

/** A classic script tag, resolved once: a failure is not remembered. */
function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new PlantumlError(null, `${src} failed to load`))
    document.head.append(script)
  })
}

/** `viz-global.js` is a classic script defining a global, so it is a tag, not an import. */
function loadViz(): Promise<void> {
  return window.Viz ? Promise.resolve() : injectScript(`${PLANTUML_DIR}viz-global.js`)
}

let themes: Promise<void> | null = null

/** `themes.js` fills `window.PLANTUML_THEMES`; only a diagram that names a `!theme` needs it. */
function loadThemes(): Promise<void> {
  if (!themes) {
    themes = injectScript(`${PLANTUML_DIR}themes.js`)
    themes.catch(() => {
      themes = null
    })
  }
  return themes
}

/** A fence that asks the engine for a theme it has to have loaded. */
const NAMES_THEME = /^\s*!theme\b/m

function loadEngine(): Promise<PlantumlEngine> {
  if (!loading) {
    loading = (async () => {
      // Before the first render: a `!include <C4/…>` resolves its bundle through this prefix.
      window.PLANTUML_STDLIB_BASE = PLANTUML_DIR
      await loadViz()
      return (await import(/* @vite-ignore */ `${PLANTUML_DIR}plantuml.js`)) as PlantumlEngine
    })()
    // A failed load is not remembered: the next diagram (or the next page) starts over.
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * The SVG for a `plantuml` fence, still to be sanitized. Renders are serialized
 * in call order, so two blocks on one page cannot interleave inside the engine.
 *
 * A syntax error is not a rejection: PlantUML draws the error into the SVG it
 * returns. That output is recognised and thrown as a `PlantumlError`, because a
 * reader must see the source and a message, never PlantUML's own error drawing.
 */
export function plantumlSvg(source: string, dark = false): Promise<string> {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const run = async () => {
    const engine = await loadEngine()
    if (NAMES_THEME.test(source)) await loadThemes()
    const svg = await new Promise<string>((resolve, reject) => {
      engine.renderToString(
        lines,
        resolve,
        (message) => reject(new PlantumlError(null, String(message ?? ''))),
        // maxSvgSize keeps its default (8192 px): a diagram beyond it fails
        // rather than freezing the tab, and the reproducer's C4 model is under it.
        { dark },
      )
    })
    const problem = plantumlProblemOf(svg)
    if (problem) throw new PlantumlError(problem.line, problem.message)
    return svg
  }
  const next = queue.then(run, run)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * The colour PlantUML paints an error diagram's text in. It is the engine's own
 * constant, and nothing else in a drawing uses it — the reliable signal, since a
 * failing render still succeeds with an SVG.
 */
const ERROR_TEXT_FILL = 'fill="#33FF02"'

/** `[From textarea (line 2) ]` — the engine's own marker for where it gave up. */
const ERROR_LINE = /\(line (\d+)\)/

/** PlantUML's own wording, once the version banner and the echoed source are stripped. */
const ERROR_MESSAGE = /(Syntax Error\?(?:\s*\(Assumed diagram type: [^)]+\))?|cannot include [\s\S]*)$/

/** Whether an SVG the engine returned is PlantUML's error drawing, and what it says. */
export function plantumlProblemOf(svg: string): PlantumlProblem | null {
  const text = svgText(svg)
  if (!svg.includes(ERROR_TEXT_FILL) && !text.includes('Syntax Error?')) return null
  return {
    line: Number(ERROR_LINE.exec(text)?.[1]) || null,
    message: (ERROR_MESSAGE.exec(text)?.[1] ?? '').trim(),
  }
}

/**
 * Any failure, in the editor's terms: a diagram PlantUML refused, or the
 * engine itself throwing (a stack overflow, a bundle that would not load).
 */
export function plantumlProblem(error: unknown): PlantumlProblem {
  if (error instanceof PlantumlError) return { line: error.line, message: error.message }
  const text = error instanceof Error ? error.message : String(error ?? '')
  return { line: Number(ERROR_LINE.exec(text)?.[1]) || null, message: text.split('\n')[0]?.trim() ?? '' }
}

/** The text inside an SVG, without a DOM: the error drawing's message is all this needs. */
function svgText(svg: string): string {
  return svg
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The engine's one export statement: `export{C as render,D as renderToString};`. */
const MODULE_EXPORT = /export\s*\{([^{}]*)\}\s*;?\s*$/

/**
 * The engine as a classic script for an export (docs/features/45). A module
 * cannot load from `file://`, where an HTML bundle is opened, so the export
 * ships the same source with its export statement replaced by
 * `window.PlantUML = { render, renderToString }`. Nothing else changes — the
 * licence headers and the code are the vendored file's own.
 *
 * Throws when the engine has no such statement: a new version that compiles
 * differently must be noticed by a test, not silently shipped as a script that
 * defines nothing.
 */
export function plantumlClassicScript(module: string): string {
  const match = MODULE_EXPORT.exec(module)
  if (!match) throw new Error('PlantUML engine has no export statement to expose')
  const names = match[1]!
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [local, exported] = part.split(/\s+as\s+/)
      return `${(exported ?? local)!.trim()}:${local!.trim()}`
    })
  return `${module.slice(0, match.index)}window.PlantUML={${names.join(',')}};${module.slice(match.index + match[0].length)}`
}
