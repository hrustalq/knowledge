import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { BODY_FIELD, editorSchema } from '@knowledge/editor-schema';
import { docToMarkdown } from '@knowledge/editor-schema/serialize';
import { withoutSuggestions } from '@knowledge/editor-schema/suggestions';
import { readSuggestionEntries } from '@knowledge/editor-schema/suggestion-entries';
import type { Principal } from '../src/auth/principal.js';
import { CollabDraftToolsService, overlaps } from '../src/collab/collab-draft-tools.service.js';
import { serverDocument, seedState } from '../src/collab/collab-drafts.service.js';

// The MCP draft tools' half in the API (#316): what a suggestion writes into
// the draft, what is refused, and what a read returns. The gateway is faked
// down to one Y.Doc; the editor-schema code is real.
const WS = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const caller = {
  userId: '44444444-4444-4444-8444-444444444444',
  displayName: 'Ada',
  apiKey: { id: 'key-1', scope: 'write', workspaceId: null },
} as Principal;

function setup(markdown = 'First.\n\nThe **owner** is billing.\n\nLast.') {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, seedState(markdown, { texts: { title: 'Billing', tags: 'ops', message: '' }, values: { category: 'guide', parentId: '', projectId: 'p', relations: [] } }).state);
  const gateway = {
    hocuspocus: {},
    peersOf: () => 1,
    loadedDraft: () => doc,
    writeDraft: vi.fn(async (_ws: string, _doc: string, _branch: string, run: (d: Y.Doc) => unknown) => {
      let out: unknown;
      doc.transact(() => {
        out = run(doc);
      });
      return out;
    }),
  };
  const prisma = {
    document: { findUniqueOrThrow: vi.fn(async () => ({ workspaceId: WS, defaultBranch: 'main' })) },
    documentBranch: {
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        where.name === 'main' ? { id: BRANCH, name: 'main', headRevisionId: 'rev-2' } : null,
      ),
    },
    apiKey: { findUnique: vi.fn(async () => ({ name: 'Claude Code' })) },
  };
  const drafts = {
    list: vi.fn(async () => [{ draftId: 'draft-1', branchId: BRANCH, baseRevisionId: 'rev-1', hasUnpublishedChanges: true, activePeers: 1 }]),
  };
  const tools = new CollabDraftToolsService(prisma as never, drafts as never, gateway as never);
  const body = () => yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(BODY_FIELD), editorSchema);
  const text = () => docToMarkdown(body(), editorSchema, serverDocument());
  const published = () => docToMarkdown(withoutSuggestions(body(), readSuggestionEntries(doc)), editorSchema, serverDocument());
  return { doc, tools, gateway, drafts, prisma, text, published };
}

describe('CollabDraftToolsService', () => {
  it('replaces the anchored block with a suggestion credited to the key for its person', async () => {
    const { doc, tools, text, published } = setup();
    const { suggestionId } = await tools.suggest(caller, DOC, undefined, {
      op: 'replace',
      anchor: 'The **owner** is billing.',
      markdown: 'The **owner** is payments.',
    });
    // Every peer sees the suggested text in the body…
    expect(text()).toBe('First.\n\nThe **owner** is payments.\n\nLast.');
    // …and a publish still writes what was there.
    expect(published()).toBe('First.\n\nThe **owner** is billing.\n\nLast.');
    expect(readSuggestionEntries(doc)).toEqual([
      expect.objectContaining({
        id: suggestionId,
        fromIndex: 1,
        toIndex: 2,
        originalText: 'The owner is billing.',
        state: 'ready',
        agent: { key: 'mcp', name: 'Claude Code' },
        requestedBy: { userId: caller.userId, name: 'Ada' },
      }),
    ]);
  });

  it.each([
    ['insert_after', 'First.', 'First.\n\nNew.\n\nThe **owner** is billing.\n\nLast.'],
    ['insert_before', 'Last.', 'First.\n\nThe **owner** is billing.\n\nNew.\n\nLast.'],
    ['append', undefined, 'First.\n\nThe **owner** is billing.\n\nLast.\n\nNew.'],
    ['rewrite', undefined, 'New.'],
  ] as const)('%s lands where the editor would put it, and is left out of a publish', async (op, anchor, expected) => {
    const { tools, text, published } = setup();
    await tools.suggest(caller, DOC, undefined, { op, anchor: anchor ?? null, markdown: 'New.' });
    expect(text()).toBe(expected);
    expect(published()).toBe('First.\n\nThe **owner** is billing.\n\nLast.');
  });

  it("refuses for the assistant's reasons, and for an edit inside a pending suggestion, writing nothing", async () => {
    const { doc, tools, text } = setup('Same.\n\nSame.\n\nOther.');
    const before = text();
    const refused = (edit: Parameters<CollabDraftToolsService['suggest']>[3]) => tools.suggest(caller, DOC, undefined, edit);
    await expect(refused({ op: 'replace', anchor: 'Nowhere.', markdown: 'x' })).rejects.toThrow(/not found/);
    await expect(refused({ op: 'replace', anchor: 'Same.', markdown: 'x' })).rejects.toThrow(/appears 2 times/);
    await expect(refused({ op: 'insert_after', anchor: null, markdown: 'x' })).rejects.toThrow(/needs an anchor/);
    expect(text()).toBe(before);

    await tools.suggest(caller, DOC, undefined, { op: 'replace', anchor: 'Other.', markdown: 'One.\n\nTwo.' });
    await expect(refused({ op: 'rewrite', anchor: null, markdown: 'All new.' })).rejects.toThrow(/waiting for a decision/);
    expect(readSuggestionEntries(doc)).toHaveLength(1);
  });

  it('reads the draft as a publish would write it, with the suggestions waiting beside it', async () => {
    const { tools } = setup();
    await tools.suggest(caller, DOC, undefined, { op: 'append', anchor: null, markdown: 'Appendix.' });
    const view = await tools.read(DOC, undefined);
    expect(view).toMatchObject({
      branch: 'main',
      draftId: 'draft-1',
      baseRevisionId: 'rev-1',
      headRevisionId: 'rev-2',
      headMoved: true,
      unpublished: true,
      editing: 1,
      title: 'Billing',
      category: 'guide',
      tags: 'ops',
      markdown: 'First.\n\nThe **owner** is billing.\n\nLast.',
      suggestions: [{ agent: 'Claude Code', requestedBy: 'Ada', state: 'ready', markdown: 'Appendix.', replaces: '' }],
    });
  });

  it('reads nothing into being: no draft on the branch is null, an unknown branch is refused', async () => {
    const { tools, drafts, gateway } = setup();
    drafts.list.mockResolvedValueOnce([]);
    expect(await tools.read(DOC, undefined)).toBeNull();
    expect(gateway.writeDraft).not.toHaveBeenCalled();
    await expect(tools.read(DOC, 'nope')).rejects.toThrow(/branchNotFound/);
  });

  it('names a suggestion by its blocks: touching one is not reaching into it', () => {
    const pending = { fromIndex: 2, toIndex: 4 };
    expect(overlaps(2, 2, pending)).toBe(false); // insert just before
    expect(overlaps(4, 4, pending)).toBe(false); // insert just after
    expect(overlaps(3, 3, pending)).toBe(true);
    expect(overlaps(4, 5, pending)).toBe(false);
    expect(overlaps(3, 5, pending)).toBe(true);
    expect(overlaps(0, 6, { fromIndex: 3, toIndex: 3 })).toBe(true); // over a pending deletion
  });
});
