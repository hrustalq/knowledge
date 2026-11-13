import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE, parseScene, renderSceneToSvg } from './drawing'

// A scene is page text: whatever an author (or a connector, an import, a merged
// proposal) writes into it reaches an SVG string the node view inserts as HTML.
const hostile = '" onmouseover="alert(1)" x="'
const scene = (els: unknown[]) => JSON.stringify({ v: 1, w: 720, h: 420, els })
const rect = { id: 'a', t: 'rect', x: 10, y: 10, w: 100, h: 50, s: { stroke: 'blue', fill: 'none', sw: 2, dash: 0, fs: 16 }, text: 'Box' }

describe('parseScene', () => {
  it('keeps a well-formed element as written', () => {
    expect(parseScene(scene([rect])).els).toEqual([rect])
  })

  it.each([
    ['stroke', { stroke: hostile }],
    ['fill', { fill: hostile }],
    ['sw', { sw: hostile }],
    ['fs', { fs: hostile }],
    ['dash', { dash: hostile }],
  ])('a hostile s.%s falls back to the default, and renders no extra attribute', (_, style) => {
    const parsed = parseScene(scene([{ ...rect, s: { ...rect.s, ...style } }]))
    expect(parsed.els).toHaveLength(1)
    const svg = renderSceneToSvg(parsed)
    expect(svg).not.toContain('onmouseover')
    expect(svg).toContain('<rect ')
  })

  it('a missing style is the default style', () => {
    expect(parseScene(scene([{ ...rect, s: undefined }])).els[0].s).toEqual(DEFAULT_STYLE)
  })

  it.each([
    ['an unknown kind', { t: 'foreignObject' }],
    ['a non-numeric coordinate', { x: hostile }],
    ['an infinite size', { w: 1e400 }],
    ['non-numeric points', { t: 'line', pts: [[0, 0], [hostile, 1]] }],
    ['non-string text', { text: { toString: 1 } }],
    ['a non-string id', { id: 7 }],
  ])('drops an element with %s', (_, patch) => {
    expect(parseScene(scene([{ ...rect, ...patch }])).els).toEqual([])
  })

  it('the scene size is a positive finite number', () => {
    const parsed = parseScene(JSON.stringify({ v: 1, w: hostile, h: -5, els: [] }))
    expect([parsed.w, parsed.h]).toEqual([720, 420])
  })
})
