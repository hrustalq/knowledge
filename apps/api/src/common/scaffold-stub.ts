import { Prisma } from '@prisma/client';

/** `document_revisions.origin` of the revision a scaffold writes (#716). The only origin there is. */
export const SCAFFOLD_ORIGIN = 'scaffold';

/**
 * A scaffold stub (#716): a page whose default-branch head is still the
 * revision the scaffold wrote. It is a skeleton, not knowledge, so it is not
 * chunked or embedded and is absent from search, Ask, llms.txt and the
 * knowledge-health counts. It stays in the tree and the lists, which is where
 * people find it to fill in. The first real revision ends it with no code of
 * its own: the head moves to a revision with no origin.
 *
 * Two spellings, pinned against each other in `test/scaffold-stub.spec.ts`:
 * this one over a head already in hand, `scaffoldStubSql` over `documents`.
 */
export function isScaffoldStub(head: { origin: string | null } | null | undefined): boolean {
  return head?.origin === SCAFFOLD_ORIGIN;
}

/** `isScaffoldStub` for raw SQL over `documents <alias>`. `alias` is a fixed identifier from the call site. */
export function scaffoldStubSql(alias: string): Prisma.Sql {
  const d = Prisma.raw(alias);
  return Prisma.sql`EXISTS (
    SELECT 1 FROM document_branches stub_b
      JOIN document_revisions stub_r ON stub_r.id = stub_b.head_revision_id
     WHERE stub_b.document_id = ${d}.id AND stub_b.name = ${d}.default_branch
       AND stub_r.origin = ${SCAFFOLD_ORIGIN})`;
}
