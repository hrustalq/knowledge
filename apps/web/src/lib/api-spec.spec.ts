import { describe, expect, it } from 'vitest'
import type { ApiOperationInfo } from '@knowledge/contracts'
import { deref, groupByTag, operationView, resolvePointer, schemaTree, serversOf, typeLabel } from './api-spec'

const doc = {
  openapi: '3.1.1',
  info: { title: 'Billing', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  security: [{ bearer: [] }],
  paths: {
    '/users/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: 'Get a user',
        parameters: [{ $ref: '#/components/parameters/Expand' }],
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
  components: {
    parameters: { Expand: { name: 'expand', in: 'query', schema: { type: 'array', items: { type: 'string' } } } },
    responses: { NotFound: { description: 'No such user' } },
    schemas: {
      User: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['admin', 'member'] },
          manager: { $ref: '#/components/schemas/User' },
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
        },
      },
      Tag: { type: 'object', properties: { name: { type: 'string' } } },
    },
  },
}

const op = (o: Partial<ApiOperationInfo>): ApiOperationInfo => ({
  documentId: 'd',
  revisionId: 'r',
  protocol: 'http',
  method: 'GET',
  path: '/users/{id}',
  operationId: null,
  entityKey: 'op:billing:get-/users/{}',
  summary: null,
  tags: [],
  deprecated: false,
  pointer: '/paths/~1users~1{id}/get',
  ...o,
})

describe('api-spec reading', () => {
  it('resolves pointers and refs, and stops at a cycle', () => {
    expect(resolvePointer(doc, '/paths/~1users~1{id}/get/summary')).toBe('Get a user')
    expect(deref(doc, { $ref: '#/components/schemas/Tag' }).ref).toBe('#/components/schemas/Tag')
    expect(deref(doc, { $ref: '#/components/schemas/User' }, ['#/components/schemas/User']).cycle).toBe(true)
    expect(deref(doc, { $ref: 'https://x/y.json' }).node).toBeNull()
  })

  it('reads an operation with inherited path params, ref params and ref responses', () => {
    const v = operationView(doc, op({}))!
    expect(v.parameters.map((p) => `${p.in}:${p.name}:${p.type}`)).toEqual(['path:id:string', 'query:expand:array<string>'])
    expect(v.responses.map((r) => [r.status, r.description])).toEqual([
      ['200', 'ok'],
      ['404', 'No such user'],
    ])
    expect(v.security).toEqual(['bearer'])
  })

  it('builds a schema tree that marks recursion instead of following it', () => {
    const tree = schemaTree(doc, { $ref: '#/components/schemas/User' })
    expect(tree.map((n) => n.name)).toEqual(['id', 'role', 'manager', 'tags'])
    expect(tree[0]).toMatchObject({ type: 'string<uuid>', required: true })
    expect(tree[1].enumValues).toEqual(['admin', 'member'])
    expect(tree[2]).toMatchObject({ recursive: true, refName: 'User', children: [] })
    expect(tree[3].type).toBe('array<Tag>')
    expect(tree[3].children.map((n) => n.name)).toEqual(['name'])
  })

  it('labels types', () => {
    expect(typeLabel(doc, { type: ['string', 'null'] })).toBe('string | null')
    expect(typeLabel(doc, { $ref: '#/components/schemas/Tag' })).toBe('Tag')
  })

  it('groups by first tag with untagged last, and reads servers', () => {
    const groups = groupByTag([{ tags: [] }, { tags: ['B'] }, { tags: ['A', 'B'] }])
    expect(groups.map((g) => g.tag)).toEqual(['B', 'A', null])
    expect(serversOf(doc)).toEqual(['https://api.example.com'])
    expect(serversOf({ servers: { prod: { host: 'mq.example.com', protocol: 'amqp' } } })).toEqual(['amqp://mq.example.com'])
  })

  it('reads AsyncAPI 2.x messages off the operation', () => {
    const asyncDoc = {
      asyncapi: '2.6.0',
      channels: { 'user/signedup': { subscribe: { message: { name: 'Signup', payload: { type: 'object' } } } } },
    }
    const v = operationView(asyncDoc, op({ protocol: 'async', method: 'subscribe', path: 'user/signedup', pointer: '/channels/user~1signedup/subscribe' }))!
    expect(v.messages.map((m) => m.name)).toEqual(['Signup'])
  })
})
