import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { slugFor } from './slug.js';

/** One page's tree state after a commit (`project_commit_changes`). */
interface CommitChange {
  documentId: string;
  revisionId: string;
  parentDocumentId: string | null;
  slug: string;
  removed: boolean;
}

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
  /** A merge's source head revision: its commit becomes the second parent. */
  mergedFrom?: string;
  changes: CommitChange[];
}

type PageRow = { id: string; path: string };

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

  /** The commit for a revision `finalizeRevision` just finalized, in its transaction. */
  async recordRevision(revisionId: string, opts: { authorId?: string; mergedFrom?: string } = {}): Promise<void> {
    const r = await this.prisma.documentRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: {
        document: true,
        branch: { select: { name: true } },
        parents: { where: { parentOrder: 1 }, select: { parentRevisionId: true } },
      },
    });
    const doc = r.document;
    if ((await this.inDrafts([doc])).has(doc.id)) return;
    const slug = doc.slug ?? slugFor(doc.title);
    await this.write({
      workspaceId: doc.workspaceId,
      projectId: doc.projectId,
      branch: r.branch?.name ?? doc.defaultBranch,
      authorId: opts.authorId ?? r.authorId,
      at: r.finalizedAt ?? new Date(),
      message: r.message?.trim() || `Update ${slug}`,
      coAuthorIds: Array.isArray(r.coAuthorIds) ? (r.coAuthorIds as string[]) : [],
      forkRevisionId: r.parents[0]?.parentRevisionId,
      mergedFrom: opts.mergedFrom,
      changes: [{ documentId: doc.id, revisionId: r.id, parentDocumentId: doc.parentId, slug, removed: false }],
    });
  }

  /**
   * One commit on the default branch recording these pages' current place in
   * `projectId`'s tree — a move, a rename, an archive, a publish. Pages with no
   * default-branch head (a pending page, an empty one) or inside a draft are
   * left out; nothing left means no commit. `removed` overrides the archive
   * flag: a page moved to another project is gone from this one's tree.
   */
  async recordState(
    projectId: string,
    documentIds: string[],
    opts: { actorId?: string; message: string; removed?: boolean },
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
    const head = await this.prisma.projectCommit.findFirst({
      where: { projectId: input.projectId, branch: input.branch },
      orderBy: { seq: 'desc' },
      select: { id: true },
    });
    const first = head?.id ?? (input.forkRevisionId ? await this.commitOf(input.forkRevisionId) : null);
    const second = input.mergedFrom ? await this.commitOf(input.mergedFrom) : null;
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
