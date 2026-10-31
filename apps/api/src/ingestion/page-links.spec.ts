import { describe, expect, it } from 'vitest';
import { pageLinkTargets } from './page-links.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SELF = '33333333-3333-4333-8333-333333333333';
const WEB = 'https://kb.example.com';

describe('pageLinkTargets', () => {
  it('reads relative and same-origin links with their anchors, once each', () => {
    const md = [
      `See [install](/documents/${A}#install) and [again](/documents/${A}#install).`,
      `- [whole page](https://kb.example.com/documents/${A})`,
      `| [B](/documents/${B.toUpperCase()}#Getting%20started) |`,
      '|---|',
    ].join('\n');
    expect(pageLinkTargets(md, WEB, SELF)).toEqual([
      { targetDocumentId: A, targetAnchor: 'install' },
      { targetDocumentId: A, targetAnchor: null },
      { targetDocumentId: B, targetAnchor: 'Getting started' },
    ]);
  });

  it('ignores other origins, code, images, sub-routes and self-links', () => {
    const md = [
      `[other](https://evil.example.com/documents/${A})`,
      `[proto](//evil.example.com/documents/${A})`,
      `\`[code](/documents/${A})\``,
      '```',
      `[fenced](/documents/${A})`,
      '```',
      `![img](/documents/${A})`,
      `[edit](/documents/${A}/edit)`,
      `[me](/documents/${SELF}#top)`,
    ].join('\n');
    expect(pageLinkTargets(md, WEB, SELF)).toEqual([]);
  });
});
