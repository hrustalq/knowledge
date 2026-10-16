import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en/capture.json' with { type: 'json' };
import ru from '../src/i18n/ru/capture.json' with { type: 'json' };
import {
  appendCaptureSection,
  CAPTURE_HEADING_KEYS,
  capturedEntry,
  describeSession,
  renderCaptureBody,
  withCapturedEntry,
  type CaptureHeadings,
} from '../src/captures/capture-templates.js';
import { composeFrontmatter, parseMarkdown } from '../src/common/frontmatter.js';

/**
 * Page text from a capture (issue #73): a fixed template per kind, in the
 * writer's language, appended to an existing page without disturbing its
 * frontmatter, and carrying where it came from — never what the session said.
 */

function headings(catalogue: typeof en, title: string): CaptureHeadings {
  const h = Object.fromEntries(CAPTURE_HEADING_KEYS.map((k) => [k, catalogue.heading[k]]));
  return { ...h, captured: catalogue.heading.captured.replace('{title}', title) } as CaptureHeadings;
}

function keysOf(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k));
}

const decision = {
  kind: 'decision' as const,
  payload: {
    context: 'Vector and BM25 scores are not comparable.',
    decision: 'Fuse the two rankings with RRF, k=60.',
    alternatives: ['Weighted sum of scores', 'BM25 only'],
  },
  related: [{ documentId: 'd-1', title: 'Search [hybrid]' }],
};

describe('capture catalogues', () => {
  it('say the same things in en and ru', () => {
    expect(keysOf(ru).sort()).toEqual(keysOf(en).sort());
  });
});

describe('renderCaptureBody', () => {
  it('renders a decision as fixed sections in order, skipping what was not given', () => {
    const body = renderCaptureBody(decision, headings(en, 'x'));
    expect(body).toBe(
      [
        '## Context\n\nVector and BM25 scores are not comparable.',
        '## Decision\n\nFuse the two rankings with RRF, k=60.',
        '## Alternatives considered\n\n- Weighted sum of scores\n- BM25 only',
        '## Related pages\n\n- [Search \\[hybrid\\]](/documents/d-1)',
      ].join('\n\n'),
    );
  });

  it('renders the same capture in Russian from the ru catalogue', () => {
    const body = renderCaptureBody(decision, headings(ru, 'x'));
    expect(body).toContain('## Контекст');
    expect(body).toContain('## Рассмотренные альтернативы');
    expect(body).not.toContain('## Context');
  });

  it('puts a note body first and its paths as code', () => {
    const body = renderCaptureBody(
      { kind: 'gotcha', payload: { body: 'rtk grep can report no match for text that is there.', appliesTo: ['apps/api/`x`.ts'] } },
      headings(en, 'x'),
    );
    expect(body).toBe('rtk grep can report no match for text that is there.\n\n## Applies to\n\n- `apps/api/x.ts`');
  });

  it('renders an answer with its sources', () => {
    const body = renderCaptureBody(
      { kind: 'answer', payload: { question: 'How do we deploy?', answer: 'Tag a release.', citedDocumentIds: ['d-2'] }, cited: [{ documentId: 'd-2', title: 'Deploy' }] },
      headings(en, 'x'),
    );
    expect(body).toBe('## Question\n\nHow do we deploy?\n\n## Answer\n\nTag a release.\n\n## Sources\n\n- [Deploy](/documents/d-2)');
  });
});

describe('amending a page', () => {
  it('appends one section and keeps every frontmatter key, adding the captured entry', () => {
    const h = headings(en, 'Fuse with RRF');
    const page = composeFrontmatter('# Search\n\nHow search works.\n', { tags: ['search'], owner: 'team-a' });
    const { data, body } = parseMarkdown(page);
    const entry = capturedEntry(
      'cap-1',
      'decision',
      { client: 'claude-code', sessionId: 's-1', repo: 'acme/kb', commit: 'abc123', files: ['src/a.ts'] },
      new Date('2026-10-16T08:00:00Z'),
    );
    const next = parseMarkdown(
      composeFrontmatter(appendCaptureSection(body, renderCaptureBody(decision, h, 3), h), withCapturedEntry(data, entry)),
    );
    expect(next.body).toMatch(/^# Search\n\nHow search works\.\n\n## Captured: Fuse with RRF\n\n### Context\n/);
    expect(next.data).toEqual({
      tags: ['search'],
      owner: 'team-a',
      captured: [{ id: 'cap-1', kind: 'decision', client: 'claude-code', sessionId: 's-1', repo: 'acme/kb', commit: 'abc123', at: '2026-10-16T08:00:00.000Z' }],
    });
    // Where it came from, never what the session touched or said.
    expect(JSON.stringify(next.data)).not.toContain('src/a.ts');
  });

  it('keeps a captured value a person typed as the first entry rather than losing it', () => {
    const entry = capturedEntry('cap-2', 'gotcha', { client: 'cursor' }, new Date(0));
    expect(withCapturedEntry({ captured: 'by hand' }, entry).captured).toEqual(['by hand', entry]);
  });
});

describe('describeSession', () => {
  it('names the client and where, briefly', () => {
    expect(describeSession({ client: 'claude-code', repo: 'acme/kb', commit: '0123456789abcdef', branch: 'feat/x' })).toBe(
      'claude-code · acme/kb@0123456789ab · (feat/x)',
    );
    expect(describeSession({ client: 'other' })).toBe('other');
  });
});
