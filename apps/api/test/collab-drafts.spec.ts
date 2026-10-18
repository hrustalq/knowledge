import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { collabDocName, collabToken, parseCollabDocName, parseCollabToken } from '@knowledge/contracts';
import { editorSchema, parseMarkdown } from '@knowledge/editor-schema';
import { META_FIELD, pageMetaOf, seedPageMeta } from '@knowledge/editor-schema/page-fields';
import {
  BODY_FIELD,
  CollabDraftTooLargeError,
  CollabDraftsService,
  generationOf,
  sameSnapshot,
  seedState,
  snapshotOf,
} from '../src/collab/collab-drafts.service.js';
import { CollabCheckpointSweeper, checkpointKey } from '../src/collab/collab-checkpoint.sweeper.js';

/** One of every custom node the seed has to carry (doc 56's fixture corpus, condensed). */
const PAGE = `# Title

Para with **bold**, ==hi== and <span data-kn-status="green">DONE</span>.

> [!warning]
> Careful **here**.

<details open>
<summary>More</summary>

Hidden body.

</details>

- [x] done
- [ ] todo

| a | b |
| --- | --- |
| 1 | 2 |

<div data-kn-api="POST" data-kn-path="/invoices/{id}">

### POST /invoices/{id}

<div data-kn-api-section="summary">

Bills a customer.

</div>

</div>

\`\`\`mermaid
graph TD; A-->B
\`\`\`

Ask <span data-kn-user="00000000-0000-4000-8000-000000000001">@Ada</span> and <span data-kn-agent="reviewer">@Reviewer</span>.
`;

const dom = new JSDOM('').window.document;

