import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, diffSince, project, type GraphPair } from './graph-model'
import { DAY, asOfParam, densityBars, nearestTag, stepPoint, timelineWindow } from './graph-time'

/** #81 phase 4 — the graph's time axis and the "changes since" overlay. */

const doc = (id: string) => ({ id, kind: 'document' as const, label: id })
const ent = (id: string) => ({ id, kind: 'entity' as const, label: id, entityType: 'service' })
const edge = (from: string, to: string, extractor = 'frontmatter') => ({ from, to, type: 'DEPENDS_ON', extractor, confidence: 1 })

describe('diffSince', () => {
  const past: GraphPair = { nodes: [doc('d'), ent('service:a'), ent('service:b')], edges: [edge('d', 'service:a'), edge('d', 'service:b')] }
  const now: GraphPair = { nodes: [doc('d'), ent('service:b'), ent('service:c')], edges: [edge('d', 'service:b', 'curated'), edge('d', 'service:c')] }

  it('marks what ended and what was added, keeping what held at both points unmarked', () => {
    const g = diffSince(past, now)
    const byTarget = Object.fromEntries(g.edges.map((e) => [e.to, e.change ?? 'kept']))
    // Provenance moving from frontmatter to curated is not a change of claim.
    expect(byTarget).toEqual({ 'service:a': 'ended', 'service:b': 'kept', 'service:c': 'added' })
  })

  it('brings in the nodes an added edge needs, and only those', () => {
    const g = diffSince(past, now)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['d', 'service:a', 'service:b', 'service:c'])
  })

  it('the projection keeps the marks, so the canvas can draw them', () => {
    const p = project(diffSince(past, now).nodes, diffSince(past, now).edges, DEFAULT_OPTIONS)
    expect(p.edges.find((e) => e.to === 'service:a')?.change).toBe('ended')
    expect(p.edges.find((e) => e.to === 'service:c')?.change).toBe('added')
  })
})

describe('the time axis', () => {
  const now = Date.parse('2026-10-19T12:00:00Z')

  it('spans 90 days, widened to start a day before the oldest tag', () => {
    expect(timelineWindow([], now)).toEqual({ from: now - 90 * DAY, to: now })
    const old = Date.parse('2026-01-01T00:00:00Z')
    expect(timelineWindow([{ at: new Date(old).toISOString() }], now).from).toBe(old - DAY)
  })

  it('folds daily changes into bars scaled to the busiest', () => {
    const from = Date.parse('2026-10-01T00:00:00Z')
    const to = Date.parse('2026-10-11T00:00:00Z')
    const bars = densityBars(
      [
        { day: '2026-10-01', opened: 1, closed: 1 },
        { day: '2026-10-10', opened: 4, closed: 0 },
        { day: '2026-09-01', opened: 99, closed: 0 }, // outside the window
        { day: '2026-10-11', opened: 99, closed: 0 }, // starts at the window's end: not in it either
      ],
      from,
      to,
      10,
    )
    expect(bars[0]).toBe(0.5)
    expect(bars[9]).toBe(1)
    expect(bars.filter((b) => b > 0)).toHaveLength(2)
  })

  it("counts today's changes although today's noon is still to come", () => {
    const to = Date.parse('2026-10-19T03:00:00Z')
    const bars = densityBars([{ day: '2026-10-19', opened: 2, closed: 0 }], to - 10 * DAY, to, 10)
    expect(bars[9]).toBe(1)
  })

  it('keyboard: a day, a week, the start, and past the end is now', () => {
    const from = now - 90 * DAY
    expect(stepPoint(null, 'ArrowLeft', from, now)).toBe(now - DAY)
    expect(stepPoint(now - 3 * DAY, 'PageUp', from, now)).toBeNull()
    expect(stepPoint(now - 10 * DAY, 'PageDown', from, now)).toBe(now - 17 * DAY)
    expect(stepPoint(now - DAY, 'Home', from, now)).toBe(from)
    expect(stepPoint(now - DAY, 'End', from, now)).toBeNull()
    expect(stepPoint(from + DAY, 'PageDown', from, now)).toBe(from)
    expect(stepPoint(now, 'a', from, now)).toBeUndefined()
  })

  it('snaps to the nearest tag within tolerance, else none', () => {
    const tags = [{ name: 'v1', at: '2026-10-01T00:00:00Z' }, { name: 'v2', at: '2026-10-05T00:00:00Z' }]
    expect(nearestTag(Date.parse('2026-10-05T06:00:00Z'), tags, DAY)?.name).toBe('v2')
    expect(nearestTag(Date.parse('2026-10-03T00:00:00Z'), tags, DAY)).toBeNull()
  })

  it('asks the API for a tag by name, otherwise for the instant', () => {
    expect(asOfParam({ at: 0, tag: 'v2.3' })).toBe('tag:v2.3')
    expect(asOfParam({ at: Date.parse('2026-05-01T00:00:00Z') })).toBe('2026-05-01T00:00:00.000Z')
  })
})
