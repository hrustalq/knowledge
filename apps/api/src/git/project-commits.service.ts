import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { slugFor } from './slug.js';

/** One page's tree state after a commit (`project_commit_changes`). */
export interface CommitChange {
  documentId: string;
  revisionId: string;
  parentDocumentId: string | null;
  slug: string;
  removed: boolean;
}

/** A page and its place: a tree change to apply or record. */
export type PagePlace = Place & { documentId: string };

interface CommitInput {
  workspaceId: string;
  projectId: string;
  branch: string;
  authorId: string;
  at: Date;
  message: string;
  coAuthorIds?: string[];
  /** The first parent when the branch has no commit yet: the commit that wrote this revision. */
  forkRevisionId?: string;
  /** A merge's source branch: its head commit becomes the second parent. */
  mergedFrom?: string;
  changes: CommitChange[];
}

/** A pushed commit (#636 phase 4): parents and header bytes as the pusher's git wrote them. */
export interface PushedCommit {
  workspaceId: string;
  projectId: string;
  branch: string;
  /** Commit ids, ordered: order 1 first. */
  parents: string[];
  header: Buffer;
  changes: CommitChange[];
}

type PageRow = { id: string; path: string };

/** Where a commit puts a page in its project's tree. */
export interface Place {
  parentDocumentId: string | null;
  slug: string;
  removed: boolean;
}

/** Fallback author when no principal is supplied (AUTH_MODE=none, system writers). */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/**
 * Stored project commits (#636, docs/features/71 "Stored commits"). Every
 * state-changing write in a project records one here, inside its own
 * transaction. Nothing reads them yet: the git read side (phase 3) renders
 * them per visible set.
 *
 * A private draft page (#474), or a page under one, writes no commit: its
 * history would otherwise appear in every reader's clone the moment it is
 * published. `publishDraft` writes the one commit that adds it.
 */
