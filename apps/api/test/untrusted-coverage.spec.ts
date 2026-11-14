import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1102: page text, titles and comments reach a model only through
 * `wrapUntrusted`, which defuses its own closing tag. A hand-written block
 * (`<page …>`, `<document>`) can be closed by the text it wraps.
 */

const SRC = join(import.meta.dirname, '..', 'src');
const ROOTS = ['assistant', 'agents', 'documents/mention-replies.service.ts', 'memos/triage.ts', 'ai/ai-plugins.service.ts'];
/** An opening content tag written into a string, or opening a template literal's line: `<page title=…>`, `<document>`, … */
const HAND_WRITTEN = /(^\s*|[`'"][^`'"\n]*)<(document|page|pages|attachment|draft|discussion|merge_request|passage_under_discussion|plugin-result)[\s>=]/u;

function files(path: string): string[] {
  const full = join(SRC, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(full, f));
}

describe('untrusted text reaches models through the one wrapper', () => {
  it('no hand-written content block in the assistant, the agents, mention replies, memo triage or plugins', () => {
    const offenders = ROOTS.flatMap(files).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (HAND_WRITTEN.test(line) ? [`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
