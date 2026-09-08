import { describe, expect, it } from 'vitest';
import type { WorkflowGraph, WorkflowStep } from '@knowledge/contracts';
import {
  allowedNodeEvents,
  allowedRunEvents,
  applyRunEvent,
  entrySteps,
  initialRunSnapshot,
  nextNodeStatus,
  validateGraph,
} from '@knowledge/workflow';

const gen: WorkflowStep = {
  id: 'use-cases',
  kind: 'ai.generate',
  title: 'Use cases',
  next: ['api'],
  fanOut: true,
  autoApprove: false,
  prompt: { user: 'x' },
  produces: { category: 'use-case', relationToParent: 'IMPLEMENTS' },
};
const api: WorkflowStep = {
  id: 'api',
  kind: 'ai.draft',
  title: 'API',
  next: [],
  fanOut: false,
  autoApprove: true,
  prompt: { user: 'y' },
  produces: { category: 'api', relationToParent: 'IMPLEMENTS' },
};

describe('node machine', () => {
  it('offers review actions only while awaiting review', () => {
    expect(allowedNodeEvents(gen, 'awaiting-review').sort()).toEqual(['APPROVE', 'REJECT', 'RETRY', 'SKIP']);
    expect(allowedNodeEvents(gen, 'running')).toEqual([]);
    expect(allowedNodeEvents(gen, 'failed').sort()).toEqual(['RETRY', 'SKIP']);
    expect(allowedNodeEvents(gen, 'materialized')).toEqual([]);
  });

  it('routes auto-approved steps straight past the gate', () => {
    expect(nextNodeStatus(api, 'running', { type: 'DONE' })).toBe('materializing');
    expect(nextNodeStatus(gen, 'running', { type: 'DONE' })).toBe('awaiting-review');
  });

  it('materialises on approve when the step produces a page', () => {
    expect(nextNodeStatus(gen, 'awaiting-review', { type: 'APPROVE' })).toBe('materializing');
    const noProduce: WorkflowStep = { ...gen, produces: undefined };
    expect(nextNodeStatus(noProduce, 'awaiting-review', { type: 'APPROVE' })).toBe('approved');
  });

  it('refuses an illegal transition', () => {
    expect(() => nextNodeStatus(gen, 'materialized', { type: 'APPROVE' })).toThrow(/Cannot APPROVE/);
  });
});

describe('run machine', () => {
  it('round-trips through a persisted snapshot', () => {
    const started = applyRunEvent('pending', { type: 'START' });
    expect(started.status).toBe('running');

    const parked = applyRunEvent('running', { type: 'PARK' }, { snapshot: started.snapshot });
    expect(parked.status).toBe('awaiting-review');

    // The snapshot must survive the JSON round trip it makes through Postgres.
    const stored = JSON.parse(JSON.stringify(parked.snapshot));
    const resumed = applyRunEvent('awaiting-review', { type: 'RESUME' }, { snapshot: stored });
    expect(resumed.status).toBe('running');
  });

  it('recovers from a status column when no snapshot survives', () => {
    const resumed = applyRunEvent('awaiting-review', { type: 'RESUME' }, { snapshot: { bogus: true } });
    expect(resumed.status).toBe('running');
  });

  it('serialises its initial snapshot', () => {
    expect(() => JSON.stringify(initialRunSnapshot())).not.toThrow();
  });

  it('offers pause and cancel while running', () => {
    expect(allowedRunEvents('running').sort()).toEqual(['CANCEL', 'PAUSE']);
    expect(allowedRunEvents('completed')).toEqual([]);
  });
});

describe('definition validation', () => {
  it('accepts the entity → use-case → api chain', () => {
    const graph: WorkflowGraph = { steps: [gen, api] };
    expect(validateGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
    expect(entrySteps(graph).map((s) => s.id)).toEqual(['use-cases']);
  });

  it('rejects a cycle and a dangling edge', () => {
    const cyclic: WorkflowGraph = { steps: [gen, { ...api, next: ['use-cases'] }] };
    expect(validateGraph(cyclic).some((i) => i.severity === 'error' && /cycle/.test(i.message))).toBe(true);

    const dangling: WorkflowGraph = { steps: [{ ...gen, next: ['nope'] }] };
    expect(validateGraph(dangling).some((i) => /does not exist/.test(i.message))).toBe(true);
  });
});
