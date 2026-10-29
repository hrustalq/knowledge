import { describe, expect, it } from 'vitest'
import { offeredMethods } from './connection-providers'

describe('offeredMethods (#564)', () => {
  const all = { app: true, oauth: true }

  it('offers the App or OAuth beside a token until the person has signed in', () => {
    expect(offeredMethods('github', all, false)).toEqual(['token', 'app'])
    expect(offeredMethods('figma', all, false)).toEqual(['token', 'oauth'])
  })

  it('never asks for a token once the person signed in through OAuth or the App', () => {
    expect(offeredMethods('github', all, true)).toEqual(['app'])
    expect(offeredMethods('figma', all, true)).toEqual(['oauth'])
  })

  it('keeps the token where it is the only way in: no keys on the server, or no OAuth for the provider', () => {
    expect(offeredMethods('github', { app: false, oauth: false }, true)).toEqual(['token'])
    expect(offeredMethods('notion', all, true)).toEqual(['token'])
  })
})
