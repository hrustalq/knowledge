import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiSpecSyntaxOf } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { visibilitySql, type AccessScope } from '../permissions/access-scope.js';
import { branchLevel } from '../permissions/branch-access.js';
import { hashObject, isValidRefName, writePack, type GitObject } from './git-objects.js';
import { GitView, ProjectModel, withIdLine, type IdLine, type ModelChange, type PageExt, type Visibility } from './git-view.js';

/** Run `git` with `input` on stdin; resolves stdout, rejects with stderr. */
export function runGit(args: string[], input?: Buffer | string, env?: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    // A git that exits before reading its input is reported by `close`, not by an EPIPE crash.
    child.stdin.on('error', () => undefined);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args[2] ?? args[0]}: ${Buffer.concat(err).toString().trim()}`)),
    );
    child.stdin.end(input);
  });
}

export interface Project {
  id: string;
  model: ProjectModel;
  lastSeq: bigint;
  defaultBranch: string;
  /** Revision -> its object key and pushed id line, for a blob not yet hashed or not in a cache. */
  sources: Map<string, { s3Key: string; idLine: IdLine | null }>;
  /** Revision -> blob SHA, persisted in `blobs-v1.tsv` so a restart reads no page body twice. */
  blobs: Map<string, string>;
}

const PACKED_REFS_HEADER = '# pack-refs with: peeled fully-peeled sorted \n';
/** Views kept in memory. An evicted one is re-hashed from rows on its next fetch, reading nothing from MinIO. */
const MAX_VIEWS = 64;
/** A sync writing at least this many objects repacks the cache (a cold build). */
const REPACK_AT = 1000;

/**
 * The read side of a project as a git remote (#636 phase 3, docs/features/71
 * "The protocol"): one bare repository per (project, visible set), filled
 * from `project_commits` and served by the real `git upload-pack`.
 *
 * A repository only ever holds objects its own view renders, so no `want`
 * can reach a page or a private branch outside it, whatever git allows.
 */
@Injectable()
export class GitRepoService {
  private readonly logger = new Logger(GitRepoService.name);
  private readonly root: string;
  private readonly projects = new Map<string, Project>();
  private readonly views = new Map<string, GitView>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService<Env, true>,
  ) {
    this.root = config.get('GIT_CACHE_DIR', { infer: true });
  }

  /**
   * The bare repository `scope` reads, brought up to the latest commit when
   * `sync` (a ref advertisement) or when it does not exist yet. The pack
   * request after an advertisement serves the repository as it stands: history
   * is append-only, so what was advertised is still in it.
   */
  async repoFor(workspaceId: string, projectId: string, scope: AccessScope, sync: boolean): Promise<string> {
    return this.withRepo(workspaceId, projectId, scope, sync, ({ dir }) => Promise.resolve(dir));
  }

  /**
   * `fn` over `scope`'s repository brought up to date, its view and the
   * project's model, under the project's lock: a push reads its parent trees
   * and writes its commits with no sync of this project in between.
   */
  async withRepo<T>(
    workspaceId: string,
    projectId: string,
    scope: AccessScope,
    sync: boolean,
    fn: (repo: { dir: string; view: GitView; project: Project }) => Promise<T>,
  ): Promise<T> {
    // ponytail: one lock per project serializes its syncs; per (project, view) if fetches queue.
    return this.serialized(projectId, async () => {
      const project = await this.load(projectId);
      const visibility = await this.visibility(projectId, project, scope);
      // ponytail: a visible set's repository is never deleted once its set changes; sweep
      // directories by mtime if the cache volume grows (one per project and access set).
      const dir = join(this.root, projectId, `${visibility.key}.git`);
      if (sync || !existsSync(join(dir, 'HEAD'))) {
        try {
          await this.syncRepo(workspaceId, project, visibility, dir);
        } catch (err) {
          // The view has drained objects that never reached the repository: start
          // it over, and the next sync writes whatever `cat-file` finds missing.
          this.views.delete(dir);
          throw err;
        }
      }
      return fn({ dir, view: this.views.get(dir) ?? new GitView(project.model, visibility, (ch) => project.blobs.get(ch.revisionId)!), project });
    });
  }

  private async serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  /** The project's commits, read incrementally: only those written since the last call. */
  private async load(projectId: string): Promise<Project> {
    let project = this.projects.get(projectId);
    if (!project) {
      const top = await this.prisma.document.groupBy({
        by: ['defaultBranch'],
        where: { projectId },
        _count: { _all: true },
        orderBy: { _count: { defaultBranch: 'desc' } },
        take: 1,
      });
      project = {
        id: projectId,
        model: new ProjectModel(),
        lastSeq: 0n,
        defaultBranch: top[0]?.defaultBranch ?? 'main',
        sources: new Map(),
        blobs: await this.readBlobs(projectId),
      };
      this.projects.set(projectId, project);
    }
    const commits = await this.prisma.projectCommit.findMany({
      where: { projectId, seq: { gt: project.lastSeq } },
      orderBy: { seq: 'asc' },
      include: { parents: { orderBy: { parentOrder: 'asc' } }, changes: true },
    });
    if (commits.length === 0) return project;

    const revisionIds = [...new Set(commits.flatMap((c) => c.changes.map((ch) => ch.revisionId)))];
    const documentIds = [...new Set(commits.flatMap((c) => c.changes.map((ch) => ch.documentId)))];
    const [revisions, documents] = await Promise.all([
      this.prisma.documentRevision.findMany({
        where: { id: { in: revisionIds } },
        select: { id: true, branchId: true, contentType: true, s3Key: true, idLine: true },
      }),
      this.prisma.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, kind: true } }),
    ]);
    const revision = new Map(revisions.map((r) => [r.id, r]));
    const kind = new Map(documents.map((d) => [d.id, d.kind]));
    for (const r of revisions) project.sources.set(r.id, { s3Key: r.s3Key, idLine: r.idLine as IdLine | null });

    for (const c of commits) {
      project.model.add({
        id: c.id,
        branch: c.branch,
        parents: c.parents.map((p) => p.parentCommitId),
        header: Buffer.from(c.header),
        at: c.createdAt,
        changes: c.changes.map((ch): ModelChange => {
          const r = revision.get(ch.revisionId);
          // A hard-deleted page has no row; it is in nobody's view, so any extension does.
          const ext: PageExt = kind.get(ch.documentId) === 'page' || !r ? 'md' : (apiSpecSyntaxOf(r.contentType) ?? 'md');
          return {
            documentId: ch.documentId,
            revisionId: ch.revisionId,
            branchId: r?.branchId ?? null,
            parentDocumentId: ch.parentDocumentId,
            slug: ch.slug,
            removed: ch.removed,
            ext,
          };
        }),
      });
    }
    project.lastSeq = commits[commits.length - 1].seq;
    return project;
  }

  /**
   * The pages of this project `scope` may open (`visibilitySql`, feature 48),
   * and the private page branches it may not read (#474). Their hash names the
   * cache: two people with equal access share one repository and one set of SHAs.
   */
  private async visibility(projectId: string, project: Project, scope: AccessScope): Promise<Visibility & { key: string }> {
    const docs = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id FROM documents d
      WHERE d.id IN (
        SELECT c.document_id FROM project_commit_changes c
        JOIN project_commits pc ON pc.id = c.commit_id
        WHERE pc.project_id = ${projectId}::uuid
      ) AND ${visibilitySql(scope, 'd')}`;
    const branchIds = [...new Set(project.model.commits.flatMap((c) => c.changes.flatMap((ch) => (ch.branchId ? [ch.branchId] : []))))];
    const restricted = await this.prisma.documentBranch.findMany({
      where: { id: { in: branchIds }, restricted: true },
      select: { id: true, ownerId: true, restricted: true },
    });
    const grants = restricted.length
      ? await this.prisma.accessGrant.findMany({
          where: { resourceType: 'branch', resourceId: { in: restricted.map((b) => b.id) } },
          select: { resourceId: true, subjectType: true, subjectId: true, level: true },
        })
      : [];
    const documents = new Set(docs.map((d) => d.id));
    const hiddenBranches = new Set(restricted.filter((b) => branchLevel(scope, b, grants) === 'none').map((b) => b.id));
    const key = createHash('sha256')
      .update(`${[...documents].sort().join(',')}|${[...hiddenBranches].sort().join(',')}`)
      .digest('hex')
      .slice(0, 16);
    return { documents, hiddenBranches, key };
  }

  private async syncRepo(workspaceId: string, project: Project, visibility: Visibility & { key: string }, dir: string): Promise<void> {
    if (!existsSync(join(dir, 'HEAD'))) {
      await mkdir(dir, { recursive: true });
      await runGit(['init', '--bare', '-q', dir]);
      // An advertised tip may have moved on by the time its pack is asked for;
      // anything reachable is this view's own. Nothing here is ever unreachable
      // garbage worth pruning: history is append-only.
      await runGit(['--git-dir', dir, 'config', 'uploadpack.allowReachableSHA1InWant', 'true']);
      await runGit(['--git-dir', dir, 'config', 'gc.pruneExpire', 'never']);
    }
    let view = this.views.get(dir);
    if (view) this.views.delete(dir);
    else view = new GitView(project.model, visibility, (ch) => project.blobs.get(ch.revisionId)!);
    this.views.set(dir, view);
    if (this.views.size > MAX_VIEWS) this.views.delete(this.views.keys().next().value!);

    // Hash every page body the new commits show that no earlier sync hashed.
    const bodies = new Map<string, Buffer>();
    const unhashed = [...new Map(view.pending().filter((ch) => !project.blobs.has(ch.revisionId)).map((ch) => [ch.revisionId, ch])).values()];
    const lines: string[] = [];
    for (const ch of unhashed) {
      const body = await this.bodyOf(project, ch);
      const sha = hashObject('blob', body);
      project.blobs.set(ch.revisionId, sha);
      bodies.set(sha, body);
      lines.push(`${ch.revisionId}\t${sha}\n`);
    }
    if (lines.length) await appendFile(this.blobsFile(project.id), lines.join(''));

    const blobChange = new Map(view.pending().map((ch) => [project.blobs.get(ch.revisionId)!, ch]));
    const { objects, blobs } = view.advance().drain();
    const wanted = [...objects.keys(), ...blobs];
    const missing = wanted.length ? await this.missing(dir, wanted) : [];
    const write: GitObject[] = [];
    for (const sha of missing) {
      const object = objects.get(sha);
      if (object) write.push(object);
      else write.push({ type: 'blob', body: bodies.get(sha) ?? (await this.bodyOf(project, blobChange.get(sha)!)) });
    }
    if (write.length) await runGit(['--git-dir', dir, 'index-pack', '--stdin'], writePack(write));
    await this.writeRefs(workspaceId, project, view, dir);
    if (write.length >= REPACK_AT) await runGit(['--git-dir', dir, 'repack', '-a', '-d', '-q']);
    else if (write.length) await runGit(['--git-dir', dir, 'gc', '--auto', '--quiet']);
  }

  /** A revision's bytes as served: its stored body with the page's id line. */
  private async bodyOf(project: Project, ch: ModelChange): Promise<Buffer> {
    const { s3Key, idLine } = project.sources.get(ch.revisionId)!;
    return withIdLine(ch.documentId, Buffer.from(await this.storage.getObjectBytes(s3Key)), ch.ext, idLine);
  }

  /** The SHAs among `shas` this repository lacks. */
  private async missing(dir: string, shas: string[]): Promise<string[]> {
    const out = await runGit(['--git-dir', dir, 'cat-file', '--batch-check'], shas.join('\n') + '\n');
    return out
      .toString()
      .split('\n')
      .filter((line) => line.endsWith(' missing'))
      .map((line) => line.slice(0, 40));
  }

  /**
   * Branches with a commit of their own in view, and release tags as
   * lightweight tags at the last default-branch commit at or before their
   * timestamp (a workspace-level tag in every project). A name git refuses is
   * left out and logged. Written whole and renamed, so a concurrent
   * upload-pack reads the old file or the new one.
   */
  private async writeRefs(workspaceId: string, project: Project, view: GitView, dir: string): Promise<void> {
    const refs = new Map<string, string>();
    const skipped: string[] = [];
    for (const [branch, sha] of view.branchRefs()) {
      if (isValidRefName(branch)) refs.set(`refs/heads/${branch}`, sha);
      else skipped.push(branch);
    }
    const tags = await this.prisma.releaseTag.findMany({
      where: { workspaceId, OR: [{ projectId: null }, { projectId: project.id }] },
      select: { name: true, at: true },
    });
    const main = project.model.commits.filter((c) => c.branch === project.defaultBranch);
    for (const tag of tags) {
      if (!isValidRefName(tag.name)) {
        skipped.push(tag.name);
        continue;
      }
      const last = main.findLast((c) => c.at <= tag.at);
      const sha = last && view.shaOf(last.id);
      if (sha) refs.set(`refs/tags/${tag.name}`, sha);
    }
    if (skipped.length) this.logger.warn({ msg: 'git refused these ref names; left out', dir, skipped });

    const sorted = [...refs].sort(([a], [b]) => (a < b ? -1 : 1));
    const tmp = join(dir, 'packed-refs.tmp');
    await writeFile(tmp, PACKED_REFS_HEADER + sorted.map(([ref, sha]) => `${sha} ${ref}\n`).join(''));
    await rename(tmp, join(dir, 'packed-refs'));
    await writeFile(join(dir, 'HEAD'), `ref: refs/heads/${project.defaultBranch}\n`);
  }

  /** Versioned: a change to `withIdLine` changes every blob, so it starts a new file. */
  private blobsFile(projectId: string): string {
    return join(this.root, projectId, 'blobs-v1.tsv');
  }

  private async readBlobs(projectId: string): Promise<Map<string, string>> {
    await mkdir(join(this.root, projectId), { recursive: true });
    const text = await readFile(this.blobsFile(projectId), 'utf8').catch(() => '');
    return new Map(text.split('\n').flatMap((line) => (line.includes('\t') ? [line.split('\t') as [string, string]] : [])));
  }
}
