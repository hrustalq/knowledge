import { describe, expect, it } from 'vitest';
import {
  issueRankFor,
  issueRuleAdmits,
  parseWorkItemRef,
  workItemRefFooter,
  workItemStateFor,
  workItemStatusFor,
  workItemStatusMap,
} from '@knowledge/contracts';

/**
 * Tracker handoff vocabulary (#424). The derived status is what every surface
 * shows and every outbound transition is computed from, so a row written
 * before the milestone — no raw status at all — must read exactly as it did.
 */
describe('workItemStatusFor', () => {
  const github = workItemStatusMap('github');

  it('reads a pre-#424 row from its coarse state alone', () => {
    expect(workItemStatusFor({ state: 'open', externalStatus: null }, github)).toBe('open');
    expect(workItemStatusFor({ state: 'closed', externalStatus: null }, github)).toBe('done');
    expect(workItemStatusFor({ state: 'merged', externalStatus: null }, github)).toBe('done');
    expect(workItemStatusFor({ state: 'draft', externalStatus: null }, github)).toBe('in_progress');
  });

  it('prefers the raw status when the map knows it', () => {
    expect(workItemStatusFor({ state: 'closed', externalStatus: 'not_planned' }, github)).toBe('wont_do');
  });

  it('matches Jira names case-insensitively and layers overrides over the default', () => {
    const jira = workItemStatusMap('jira', { inbound: { 'In Review': 'in_progress', Bogus: 'nope' as never } });
    expect(workItemStatusFor({ state: 'open', externalStatus: 'IN PROGRESS' }, jira)).toBe('in_progress');
    expect(workItemStatusFor({ state: 'open', externalStatus: 'in review' }, jira)).toBe('in_progress');
    expect(jira.inbound.bogus).toBeUndefined();
    expect(jira.outbound.done).toBe('Done');
  });

  it('projects a status back onto the coarse state', () => {
    expect(workItemStateFor('wont_do')).toBe('closed');
    expect(workItemStateFor('in_progress')).toBe('open');
  });
});

describe('issue rules', () => {
  it('admits by rank, with null and off admitting nothing', () => {
    const low = issueRankFor({ kind: 'other', reportCount: 1 });
    const high = issueRankFor({ kind: 'wrong', reportCount: 1 });
    expect([low, high, issueRankFor({ kind: 'stale', reportCount: 1 })]).toEqual(['low', 'high', 'medium']);
    expect(issueRuleAdmits(null, high)).toBe(false);
    expect(issueRuleAdmits('off', high)).toBe(false);
    expect(issueRuleAdmits('high', 'medium')).toBe(false);
    expect(issueRuleAdmits('medium', 'medium')).toBe(true);
    expect(issueRuleAdmits('all', low)).toBe(true);
  });
});

describe('knowledge-ref footer', () => {
  it('round-trips and ignores anything else', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const body = `Stale page\nhttps://x/doc\n${workItemRefFooter('conflict', id)}`;
    expect(parseWorkItemRef(body)).toEqual({ kind: 'conflict', id });
    expect(parseWorkItemRef('knowledge-ref: page:abc')).toBeNull();
    expect(parseWorkItemRef(null)).toBeNull();
  });
});
