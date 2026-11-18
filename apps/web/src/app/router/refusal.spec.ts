import { describe, expect, it } from 'vitest'
import type { WorkspaceAction } from '@knowledge/contracts'
import { createRouter, refusal } from './index'

// #1299: an admin-only route refuses at the router, from the API's answer.
const router = createRouter()
const auth = { verificationPending: false } as Parameters<typeof refusal>[1]
const features = { isOn: () => true, purposeAsked: true } as unknown as Parameters<typeof refusal>[2]
const as = (...held: WorkspaceAction[]) =>
  ({ allows: (a: WorkspaceAction) => held.includes(a) }) as unknown as Parameters<typeof refusal>[3]

describe('refusal', () => {
  it('sends a member without workspace:admin from an admin-only settings page to /403', () => {
    for (const path of ['/settings/security', '/settings/features', '/settings/editing', '/settings/chat', '/analytics']) {
      expect(refusal(router.resolve(path), auth, features, as('workspace:view', 'workspace:contribute')), path).toEqual({ path: '/403' })
      expect(refusal(router.resolve(path), auth, features, as('workspace:admin')), path).toBeNull()
    }
  })

  it('leaves a page every member reads open', () => {
    for (const path of ['/settings/ai', '/settings/connectors', '/settings/publishing', '/settings/general']) {
      expect(refusal(router.resolve(path), auth, features, as('workspace:view')), path).toBeNull()
    }
  })
})
