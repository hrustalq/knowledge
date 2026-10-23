import { describe, expect, it } from 'vitest'
import { readTestFixture } from '@knowledge/contracts'
import { BodyError, emptyCall, fromText, toText, toValue } from './test-fixture'

/** The fixture editor's model (#483): what the step view edits is what the server reads. */

const YAML = `fixture: 1
description: A draft invoice.
inputs:
  currency: EUR
  qaEmail: null
steps:
  - id: login
    call: op:auth:post-/sessions
    request:
      body:
        email: '{{input.qaEmail}}'
        password: '{{secret.qaPassword}}'
    expect: 201
    capture:
      TOKEN: $.accessToken
  - id: merchant
    manual: A KYC merchant exists.
teardown:
  - call: op:billing:delete-/invoices/{}
    request:
      path:
        id: '{{TOKEN}}'
`

describe('test fixture draft', () => {
  it('round-trips through the step view unchanged, and the server reads it', () => {
    const draft = fromText(YAML)
    expect(draft.steps.map((s) => s.kind)).toEqual(['call', 'manual'])
    expect(draft.teardown[0].id).toBe('teardown-1')
    const value = toValue(draft)
    expect(value).toEqual(fromText(toText(draft, 'yaml')) && toValue(fromText(toText(draft, 'json'))))
    expect((value.teardown as Array<Record<string, unknown>>)[0].id).toBeUndefined()
    expect((value.inputs as Record<string, unknown>).qaEmail).toBeNull()
    expect(readTestFixture(value).issues).toEqual([])
  })

  it('drops empty rows and names the step whose body is not JSON', () => {
    const draft = fromText(YAML)
    draft.steps.push({ ...emptyCall('broken'), call: 'op:x:get-/a', headers: [{ name: '', value: 'x' }], body: '{ nope' })
    expect(() => toValue(draft)).toThrow(BodyError)
    try {
      toValue(draft)
    } catch (e) {
      expect(e).toMatchObject({ section: 'steps', index: 2 })
    }
  })
})
