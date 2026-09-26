import { describe, expect, it } from 'vitest';
import { DRAFT_EDIT_OPS } from '@knowledge/contracts';
import { applyDraftEdit, locateAnchor, refuseDraftEdit } from '../src/assistant/draft-edits.js';

const draft = '# Title\n\nFirst paragraph here.\n\nSecond paragraph,\nwrapped.\n\n- one\n- two\n';

describe('locateAnchor', () => {
  it('finds an exact quote', () => {
    const got = locateAnchor(draft, 'First paragraph');
    expect(got).toMatchObject({ ok: true, start: draft.indexOf('First') });
  });

  it('tolerates a line break quoted as a space', () => {
    expect(locateAnchor(draft, 'Second paragraph, wrapped.')).toMatchObject({ ok: true });
  });

  it('refuses a quote that is missing or repeated', () => {
    expect(locateAnchor(draft, 'Third')).toMatchObject({ ok: false, reason: 'missing' });
    expect(locateAnchor(draft, 'paragraph')).toMatchObject({ ok: false, reason: 'ambiguous', count: 2 });
  });
});

describe('applyDraftEdit', () => {
  it('replaces the whole block the anchor falls in', () => {
    const next = applyDraftEdit(draft, { op: 'replace', anchor: 'First paragraph', markdown: 'Rewritten.' });
    expect(next).toBe('# Title\n\nRewritten.\n\nSecond paragraph,\nwrapped.\n\n- one\n- two\n');
  });

  it('inserts beside a block', () => {
    expect(applyDraftEdit(draft, { op: 'insert_after', anchor: '# Title', markdown: 'Intro.' })).toContain(
      '# Title\n\nIntro.\n\nFirst paragraph',
    );
    expect(applyDraftEdit(draft, { op: 'insert_before', anchor: '- one', markdown: 'List:' })).toContain(
      'wrapped.\n\nList:\n\n- one',
    );
  });

  it('deletes a block on an empty replacement', () => {
    const next = applyDraftEdit(draft, { op: 'replace', anchor: 'First paragraph', markdown: '' });
    expect(next).toBe('# Title\n\nSecond paragraph,\nwrapped.\n\n- one\n- two\n');
  });

  it('appends and rewrites without an anchor', () => {
    expect(applyDraftEdit(draft, { op: 'append', anchor: null, markdown: 'End.' })).toMatch(/- two\n\nEnd\.\n$/);
    expect(applyDraftEdit(draft, { op: 'rewrite', anchor: null, markdown: 'All new.' })).toBe('All new.');
  });
});

describe('refuseDraftEdit', () => {
  it('explains what the model has to fix', () => {
    expect(refuseDraftEdit(draft, { op: 'shuffle', anchor: null, markdown: 'x' }, DRAFT_EDIT_OPS)).toMatch(/op must/);
    expect(refuseDraftEdit(draft, { op: 'replace', anchor: null, markdown: 'x' }, DRAFT_EDIT_OPS)).toMatch(/anchor/);
    expect(refuseDraftEdit(draft, { op: 'replace', anchor: 'paragraph', markdown: 'x' }, DRAFT_EDIT_OPS)).toMatch(/2 times/);
    expect(refuseDraftEdit(draft, { op: 'append', anchor: null, markdown: 'x' }, DRAFT_EDIT_OPS)).toBeNull();
  });
});
