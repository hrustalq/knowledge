import { describe, expect, it } from 'vitest'
import { isDirectInternalCall } from './export-render.js'

/**
 * The export renderer answers only the worker (docs/features/45): an internal
 * peer that came through no proxy. Caddy is internal too, but it always adds
 * X-Forwarded-For, so nothing from the internet passes.
 */
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })

describe('isDirectInternalCall', () => {
  it('admits an internal peer with no proxy headers', () => {
    expect(isDirectInternalCall(req('172.18.0.5'))).toBe(true)
    expect(isDirectInternalCall(req('::ffff:127.0.0.1'))).toBe(true)
  })

  it('refuses anything the front proxy forwarded', () => {
    expect(isDirectInternalCall(req('172.18.0.2', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false)
    expect(isDirectInternalCall(req('172.18.0.2', { 'x-forwarded-host': 'docs.example.com' }))).toBe(false)
    expect(isDirectInternalCall(req('172.18.0.2', { forwarded: 'for=203.0.113.9' }))).toBe(false)
  })

  it('refuses a public peer', () => {
    expect(isDirectInternalCall(req('203.0.113.9'))).toBe(false)
    expect(isDirectInternalCall(req(undefined))).toBe(false)
  })
})