function load(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

function body(state: Uint8Array) {
  return yXmlFragmentToProseMirrorRootNode(load(state).getXmlFragment(BODY_FIELD), editorSchema);
}

describe('collab drafts (#80 phases 1 and 4)', () => {
  it('seeds the body exactly as the editor opens the page', () => {
    const seeded = body(seedState(PAGE).state);
    expect(seeded.eq(parseMarkdown(PAGE, dom))).toBe(true);
    const types = new Set<string>();
    seeded.descendants((n) => void types.add(n.type.name));
    for (const t of ['knPanel', 'knExpand', 'taskList', 'table', 'knApi', 'knMermaid', 'knUserMention', 'knAgentMention']) {
      expect(types).toContain(t);
    }
  });

  it('seeds a branch with no head as an empty page', () => {
    expect(body(seedState('').state).eq(parseMarkdown('', dom))).toBe(true);
  });

  it('refuses a store over COLLAB_MAX_DOC_BYTES without writing', async () => {
    const prisma = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const drafts = new CollabDraftsService({ get: () => 10 } as never, prisma as never, {} as never);
    const row = { id: 'r', resetAt: null };
    const snapshot = new Uint8Array();
    await expect(drafts.store(row, { state: new Uint8Array(11), snapshot, userId: 'u' })).rejects.toBeInstanceOf(CollabDraftTooLargeError);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(await drafts.store(row, { state: new Uint8Array(10), snapshot, userId: 'u' })).toBe(true);
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('reports a store against a reset or dropped row as refused', async () => {
    const prisma = { $executeRaw: vi.fn().mockResolvedValue(0) };
    const drafts = new CollabDraftsService({ get: () => 100 } as never, prisma as never, {} as never);
    expect(await drafts.store({ id: 'r', resetAt: new Date() }, { state: new Uint8Array(1), snapshot: new Uint8Array() })).toBe(false);
  });

  it('seeds the page fields the way the editor loads them, so opening writes nothing', () => {
    const fields = pageMetaOf(
      { title: 'Billing', category: 'guide', parentId: null, projectId: 'p1' },
      { tags: ['a', 'b'], relations: [{ type: 'DEPENDS_ON', target: 'service:billing' }] },
    );
    const doc = load(seedState('# Hi', fields).state);
    const meta = doc.getMap<unknown>(META_FIELD);
    expect(String(meta.get('title'))).toBe('Billing');
    expect(String(meta.get('tags'))).toBe('a, b');
    expect(String(meta.get('message'))).toBe('');
    expect(meta.get('parentId')).toBe('');
    expect(meta.get('relations')).toEqual([{ type: 'DEPENDS_ON', key: 'service:billing', name: '' }]);
    // The editor's own seed finds every key present and writes nothing.
    const before = snapshotOf(doc);
    seedPageMeta(doc, fields);
    expect(sameSnapshot(before, snapshotOf(doc))).toBe(true);
  });

  it('sees a deletion as a change, which a state vector would not', () => {
    const { state, snapshot } = seedState('Hello world');
    const doc = load(state);
    expect(sameSnapshot(snapshot, snapshotOf(doc))).toBe(true);
    const text = doc.getXmlFragment(BODY_FIELD).get(0) as Y.XmlElement;
    (text.get(0) as Y.XmlText).delete(0, 6);
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVectorFromUpdate(state));
    expect(sameSnapshot(snapshot, snapshotOf(doc))).toBe(false);
  });

  it('checkpoints a due draft once, even with two instances sweeping', async () => {
    const due = [{ id: 'd1', workspace_id: 'w', document_id: 'doc', branch_id: 'b', last_checkpoint_at: null }];
    let claimed = false;
    const drafts = {
      dueForCheckpoint: vi.fn().mockResolvedValue(due),
      // The guarded UPDATE: the first claim wins, the second sees the moved timestamp.
      claimCheckpoint: vi.fn(async () => (claimed ? null : ((claimed = true), new Uint8Array([1, 2])))),
      dropIdle: vi.fn().mockResolvedValue(0),
    };
    const storage = { putObjectBytes: vi.fn(), pruneObjectVersions: vi.fn() };
    const events = { publish: vi.fn() };
    const config = { get: (key: string) => ({ COLLAB_CHECKPOINT_INTERVAL_MINUTES: 15, COLLAB_CHECKPOINT_KEEP: 3, COLLAB_DRAFT_RETENTION_DAYS: 30 })[key] };
    const sweepers = [0, 1].map(() => new CollabCheckpointSweeper(config as never, drafts as never, storage as never, events as never));
    await Promise.all(sweepers.map((s) => s.sweep()));
    expect(storage.putObjectBytes).toHaveBeenCalledOnce();
    expect(storage.putObjectBytes).toHaveBeenCalledWith(checkpointKey('w', 'doc', 'b'), new Uint8Array([1, 2]), 'application/octet-stream');
    expect(storage.pruneObjectVersions).toHaveBeenCalledWith(checkpointKey('w', 'doc', 'b'), 3);
    expect(events.publish).toHaveBeenCalledWith({ type: 'draft.changed', workspaceId: 'w', documentId: 'doc', subjectId: 'b' });
    expect(drafts.dropIdle).toHaveBeenCalledWith(30);
  });

  it('parses only the names it builds', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] as const;
    expect(parseCollabDocName(collabDocName(...ids))).toEqual({ workspaceId: ids[0], documentId: ids[1], branchId: ids[2] });
    for (const bad of ['collab:a:b:c', `collab:${ids.join(':')}:extra`, `draft:${ids.join(':')}`, `collab:${ids[0]}:${ids[1]}`]) {
      expect(parseCollabDocName(bad)).toBeNull();
    }
  });

  it('carries a copy’s generation beside its ticket, and a new one per reseed (phase 6)', () => {
    const row = { id: '33333333-3333-4333-8333-333333333333', resetAt: null };
    const seeded = generationOf(row);
    const reset = generationOf({ ...row, resetAt: new Date(1_760_000_000_123) });
    expect(reset).not.toBe(seeded);
    expect(generationOf({ ...row, id: '44444444-4444-4444-8444-444444444444' })).not.toBe(seeded);

    expect(parseCollabToken(collabToken('kt_abc', reset))).toEqual({ ticket: 'kt_abc', generation: reset });
    expect(parseCollabToken(collabToken('kt_abc', null))).toEqual({ ticket: 'kt_abc', generation: null });
    // AUTH_MODE=none mints no ticket; the copy still counts.
    expect(parseCollabToken(collabToken('', seeded))).toEqual({ ticket: '', generation: seeded });
  });
});
