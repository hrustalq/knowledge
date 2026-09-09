/**
 * The bridge between the stylesheet and the canvas.
 *
 * Canvas2D takes CSS color strings, but it cannot take `var(--primary)` and it
 * cannot dilute a color for us. Both problems are solved once here: each token
 * is read off a probe element, normalized to channels through the canvas
 * `fillStyle` round-trip — assigning any color the browser understands and
 * reading it back always yields `#rrggbb` / `rgba(...)`, whatever color space
 * went in — and then handed out as `rgba()` at whatever alpha the renderer
 * wants. That keeps the graph honest against "The Two Grounds Rule": nothing is
 * hard-coded per theme, the palette is simply re-read when `.dark` toggles.
 */

export type Rgb = readonly [number, number, number]

/** Every token the renderer draws with. */
export interface GraphPalette {
  background: Rgb
  card: Rgb
  foreground: Rgb
  muted: Rgb
  primary: Rgb
  primaryInk: Rgb
  border: Rgb
  /** Entity hues, keyed by the `entityType` the extractor emitted. */
  entity: Record<string, Rgb>
  entityFallback: Rgb
  /** Indexing lifecycle, for the status ring on a page node. */
  status: Record<'indexed' | 'indexing' | 'failed' | 'draft', Rgb>
}

const FALLBACK: Rgb = [128, 128, 128]

function readVars(el: HTMLElement, names: string[]): Record<string, Rgb> {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none'
  el.appendChild(probe)
  const resolve = makeResolver()
  const out: Record<string, Rgb> = {}
  for (const name of names) {
    probe.style.color = ''
    probe.style.color = `var(${name})`
    out[name] = resolve(getComputedStyle(probe).color)
  }
  probe.remove()
  return out
}

/**
 * Paint the color onto one pixel and read the pixel back.
 *
 * The obvious shortcut — assign to `fillStyle` and read the string back —
 * cannot be used: Chrome now round-trips a wide-gamut color in its *own* space,
 * so `oklch(0.45 0.15 268)` comes back as `oklch(0.45 0.15 268)`. Scraping
 * three numbers out of that yields rgb(0, 0, 268), which clamps to pure blue,
 * and the entire palette silently collapses onto one hue. Rasterizing is the
 * only readback that is actually in the space the canvas will draw in.
 */
function makeResolver(): (value: string) => Rgb {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return (value: string) => {
    if (!ctx || !value) return FALLBACK
    ctx.clearRect(0, 0, 1, 1)
    // Seed with a sentinel so an unparseable value is visibly wrong in dev
    // rather than inheriting whatever the previous token painted.
    ctx.fillStyle = '#808080'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0]!, d[1]!, d[2]!]
  }
}

/**
 * Entity hues come from the diagram ramp (`--kn-draw-*`) rather than from new
 * tokens: a relation graph *is* a drawn diagram, the ramp is already declared
 * in both themes, and reusing it keeps the accent rule intact — indigo stays
 * spoken for by pages, which are the structure here.
 *
 * `concept` is deliberately the quietest of the five. It is by far the most
 * numerous type in a real workspace, and a graph where the most common thing
 * is also the loudest has no hierarchy at all.
 */
const ENTITY_VARS: Record<string, string> = {
  service: '--kn-draw-blue',
  component: '--kn-draw-violet',
  concept: '--kn-draw-ink',
  team: '--kn-draw-green',
  role: '--kn-draw-amber',
  process: '--kn-draw-green',
  contract: '--kn-draw-amber',
  system: '--kn-draw-blue',
}

/** Order the legend renders in — most structural first, not alphabetical. */
export const ENTITY_TYPE_ORDER = ['service', 'component', 'process', 'system', 'contract', 'team', 'role', 'concept']

/**
 * The lifecycle dot's colors are read off the very classes `statusDot()` hands
 * the DOM, not off tokens that happen to match today. The dot beside a title
 * and the ring on its node are the same fact; reading them from one source is
 * what stops them from drifting apart.
 */
const STATUS_CLASSES = {
  indexed: 'bg-emerald-500',
  indexing: 'bg-amber-500',
  failed: 'bg-red-500',
  draft: 'bg-muted-foreground',
} as const

function readClasses(el: HTMLElement, classes: string[]): Record<string, Rgb> {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none'
  el.appendChild(probe)
  const resolve = makeResolver()
  const out: Record<string, Rgb> = {}
  for (const c of classes) {
    probe.className = c
    out[c] = resolve(getComputedStyle(probe).backgroundColor)
  }
  probe.remove()
  return out
}

export function readPalette(host: HTMLElement): GraphPalette {
  const base = [
    '--background',
    '--card',
    '--foreground',
    '--muted-foreground',
    '--primary',
    '--primary-foreground',
    '--border',
    '--kn-draw-ink',
  ]
  const entityVars = [...new Set(Object.values(ENTITY_VARS))]
  const v = readVars(host, [...base, ...entityVars])
  const sc = readClasses(host, Object.values(STATUS_CLASSES))

  const entity: Record<string, Rgb> = {}
  for (const [type, varName] of Object.entries(ENTITY_VARS)) entity[type] = v[varName] ?? FALLBACK

  return {
    background: v['--background'] ?? FALLBACK,
    card: v['--card'] ?? FALLBACK,
    foreground: v['--foreground'] ?? FALLBACK,
    muted: v['--muted-foreground'] ?? FALLBACK,
    primary: v['--primary'] ?? FALLBACK,
    primaryInk: v['--primary-foreground'] ?? FALLBACK,
    border: v['--border'] ?? FALLBACK,
    entity,
    entityFallback: v['--kn-draw-ink'] ?? FALLBACK,
    status: {
      indexed: sc[STATUS_CLASSES.indexed] ?? FALLBACK,
      indexing: sc[STATUS_CLASSES.indexing] ?? FALLBACK,
      failed: sc[STATUS_CLASSES.failed] ?? FALLBACK,
      draft: v['--muted-foreground'] ?? FALLBACK,
    },
  }
}

export const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

/** Blend toward another color — used for the lit core of a page node. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function entityColor(palette: GraphPalette, type: string | undefined): Rgb {
  return (type && palette.entity[type]) || palette.entityFallback
}

/** The CSS color for a legend swatch, so the panel and the canvas cannot drift. */
export function entityCssVar(type: string): string {
  return ENTITY_VARS[type] ?? '--kn-draw-ink'
}