@Injectable()
export class ProjectCommitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Serialize every commit write in these projects. Take it FIRST in the
   * transaction, before any row lock — `MergeRequestsService.merge` takes it
   * before its `document_branches ... FOR UPDATE` — so two writers always
   * queue on it in the same order and never deadlock. Re-entrant within one
   * transaction, so a nested finalize takes it again for free.
   *
   * ponytail: one lock per project serializes all of a project's writes; key it
   * by (project, branch) if a busy project ever queues on it.
   */
  async lock(...projectIds: string[]): Promise<void> {
    for (const id of [...new Set(projectIds)].sort()) {
      await this.prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`project_commits:${id}`}, 0))`;
    }
  }

  /**
   * `title`'s slug under `parentId`, suffixed with the id's first 8 hex when a
   * sibling already holds it case-folded (macOS and Windows checkouts are
   * case-insensitive). `current` is kept while it still fits. Call under `lock`.
   */
  async uniqueSlug(projectId: string, parentId: string | null, documentId: string, title: string, current?: string | null): Promise<string> {
    const base = slugFor(title);
    const suffixed = `${base}-${documentId.slice(0, 8)}`;
    const wanted = current === suffixed ? suffixed : base;
    const taken = await this.prisma.document.count({
      where: { projectId, parentId, id: { not: documentId }, slug: { equals: wanted, mode: 'insensitive' } },
    });
    return taken ? suffixed : wanted;
  }

  /**
   * The id of the project branch called `name` (#636 phase 1b), created on
   * first ask. One statement, so two writers asking at once get the same row.
   */
  async projectBranch(projectId: string, name: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO project_branches (id, workspace_id, project_id, name)
      SELECT gen_random_uuid(), workspace_id, id, ${name} FROM projects WHERE id = ${projectId}::uuid
      ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`;
    if (!rows[0]) throw new Error(`Project ${projectId} not found`);
    return rows[0].id;
  }

  /**
   * Point every page branch in `projectId` at that project's branch of the
   * same name: after pages moved in from another project, or where a branch
   * has none yet (one the previous image created). `db` is for a caller in a
   * `$transaction` callback, which has no ambient transaction.
   */
  async rehomeBranches(projectId: string, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    await db.$executeRaw`
      INSERT INTO project_branches (id, workspace_id, project_id, name)
      SELECT gen_random_uuid(), x.workspace_id, x.project_id, x.name
      FROM (
        SELECT DISTINCT d.workspace_id, d.project_id, b.name
        FROM document_branches b
        JOIN documents d ON d.id = b.document_id
        LEFT JOIN project_branches pb ON pb.id = b.project_branch_id
        WHERE d.project_id = ${projectId}::uuid AND pb.project_id IS DISTINCT FROM d.project_id
      ) x
      ON CONFLICT (project_id, name) DO NOTHING`;
    await db.$executeRaw`
      UPDATE document_branches b SET project_branch_id = pb.id
      FROM documents d, project_branches pb
      WHERE d.id = b.document_id AND d.project_id = ${projectId}::uuid
        AND pb.project_id = d.project_id AND pb.name = b.name
        AND b.project_branch_id IS DISTINCT FROM pb.id`;
  }

  /**
   * The commit for revisions just finalized, in their transaction: one per
   * save, and one for every page of a merge (#636). `mergedFrom` names the
   * merged source branch, whose head commit becomes the second parent.
   */
  async recordRevisions(
    revisionIds: string[],
    opts: { authorId?: string; mergedFrom?: string; placed?: string[] } = {},
  ): Promise<void> {
    const revisions = await this.prisma.documentRevision.findMany({
      where: { id: { in: revisionIds } },
      include: {
        document: true,
        branch: { select: { name: true } },
        parents: { where: { parentOrder: 1 }, select: { parentRevisionId: true } },
      },
      orderBy: { document: { path: 'asc' } },
    });
    const drafts = await this.inDrafts(revisions.map((r) => r.document));
    const kept = revisions.filter((r) => !drafts.has(r.document.id));
    if (kept.length === 0) return;
    const [r] = kept;
    const doc = r.document;
    const branch = r.branch?.name ?? doc.defaultBranch;
    const slugOf = (d: typeof doc) => d.slug ?? slugFor(d.title);
    // A branch carries its own tree (#636 phase 4): a page a push moved there
    // stays where the branch put it when the web edits it there.
    const places = branch === doc.defaultBranch ? new Map<string, Place>() : await this.branchPlaces(doc.projectId, branch, kept.map((k) => k.document.id));
    // Pages a merge moved, renamed or archived without a revision of their own.
    const placed = opts.placed?.length ? await this.statesOf(opts.placed.filter((id) => !kept.some((k) => k.document.id === id))) : [];
    await this.write({
      workspaceId: doc.workspaceId,
      projectId: doc.projectId,
      branch,
      authorId: opts.authorId ?? r.authorId,
      at: r.finalizedAt ?? new Date(),
      message: r.message?.trim() || `Update ${slugOf(doc)}`,
      coAuthorIds: kept.flatMap((k) => (Array.isArray(k.coAuthorIds) ? (k.coAuthorIds as string[]) : [])),
      forkRevisionId: r.parents[0]?.parentRevisionId,
      mergedFrom: opts.mergedFrom,
      changes: [
        ...kept.map((k) => ({
          documentId: k.document.id,
          revisionId: k.id,
          parentDocumentId: places.get(k.document.id)?.parentDocumentId ?? k.document.parentId,
          slug: places.get(k.document.id)?.slug ?? slugOf(k.document),
          removed: false,
        })),
        ...placed,
      ],
    });
  }

  /** A pushed commit, as git wrote it; its id. Call under `lock`, in the push's transaction. */
  async recordPushed(input: PushedCommit): Promise<string> {
    const row = await this.prisma.projectCommit.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        branch: input.branch,
        header: new Uint8Array(input.header),
        parents: { create: input.parents.map((parentCommitId, i) => ({ parentCommitId, parentOrder: i + 1 })) },
        changes: { createMany: { data: input.changes } },
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Where `branch` last placed each of these pages (#636 phase 4): its
   * latest change row on that branch. A page the branch never wrote is not
   * in the map, and reads as the default branch places it.
   */
  async branchPlaces(projectId: string, branch: string, documentIds: string[]): Promise<Map<string, Place>> {
    if (documentIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ document_id: string; parent_document_id: string | null; slug: string; removed: boolean }[]>`
      SELECT DISTINCT ON (c.document_id) c.document_id, c.parent_document_id, c.slug, c.removed
      FROM project_commit_changes c JOIN project_commits pc ON pc.id = c.commit_id
      WHERE pc.project_id = ${projectId}::uuid AND pc.branch = ${branch} AND c.document_id = ANY(${documentIds}::uuid[])
      ORDER BY c.document_id, pc.seq DESC`;
    return new Map(rows.map((r) => [r.document_id, { parentDocumentId: r.parent_document_id, slug: r.slug, removed: r.removed }]));
  }

  /** The latest commit on a project branch, or null while nothing was written on it. */
  async headCommit(projectId: string, branch: string): Promise<string | null> {
    const head = await this.prisma.projectCommit.findFirst({
      where: { projectId, branch },
      orderBy: { seq: 'desc' },
      select: { id: true },
    });
    return head?.id ?? null;
  }

  /**
   * One commit on the default branch recording these pages' current place in
   * `projectId`'s tree — a move, a rename, an archive, a publish. Pages with no
   * default-branch head (a pending page, an empty one) or inside a draft are
   * left out; nothing left means no commit. `removed` overrides the archive
   * flag: a page moved to another project is gone from this one's tree.
   */
  /** These pages' current place on the default branch, at its head: a commit's change rows for a tree-only change. */
  private async statesOf(documentIds: string[]): Promise<CommitChange[]> {
    if (documentIds.length === 0) return [];
    const docs = await this.prisma.document.findMany({
      where: { id: { in: documentIds } },
      include: { branches: { select: { name: true, headRevisionId: true } } },
      orderBy: { path: 'asc' },
    });
    return docs.flatMap((d) => {
      const head = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId;
      return head ? [{ documentId: d.id, revisionId: head, parentDocumentId: d.parentId, slug: d.slug ?? slugFor(d.title), removed: d.archivedAt !== null }] : [];
    });
  }

  async recordState(
    projectId: string,
    documentIds: string[],
    opts: { actorId?: string; message: string; removed?: boolean; mergedFrom?: string },
  ): Promise<void> {
    if (documentIds.length === 0) return;
    const docs = await this.prisma.document.findMany({
      where: { id: { in: documentIds } },
      include: { branches: { select: { name: true, headRevisionId: true } } },
      orderBy: { path: 'asc' },
    });
    const drafts = await this.inDrafts(docs);
    const changes: CommitChange[] = [];
    for (const d of docs) {
      const head = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId;
      if (!head || drafts.has(d.id)) continue;
      changes.push({
        documentId: d.id,
        revisionId: head,
        parentDocumentId: d.parentId,
        slug: d.slug ?? slugFor(d.title),
        removed: opts.removed ?? d.archivedAt !== null,
      });
    }
    if (changes.length === 0) return;
    await this.write({
      workspaceId: docs[0].workspaceId,
      projectId,
      branch: docs[0].defaultBranch,
      authorId: opts.actorId ?? AUTHOR_ID_STUB,
      at: new Date(),
      message: opts.message,
      mergedFrom: opts.mergedFrom,
      changes,
    });
  }

  /** The pages among `docs` that are a private draft or sit under one. */
  private async inDrafts(docs: PageRow[]): Promise<Set<string>> {
    // `path` names self and every ancestor; the rollback sentinel names no id.
    const chain = (d: PageRow) => [d.id, ...d.path.split('/').filter((id) => id.length === 36)];
    const rows = await this.prisma.document.findMany({
      where: { id: { in: [...new Set(docs.flatMap(chain))] }, draftOwnerId: { not: null } },
      select: { id: true },
    });
    const drafts = new Set(rows.map((r) => r.id));
    return new Set(docs.filter((d) => chain(d).some((id) => drafts.has(id))).map((d) => d.id));
  }

  private async write(input: CommitInput): Promise<void> {
    const head = await this.headCommit(input.projectId, input.branch);
    const first = head ?? (input.forkRevisionId ? await this.commitOf(input.forkRevisionId) : null);
    const second = input.mergedFrom ? await this.headCommit(input.projectId, input.mergedFrom) : null;
    const parents = [first, second !== first ? second : null].filter((p): p is string => p !== null);

    await this.prisma.projectCommit.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        branch: input.branch,
        header: await this.header(input),
        parents: { create: parents.map((parentCommitId, i) => ({ parentCommitId, parentOrder: i + 1 })) },
        changes: { createMany: { data: input.changes } },
      },
    });
  }

  /** The commit that first wrote `revisionId`. */
  private async commitOf(revisionId: string): Promise<string | null> {
    const row = await this.prisma.projectCommitChange.findFirst({
      where: { revisionId },
      orderBy: { commit: { seq: 'asc' } },
      select: { commitId: true },
    });
    return row?.commitId ?? null;
  }

  /**
   * The bytes after `tree` and `parent`: author, committer, message and
   * `Co-authored-by:` trailers. The email is a noreply address built from the
   * user id, never a person's own. Frozen here, so a later rename of the person
   * or of `GIT_NOREPLY_DOMAIN` rewrites no history.
   */
  private async header(input: CommitInput): Promise<Uint8Array<ArrayBuffer>> {
    const co = [...new Set(input.coAuthorIds ?? [])].filter((id) => id !== input.authorId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [input.authorId, ...co] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((u) => [u.id, u.displayName.replace(/[<>\r\n]/g, '').trim()]));
    const domain = this.config.get<string>('GIT_NOREPLY_DOMAIN') ?? 'knowledge';
    const ident = (id: string) => `${names.get(id) || `user-${id.slice(0, 8)}`} <${id}@users.noreply.${domain}>`;
    const when = `${Math.floor(input.at.getTime() / 1000)} +0000`;
    let text = `author ${ident(input.authorId)} ${when}\ncommitter ${ident(input.authorId)} ${when}\n\n${input.message.trimEnd()}\n`;
    if (co.length > 0) text += `\n${co.map((id) => `Co-authored-by: ${ident(id)}`).join('\n')}\n`;
    return new Uint8Array(Buffer.from(text, 'utf8'));
  }
}
