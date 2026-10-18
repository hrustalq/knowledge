import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { collabDocName, parseCollabDocName } from '@knowledge/contracts';
import { editorSchema, parseMarkdown } from '@knowledge/editor-schema';
import {
  BODY_FIELD,
  CollabDraftTooLargeError,
  CollabDraftsService,
  seedState,
} from '../src/collab/collab-drafts.service.js';

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

function body(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(BODY_FIELD), editorSchema);
}

describe('collab drafts (#80 phase 1)', () => {
  it('seeds the body exactly as the editor opens the page', () => {
    const seeded = body(seedState(PAGE));
    expect(seeded.eq(parseMarkdown(PAGE, dom))).toBe(true);
    const types = new Set<string>();
    seeded.descendants((n) => void types.add(n.type.name));
    for (const t of ['knPanel', 'knExpand', 'taskList', 'table', 'knApi', 'knMermaid', 'knUserMention', 'knAgentMention']) {
      expect(types).toContain(t);
    }
  });

  it('seeds a branch with no head as an empty page', () => {
    expect(body(seedState('')).eq(parseMarkdown('', dom))).toBe(true);
  });

  it('refuses a store over COLLAB_MAX_DOC_BYTES without writing', async () => {
    const prisma = { $executeRaw: vi.fn() };
    const drafts = new CollabDraftsService({ get: () => 10 } as never, prisma as never, {} as never);
    await expect(drafts.store('d', 'b', new Uint8Array(11), 'u')).rejects.toBeInstanceOf(CollabDraftTooLargeError);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    await drafts.store('d', 'b', new Uint8Array(10), 'u');
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('parses only the names it builds', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] as const;
    expect(parseCollabDocName(collabDocName(...ids))).toEqual({ workspaceId: ids[0], documentId: ids[1], branchId: ids[2] });
    for (const bad of ['collab:a:b:c', `collab:${ids.join(':')}:extra`, `draft:${ids.join(':')}`, `collab:${ids[0]}:${ids[1]}`]) {
      expect(parseCollabDocName(bad)).toBeNull();
    }
  });
});
