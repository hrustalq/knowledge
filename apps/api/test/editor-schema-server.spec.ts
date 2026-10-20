import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { prosemirrorToYDoc, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { BODY_FIELD, editorSchema, parseMarkdown } from '@knowledge/editor-schema';
import { docToMarkdown } from '@knowledge/editor-schema/serialize';
import { targetRange } from '@knowledge/editor-schema/suggestions';
import {
  readSuggestionEntries,
  removeSuggestionEntries,
  writeSuggestionEntry,
} from '@knowledge/editor-schema/suggestion-entries';

// The editor's markdown serializer, anchor resolver and suggestion codec, run
// where the MCP draft tools will run them (#316): plain Node with jsdom, not the
// browser. The web specs cover the same code under its own environment.
const dom = new JSDOM('').window.document;
const toDoc = (md: string) => parseMarkdown(md, dom);
const toMd = (md: string) => docToMarkdown(toDoc(md), editorSchema, dom);

describe('editor-schema on the server', () => {
  it.each([
    ['tasks', '- [x] done\n- [ ] todo'],
    ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['expand', '<details open>\n<summary>More</summary>\n\nHidden body.\n\n</details>'],
    ['toc', '<div data-kn-toc="1"></div>\n\n## H2'],
    ['status', 'State: <span data-kn-status="green">DONE</span>'],
    ['image', '<img src="/v1/attachments/i1" alt="diagram" width="320" />\n\n![plain](/v1/attachments/i2)'],
  ])('%s: markdown comes back as written', (_name, md) => {
    expect(toMd(md)).toBe(md);
  });

  it('writes the editor spelling, and that spelling is a fixed point', () => {
    const once = toMd('- a\n  - b\n\n> [!warning]\n> Careful **here**.\n');
    expect(once).toBe('-   a\n\n    -   b\n\n\n> [!WARNING]\n> Careful **here**.');
    expect(toMd(once)).toBe(once);
  });

  it('finds an anchor quoted as markdown and widens it to whole blocks', () => {
    const doc = toDoc('First.\n\nThe **owner** is billing.\n\nLast.');
    const second = { from: doc.child(0).nodeSize, to: doc.child(0).nodeSize + doc.child(1).nodeSize };
    expect(targetRange(doc, { op: 'replace', anchor: 'The **owner** is billing.' }, dom)).toEqual(second);
    expect(targetRange(doc, { op: 'insert_after', anchor: 'The **owner**' }, dom)).toEqual({ from: second.to, to: second.to });
    expect(targetRange(doc, { op: 'append', anchor: null }, dom)).toEqual({ from: doc.content.size, to: doc.content.size });
    // Gone from the page: the page's end, where it stays visible and discardable.
    expect(targetRange(doc, { op: 'replace', anchor: 'nowhere at all' }, dom)).toEqual({
      from: doc.content.size,
      to: doc.content.size,
    });
  });

  it('keeps an entry on its blocks while a peer adds one before it', () => {
    const ydoc = prosemirrorToYDoc(toDoc('One.\n\nTwo.\n\nThree.'), BODY_FIELD);
    const credit = { userId: 'u1', name: 'Ada' };
    writeSuggestionEntry(
      ydoc,
      {
        id: 's1',
        fromIndex: 1,
        toIndex: 2,
        original: { content: [] },
        originalText: 'Two.',
        state: 'ready',
        agent: { key: 'mcp', name: 'Claude Code' },
      },
      credit,
    );

    // A peer's edit, arriving over the wire.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    peer.getXmlFragment(BODY_FIELD).insert(0, [new Y.XmlElement('paragraph')]);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));

    const [entry] = readSuggestionEntries(ydoc);
    expect(entry).toMatchObject({
      id: 's1',
      fromIndex: 2,
      toIndex: 3,
      originalText: 'Two.',
      state: 'ready',
      agent: { key: 'mcp', name: 'Claude Code' },
      requestedBy: credit,
      clientId: ydoc.clientID,
    });
    const body = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(BODY_FIELD), editorSchema);
    expect(body.child(entry!.fromIndex).textContent).toBe('Two.');

    removeSuggestionEntries(ydoc, ['s1']);
    expect(readSuggestionEntries(ydoc)).toEqual([]);
  });
});
