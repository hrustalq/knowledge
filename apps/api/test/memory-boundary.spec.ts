import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Memory is not authoritative knowledge (#1162). No retain, consolidation, reflect, mental-model or
 * transfer path writes a page, a revision or a merge request: generated memory stays in its bank. The
 * one road out is promote — a person's act on the bank page — and it goes through capture, so it
 * lands as a merge request someone reviews. This pins that by source: a new memory file that reaches
 * for the documents, revisions or merge requests fails here before it can ship.
 */
const DIR = join(import.meta.dirname, '..', 'src', 'memory');

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a page, revision or merge-request write', /\.(document|documentRevision|mergeRequest|revisionParent)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/],
  ['the documents module', /from '\.\.\/documents\//],
  ['the merge-requests module', /from '\.\.\/merge-requests\//],
  ['a revision writer', /\b(createDocument|createDraftRevision|internalWrite)\(/],
  ['the capture door', /from '\.\.\/captures\//],
];

/** Promote is the explicit, person-initiated export, API-only: the bank page's service and the module that wires it. */
const ALLOWED: Record<string, string[]> = {
  'the capture door': ['memory-web.service.ts', 'memory.module.ts'],
};

describe('memory never writes authoritative knowledge (#1162)', () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith('.ts'));

  it('reads the memory sources', () => {
    expect(files).toEqual(expect.arrayContaining(['memory-runtime.service.ts', 'memory-consolidation.service.ts', 'memory-reflect.service.ts', 'memory-mental-models.service.ts', 'memory-management.service.ts']));
  });

  it('no memory path writes a page, a revision or a merge request; only promote reaches capture', () => {
    const found: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(DIR, name), 'utf8');
      for (const [what, pattern] of FORBIDDEN) if (pattern.test(source) && !ALLOWED[what]?.includes(name)) found.push(`${name}: ${what}`);
    }
    expect(found).toEqual([]);
  });
});
