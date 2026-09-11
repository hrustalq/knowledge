/**
 * Self-check for the connector setup machines.
 *
 * The repo has no web test runner and deliberately verifies through `make check`
 * plus the end-to-end flow, so this is a plain assert script rather than a suite
 * that would drag in a framework for one file:
 *
 *     node --experimental-strip-types \
 *       apps/web/src/components/connectors/setup-machines.check.ts
 *
 * It covers the three things that would silently break the dialog: the spine
 * reaching `done`, a failed test not stranding the flow, and a persisted
 * snapshot restoring mid-configure with the child's sub-step intact.
 */
import assert from 'node:assert/strict'
import { canWalkTree, createSetupActor, kindSteps, stepIndex, stepLabels } from './setup-machines.ts'

const services = {
  test: async () => ({ ok: true, detail: 'Engineering (ENG)' }),
  save: async () => 'connector-1',
}

const input = { kind: 'confluence' as const }

function childState(snapshot: { children: Record<string, unknown> }): string | null {
  const child = snapshot.children.kind as { getSnapshot?: () => { value: string } } | undefined
  return child?.getSnapshot?.().value ?? null
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// --- the happy spine ------------------------------------------------------
{
  const actor = createSetupActor('confluence', input, services)
  actor.start()

  assert.equal(actor.getSnapshot().value, 'naming')
  // A nameless connector cannot advance: the guard, not the button, decides.
  actor.send({ type: 'NEXT' })
  assert.equal(actor.getSnapshot().value, 'naming', 'hasName guard must hold')

  actor.send({ type: 'SET', patch: { name: 'Product wiki' } })
  actor.send({ type: 'NEXT' })
  assert.equal(actor.getSnapshot().value, 'configuring')
  assert.equal(childState(actor.getSnapshot() as never), 'site')

  actor.send({ type: 'SET_FIELD', key: 'baseUrl', value: 'https://acme.atlassian.net/wiki' })
  actor.send({ type: 'SET', patch: { credential: 'a@b.c:token' } })
  actor.send({ type: 'NEXT' })
  assert.equal(childState(actor.getSnapshot() as never), 'space', 'child owns its sub-steps')

  actor.send({ type: 'SET_FIELD', key: 'spaceKey', value: 'ENG' })
  // The subtree question rides along with the space rather than taking a step.
  actor.send({ type: 'SET_FIELD', key: 'rootPageId', value: '123456' })
  actor.send({ type: 'NEXT' })
  // The child reaching its final state is what advances the wrapper.
  await settle()
  assert.equal(actor.getSnapshot().value, 'destination', 'test resolves into destination')
  assert.equal(actor.getSnapshot().context.testDetail, 'Engineering (ENG)')

  actor.send({ type: 'NEXT' })
  assert.equal(actor.getSnapshot().value, 'destination', 'hasDestination guard must hold')

  actor.send({ type: 'SET', patch: { projectId: 'p1' } })
  actor.send({ type: 'NEXT' })
  assert.equal(actor.getSnapshot().value, 'options')

  // docs/features/26: a tree-walking kind is *offered* staging, and the space's
  // optional subtree answer is carried as ordinary config.
  assert.equal(actor.getSnapshot().context.syncMode, 'review')
  assert.equal(actor.getSnapshot().context.preserveHierarchy, true)
  assert.equal(actor.getSnapshot().context.config.rootPageId, '123456')

  actor.send({ type: 'SUBMIT' })
  await settle()
  assert.equal(actor.getSnapshot().value, 'done')
  assert.equal(actor.getSnapshot().context.connectorId, 'connector-1')
}

// --- staging defaults follow the capability, not the kind name ------------
{
  // A flat-list adapter has no tree to preserve and is left exactly as it
  // behaved before the feature: the column defaults, unchanged.
  assert.equal(canWalkTree('notion'), false)
  const flat = createSetupActor('notion', { kind: 'notion' }, services)
  flat.start()
  assert.equal(flat.getSnapshot().context.syncMode, 'auto')
  assert.equal(flat.getSnapshot().context.preserveHierarchy, false)

  assert.equal(canWalkTree('confluence-server'), true)
  const tree = createSetupActor('confluence-server', { kind: 'confluence-server' }, services)
  tree.start()
  assert.equal(tree.getSnapshot().context.syncMode, 'review')

  // An existing connector keeps what it was saved with — the offer is for new
  // ones only, or editing a connector would silently re-shape its next run.
  const editing = createSetupActor(
    'confluence',
    { kind: 'confluence', editingId: 'c1', syncMode: 'auto' as const, preserveHierarchy: false },
    services,
  )
  editing.start()
  assert.equal(editing.getSnapshot().context.syncMode, 'auto', 'editing must not re-offer review')
  assert.equal(editing.getSnapshot().context.preserveHierarchy, false)
}

// --- Back, in every position it can be pressed ----------------------------
{
  const actor = createSetupActor('confluence', input, services)
  actor.start()
  actor.send({ type: 'SET', patch: { name: 'Wiki' } })
  actor.send({ type: 'NEXT' })
  assert.equal(childState(actor.getSnapshot() as never), 'site')

  // Back on the connector's FIRST question leaves the configure step entirely —
  // the child cannot go back, so it says so and the wrapper handles it.
  actor.send({ type: 'BACK' })
  assert.equal(actor.getSnapshot().value, 'naming', 'Back from the first sub-step returns to naming')

  actor.send({ type: 'NEXT' })
  actor.send({ type: 'NEXT' })
  assert.equal(childState(actor.getSnapshot() as never), 'space')

  // Back between sub-steps stays inside the configure step.
  actor.send({ type: 'BACK' })
  assert.equal(actor.getSnapshot().value, 'configuring')
  assert.equal(childState(actor.getSnapshot() as never), 'site')

  // Forward to destination, then back: the child must still be on the question
  // it was on, not reset to the first one.
  actor.send({ type: 'NEXT' })
  actor.send({ type: 'NEXT' })
  await settle()
  assert.equal(actor.getSnapshot().value, 'destination')

  actor.send({ type: 'BACK' })
  assert.equal(actor.getSnapshot().value, 'configuring')
  assert.equal(childState(actor.getSnapshot() as never), 'space', 'Back must not reset the child')

  // And back out of options too.
  actor.send({ type: 'NEXT' })
  await settle()
  actor.send({ type: 'SET', patch: { projectId: 'p1' } })
  actor.send({ type: 'NEXT' })
  assert.equal(actor.getSnapshot().value, 'options')
  actor.send({ type: 'BACK' })
  assert.equal(actor.getSnapshot().value, 'destination')
}

// --- a failed test must offer a way forward, not a dead end ---------------
{
  const actor = createSetupActor('notion', { kind: 'notion' }, {
    test: async () => ({ ok: false, detail: 'API token is invalid' }),
    save: async () => 'connector-2',
  })
  actor.start()
  actor.send({ type: 'SET', patch: { name: 'Notes' } })
  actor.send({ type: 'NEXT' })
  actor.send({ type: 'SET', patch: { credential: 'secret' } })
  actor.send({ type: 'NEXT' })
  await settle()

  assert.equal(actor.getSnapshot().value, 'testFailed')
  assert.equal(actor.getSnapshot().context.error, 'API token is invalid')

  // All three exits exist: fix it, go back, or proceed knowing it failed.
  actor.send({ type: 'SKIP_TEST' })
  assert.equal(actor.getSnapshot().value, 'destination')
  assert.equal(actor.getSnapshot().context.error, null, 'moving on clears the error')
}

// --- resumable: a snapshot restores the child's sub-step too --------------
{
  const first = createSetupActor('markdown-git', { kind: 'markdown-git' }, services)
  first.start()
  first.send({ type: 'SET', patch: { name: 'Runbooks' } })
  first.send({ type: 'NEXT' })
  first.send({ type: 'SET_FIELD', key: 'repoUrl', value: 'https://github.com/acme/runbooks' })
  first.send({ type: 'NEXT' })
  assert.equal(childState(first.getSnapshot() as never), 'location')

  const persisted = first.getPersistedSnapshot()
  // Plain JSON is what makes this syncable, so the round trip is what matters.
  const wire = JSON.parse(JSON.stringify(persisted))

  const restored = createSetupActor('markdown-git', { kind: 'markdown-git' }, services, wire)
  restored.start()
  assert.equal(restored.getSnapshot().value, 'configuring')
  assert.equal(restored.getSnapshot().context.name, 'Runbooks')
  assert.equal(restored.getSnapshot().context.config.repoUrl, 'https://github.com/acme/runbooks')
  assert.equal(childState(restored.getSnapshot() as never), 'location', 'child sub-step must survive')
}

// --- the stepper's arithmetic --------------------------------------------
{
  assert.equal(stepLabels('confluence').length, 6, 'name + site + space + test + destination + options')
  assert.equal(kindSteps('notion').length, 1)
  assert.equal(stepIndex('confluence', 'naming', null), 0)
  assert.equal(stepIndex('confluence', 'configuring', 'space'), 2)
  assert.equal(stepIndex('confluence', 'testFailed', null), 3, 'a failed test sits on the test step')
  assert.equal(stepIndex('confluence', 'options', null), 5)
}

console.log('setup-machines: all checks passed')
