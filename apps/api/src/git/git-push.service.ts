import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import matter from 'gray-matter';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AccessService } from '../auth/access.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { CompareService } from '../documents/compare.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { t } from '../i18n/t.js';
import type { GitCaller } from './git-access.service.js';
import { runGit, GitRepoService, type Project } from './git-repo.service.js';
import { isValidRefName } from './git-objects.js';
import { stripIdLine, withIdLine, type GitView, type IdLine, type ModelCommit, type PageExt } from './git-view.js';
import { ProjectCommitsService, type CommitChange } from './project-commits.service.js';

const ZERO = '0'.repeat(40);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** No `atomic`: each ref is its own transaction, so a push of two branches can land one. */
const CAPS = 'report-status side-band-64k push-options ofs-delta object-format=sha1 agent=knowledge';
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/;

/** A push refused: `reason` goes in git's `ng <ref> <reason>`, `message` in `remote:` lines. */
export class PushRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const pkt = (data: string | Buffer): Buffer => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};
const FLUSH = Buffer.from('0000');

/** pkt-lines from `from` up to the next flush. */
function readPkts(buf: Buffer, from: number): { lines: string[]; end: number } {
  const lines: string[] = [];
  let i = from;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (len === 0) return { lines, end: i + 4 };
    lines.push(buf.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, ''));
    i += len;
  }
  return { lines, end: i };
}

interface Command {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** A receive-pack request: commands, push options, the pack. */
function parsePush(body: Buffer): { commands: Command[]; options: string[]; pack: Buffer; sideband: boolean } {
  const { lines, end } = readPkts(body, 0);
  const [first = '', ...more] = lines;
  const [head, caps = ''] = first.split('\0');
  const commands = [head, ...more].filter(Boolean).map((line) => {
    const [oldSha, newSha, ref] = line.split(' ');
    return { oldSha, newSha, ref };
  });
  let rest = end;
  const options: string[] = [];
  if (caps.split(' ').includes('push-options')) {
    const o = readPkts(body, rest);
    options.push(...o.lines);
    rest = o.end;
  }
  return { commands, options, pack: body.subarray(rest), sideband: caps.split(' ').includes('side-band-64k') };
}

/** One page in a parent's tree, as the pusher saw it. */
interface Entry {
  documentId: string;
  revisionId: string;
  parentDocumentId: string | null;
  slug: string;
  ext: PageExt;
  blob: string;
}

/** One page a pushed commit changes: its place after the commit, and its new body if any. */
interface Planned extends Entry {
  path: string;
  removed: boolean;
  isNew?: { title: string; kind: 'page' | 'openapi' | 'asyncapi' };
  /** A new revision: the stored body and the id line it is served with (null = canonical). */
  content?: { body: Buffer; idLine: IdLine | null } | { copyOf: string };
  /** The first-parent revision this page's branch forks at, when the branch has none yet. */
  baseRevisionId: string | null;
  /** A merge node: the other side's revision, second parent of the new one. */
  secondParent?: string;
}

interface PlannedCommit {
  sha: string;
  id: string;
  parents: string[];
  header: Buffer;
  subject: string;
  changes: Planned[];
  index: Map<string, Entry>;
}

const extOf = (path: string): PageExt | null => (/\.(md|yaml|json)$/.exec(path)?.[1] as PageExt | undefined) ?? null;
const stemOf = (path: string) => path.replace(/\.(md|yaml|json)$/, '');
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null);
const nameOf = (path: string) => stemOf(path).slice(stemOf(path).lastIndexOf('/') + 1);

/**
 * The write side of a project as a git remote (#636 phase 4,
 * docs/features/71 "The protocol"): our own receive-pack.
 *
 * A push is mapped onto pages in the pusher's own view — a page they cannot
 * see is in neither tree, so no push can touch it — then rendered back in that
 * view and refused unless every commit comes back with the SHA that was
 * pushed (invariant 1, reproduce or refuse). What is accepted is written
 * through the ordinary paths: `createRevision` + `finalizeRevision` (so it is
 * indexed like any edit), `createDocument`, `applyPlaces`, and merge requests
 * through `MergeRequestsService`, attributed to the key's owner.
 */
@Injectable()
export class GitPushService {
  private readonly logger = new Logger(GitPushService.name);
  private readonly root: string;
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly repos: GitRepoService,
    private readonly documents: DocumentsService,
    private readonly compare: CompareService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly commits: ProjectCommitsService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly activity: ActivityService,
    config: ConfigService<Env, true>,
  ) {
    this.root = config.get('GIT_CACHE_DIR', { infer: true });
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  /** The receive-pack advertisement: the caller's refs. A read key gets it too, and learns why in `remote:` on push. */
  async advertise(workspaceId: string, projectId: string, caller: GitCaller): Promise<Buffer> {
    const refs = await this.repos.withRepo(workspaceId, projectId, caller.scope, true, ({ view }) => Promise.resolve([...view.branchRefs()]));
    const lines = refs.length
      ? refs.map(([name, sha], i) => pkt(`${sha} refs/heads/${name}${i === 0 ? `\0${CAPS}` : ''}\n`))
      : [pkt(`${ZERO} capabilities^{}\0${CAPS}\n`)];
    return Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH, ...lines, FLUSH]);
  }

  /** Apply a push; the report-status body, with `remote:` messages in side-band 2. */
  async receive(workspaceId: string, projectId: string, caller: GitCaller, body: Buffer): Promise<Buffer> {
    const { commands, options, pack, sideband } = parsePush(body);
    const messages: string[] = [];
    const results = new Map<string, string>();
    await mkdir(join(this.root, projectId), { recursive: true });
    const quarantine = await mkdtemp(join(this.root, projectId, 'push-'));
    try {
      await mkdir(join(quarantine, 'pack'));
      let unpacked = false;
      for (const c of commands) {
        try {
          await this.repos.withRepo(workspaceId, projectId, caller.scope, true, async (repo) => {
            const env = { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo.dir, 'objects') };
            const git = (args: string[], input?: Buffer | string) => runGit(['--git-dir', repo.dir, ...args], input, env);
            if (!unpacked && pack.length > 0) await git(['index-pack', '--stdin', '--fix-thin'], pack);
            unpacked = true;
            messages.push(...(await this.one(workspaceId, projectId, caller, c, options, repo, git)));
          });
          results.set(c.ref, `ok ${c.ref}`);
        } catch (err) {
          if (!(err instanceof PushRefused)) {
            this.logger.error({ msg: 'git push failed', ref: c.ref, err });
            throw err;
          }
          results.set(c.ref, `ng ${c.ref} ${err.reason}`);
          messages.push(...err.message.split('\n'));
        }
      }
    } finally {
      await rm(quarantine, { recursive: true, force: true });
    }
    const status = Buffer.concat([pkt('unpack ok\n'), ...commands.map((c) => pkt(`${results.get(c.ref)}\n`)), FLUSH]);
    if (!sideband) return status;
    const band = (n: number, b: Buffer) => pkt(Buffer.concat([Buffer.from([n]), b]));
    return Buffer.concat([...messages.map((m) => band(2, Buffer.from(`${m}\n`))), band(1, status), FLUSH]);
  }

  /** One ref update: checked, mapped, reproduced, then written. Its `remote:` lines. */
  private async one(
    workspaceId: string,
    projectId: string,
    caller: GitCaller,
    c: Command,
    options: string[],
    repo: { dir: string; view: GitView; project: Project },
    git: (args: string[], input?: Buffer | string) => Promise<Buffer>,
  ): Promise<string[]> {
    const { principal, scope } = caller;
    if (principal.apiKey?.scope === 'read') throw new PushRefused('read-only key', t('error.git.push.readOnly'));
    await this.access.requireRole(principal, workspaceId, 'editor').catch((e: unknown) => {
      if (e instanceof ForbiddenException) throw new PushRefused('forbidden', e.message);
      throw e;
    });
    const branch = c.ref.replace(/^refs\/heads\//, '');
    if (!c.ref.startsWith('refs/heads/') || !isValidRefName(branch)) throw new PushRefused('not a branch', t('error.git.push.notBranch', { ref: c.ref }));
    if (c.newSha === ZERO) throw new PushRefused('deleting is not supported', t('error.git.push.deleteRefused', { branch }));
    const { view, project } = repo;
    const shown = view.branchRefs().get(branch) ?? ZERO;
    if (c.oldSha !== shown) throw new PushRefused('fetch first', t('error.git.push.stale', { branch }));
    if (c.oldSha !== ZERO && !(await git(['merge-base', '--is-ancestor', c.oldSha, c.newSha]).then(() => true, () => false))) {
      throw new PushRefused('non-fast-forward', t('error.git.push.nonFastForward', { branch }));
    }
    // The branch's real head: commits after the one this view shows touched
    // only pages the pusher cannot see, and the push lands on top of them.
    const head = c.oldSha === ZERO ? null : (project.model.heads.get(branch) ?? null);

    const planned = await this.plan(c, branch, head, view, project, git);
    const isDefault = branch === project.defaultBranch;
    const created = planned.flatMap((p) => p.changes.filter((ch) => ch.isNew));
    await this.assertMayWrite(planned, scope);

    // Invariant 1: what we would serve back is what was pushed, or nothing lands.
    const blobs = new Map(planned.flatMap((p) => p.changes.filter((ch) => ch.content).map((ch) => [ch.revisionId, ch.blob] as const)));
    const shas = view.trial(planned.map((p) => this.modelCommit(p, branch)), blobs, created.map((ch) => ch.documentId));
    if (planned.some((p, i) => shas[i] !== p.sha)) throw new PushRefused('tree cannot be represented', t('error.git.push.cannotRepresent', { branch }));

    const write = () => this.write(workspaceId, projectId, branch, head, planned, principal.userId, isDefault);
    if (isDefault) {
      const mr = await this.mergedBy(projectId, branch, planned.at(-1)!);
      if (mr) {
        const merged = await this.mergeRequests
          .mergeByPush(mr.id, principal, async () => {
            const ids = await write();
            return ids.revisionFor(mr.documentId);
          })
          .catch((e: unknown) => this.gateRefusal(e));
        return [t('error.git.push.mrMerged', { title: merged.title, url: this.mrUrl(merged.mergeRequestId) })];
      }
      if (created.length) throw new PushRefused('new page', t('error.git.push.newOnDefault', { path: created[0].path, branch }));
      const pages = [...new Set(planned.flatMap((p) => p.changes.map((ch) => ch.documentId)))];
      const guarded = await this.prisma.documentBranch.count({ where: { documentId: { in: pages }, name: branch, protected: true } });
      if (guarded) throw new PushRefused('protected', t('error.git.push.protected', { branch }));
      await this.prisma.withTransaction(write, { timeout: 60_000, maxWait: 10_000 });
      return [];
    }
    return this.prisma.withTransaction(
      async () => {
        const ids = await write();
        return this.openMergeRequest(projectId, branch, planned, ids.created, options, principal.userId);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  /**
   * Pushed commits, oldest first, as changes to pages relative to each one's
   * first parent in the pusher's view (docs/features/71 "The tree mapping").
   * A file at an unchanged path is the page that path held; an added file
   * whose id names a page deleted in the same commit is a move; one with no id
   * is a new page (or, in a merge, the other side's page at that path); a
   * deleted file nothing re-adds is an archive.
   */
  private async plan(
    c: Command,
    branch: string,
    head: string | null,
    view: GitView,
    project: Project,
    git: (args: string[], input?: Buffer | string) => Promise<Buffer>,
  ): Promise<PlannedCommit[]> {
    const known = [...view.branchRefs().values()];
    const list = (await git(['rev-list', '--topo-order', '--reverse', c.newSha, ...(known.length ? ['--not', ...known] : [])]))
      .toString()
      .split('\n')
      .filter(Boolean);
    if (list.length === 0) throw new PushRefused('nothing new', t('error.git.push.nothingNew', { branch }));

    const out: PlannedCommit[] = [];
    const tentative = new Set<string>();
    const bySha = new Map<string, PlannedCommit>();
    const indexOf = (id: string | null): Map<string, Entry> => {
      if (id == null) return new Map();
      const mine = out.find((p) => p.id === id);
      if (mine) return mine.index;
      const index = new Map<string, Entry>();
      for (const [path, ch] of view.index(id)) index.set(path, { ...ch, blob: project.blobs.get(ch.revisionId)! });
      return index;
    };
    for (const sha of list) {
      const raw = await git(['cat-file', 'commit', sha]);
      const { parents: parentShas, header } = parseCommit(raw);
      const parents = parentShas.map((p) => bySha.get(p)?.id ?? (head && p === c.oldSha ? head : view.idOf(p)));
      if (parents.some((p) => p == null)) throw new PushRefused('unknown parent', t('error.git.push.unknownParent', { sha: sha.slice(0, 8) }));
      const ids = parents as string[];
      const subject = /\n\n([^\n]*)/.exec(header.toString('utf8'))?.[1]?.trim() ?? '';
      const commit = await this.planOne(sha, ids, parentShas, git, indexOf, tentative);
      const planned: PlannedCommit = { sha, id: randomUUID(), parents: ids, header, subject, ...commit };
      bySha.set(sha, planned);
      out.push(planned);
    }
    return out;
  }

  private async planOne(
    sha: string,
    parents: string[],
    parentShas: string[],
    git: (args: string[], input?: Buffer | string) => Promise<Buffer>,
    indexOf: (id: string | null) => Map<string, Entry>,
    tentative: Set<string>,
  ): Promise<{ changes: Planned[]; index: Map<string, Entry> }> {
    const before = indexOf(parents[0] ?? null);
    const other = parents[1] ? indexOf(parents[1]) : null;
    const pathOf = (index: Map<string, Entry>, doc: string) => [...index].find(([, e]) => e.documentId === doc)?.[0];
    const raw = (await git(['diff-tree', '-r', '-z', '--no-renames', '--raw', parentShas[0] ?? EMPTY_TREE, sha])).toString('utf8').split('\0');

    const gone = new Set<string>();
    const landed: { path: string; ext: PageExt; blob: string; bytes: Buffer; s: ReturnType<typeof stripIdLine>; doc: string | null }[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(raw[i]);
      if (!meta) continue;
      const [, , mode, , blob, status] = meta;
      const path = raw[i + 1];
      if (status === 'D') {
        if (before.has(path)) gone.add(path);
        continue;
      }
      if (mode !== '100644') throw new PushRefused('unsupported file mode', t('error.git.push.mode', { path }));
      const ext = extOf(path);
      if (!ext) throw new PushRefused('not a page', t('error.git.push.notPage', { path }));
      const bytes = await git(['cat-file', 'blob', blob]);
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new PushRefused('binary file', t('error.git.push.binary', { path }));
      }
      landed.push({ path, ext, blob, bytes, s: stripIdLine(bytes, ext), doc: null });
    }

    // Who each landed file is: the page at its path, the page its id names
    // (a move when that page's old path is gone here), the other side's page
    // at that path in a merge, or a new page.
    for (const l of landed) {
      const was = before.get(l.path);
      if (was) {
        if (l.s.id && l.s.id !== was.documentId) throw new PushRefused('page id changed', t('error.git.push.idChanged', { path: l.path, id: was.documentId }));
        l.doc = was.documentId;
      } else if (l.s.id) {
        const at = pathOf(before, l.s.id);
        if (at !== undefined && !gone.has(at)) throw new PushRefused('duplicate page id', t('error.git.push.duplicateId', { path: l.path, id: l.s.id, other: at }));
        if (at === undefined && !(other && pathOf(other, l.s.id) !== undefined)) {
          throw new PushRefused('unknown page id', t('error.git.push.unknownId', { path: l.path, id: l.s.id }));
        }
        l.doc = l.s.id;
      } else l.doc = other?.get(l.path)?.documentId ?? null;
    }
    const twice = landed.find((l, i) => l.doc && landed.findIndex((x) => x.doc === l.doc) !== i);
    if (twice) {
      const first = landed.find((x) => x.doc === twice.doc)!;
      throw new PushRefused('duplicate page id', t('error.git.push.duplicateId', { path: twice.path, id: twice.doc!, other: first.path }));
    }

    // The tree after this commit.
    const index = new Map(before);
    for (const p of gone) index.delete(p);
    const fresh = new Set<string>();
    for (const l of landed) {
      if (!l.doc) fresh.add(l.path);
      const revisionId = randomUUID();
      tentative.add(revisionId);
      index.set(l.path, { documentId: l.doc ?? randomUUID(), revisionId, parentDocumentId: null, slug: nameOf(l.path), ext: l.ext, blob: l.blob });
    }
    const stems = new Map([...index].map(([p, e]) => [stemOf(p), e.documentId]));
    const names = new Map<string, string>();
    // Replacing an existing key while iterating a Map visits each entry once.
    for (const [path, e] of index) {
      const dir = dirOf(path);
      if (dir !== null && !stems.has(dir)) throw new PushRefused('no parent page', t('error.git.push.noParentPage', { path, dir }));
      const name = nameOf(path);
      if (!name || FORBIDDEN.test(name) || RESERVED.test(name) || name.startsWith('.')) {
        throw new PushRefused('bad file name', t('error.git.push.badName', { path, name }));
      }
      const folded = `${dir ?? ''}/${name.normalize('NFC').toLowerCase()}`;
      if (names.has(folded) && names.get(folded) !== e.documentId) throw new PushRefused('name taken', t('error.git.push.nameTaken', { path }));
      names.set(folded, e.documentId);
      // Entries are the parent's objects: copy before changing one.
      index.set(path, { ...e, parentDocumentId: dir === null ? null : stems.get(dir)! });
    }

    const byDoc = new Map([...before.values()].map((e) => [e.documentId, e]));
    const changes: Planned[] = [];
    for (const l of landed) {
      const e = index.get(l.path)!;
      const old = byDoc.get(e.documentId);
      if (old && old.ext !== e.ext) throw new PushRefused('kind changed', t('error.git.push.kindChanged', { path: l.path }));
      const text = l.s.body.toString('utf8');
      changes.push({
        ...e,
        path: l.path,
        removed: false,
        isNew: fresh.has(l.path) ? { title: titleOf(text, nameOf(l.path)), kind: kindOf(l.ext, text, l.path) } : undefined,
        content: { body: l.s.body, idLine: fresh.has(l.path) ? l.s.idLine : this.idLineOf(e.documentId, l.bytes, l.s, l.ext) },
        baseRevisionId: old?.revisionId ?? null,
      });
    }
    // A page only placed: one carried along by its parent's move changes
    // nothing (its path follows the parent's); a rename or a reparent is a row.
    for (const [path, e] of index) {
      const old = byDoc.get(e.documentId);
      if (!old || changes.some((ch) => ch.documentId === e.documentId)) continue;
      if (old.parentDocumentId !== e.parentDocumentId || old.slug !== e.slug) changes.push({ ...e, path, removed: false, baseRevisionId: old.revisionId });
    }
    for (const p of gone) {
      const e = before.get(p)!;
      if (pathOf(index, e.documentId) === undefined) changes.push({ ...e, path: p, removed: true, baseRevisionId: e.revisionId });
    }

    // A merge records the other side on every page it brings in, so the
    // revision DAG's merge base moves the way git's does (invariant 3): an
    // unchanged page whose other-side revision is not already behind this
    // side's gets a merge node with this side's body.
    for (const theirs of other?.values() ?? []) {
      const at = pathOf(index, theirs.documentId);
      const mine = byDoc.get(theirs.documentId);
      if (at === undefined || mine?.revisionId === theirs.revisionId) continue;
      const ch = changes.find((x) => x.documentId === theirs.documentId);
      if (ch?.content) {
        ch.secondParent = theirs.revisionId;
        continue;
      }
      if (ch || !mine) continue;
      // ponytail: a merge of two of this push's own commits skips the ancestor test and always records the merge node.
      if (!tentative.has(theirs.revisionId) && !tentative.has(mine.revisionId)) {
        if ((await this.compare.findMergeBase(mine.documentId, mine.revisionId, theirs.revisionId).catch(() => null)) === theirs.revisionId) continue;
      }
      const revisionId = randomUUID();
      tentative.add(revisionId);
      const e = { ...index.get(at)!, revisionId };
      index.set(at, e);
      changes.push({ ...e, path: at, removed: false, content: { copyOf: mine.revisionId }, baseRevisionId: mine.revisionId, secondParent: theirs.revisionId });
    }
    return { changes, index };
  }

  /** Null when the blob carries exactly the canonical id line, which is what a revision without one is served with. */
  private idLineOf(documentId: string, bytes: Buffer, s: { body: Buffer; idLine: IdLine }, ext: PageExt): IdLine | null {
    return withIdLine(documentId, s.body, ext).equals(bytes) ? null : s.idLine;
  }

  /** The pusher may edit every page the push changes, and the parent of every page it creates. */
  private async assertMayWrite(planned: PlannedCommit[], scope: GitCaller['scope']): Promise<void> {
    const checked = new Set<string>();
    for (const ch of planned.flatMap((p) => p.changes)) {
      const id = ch.isNew ? ch.parentDocumentId : ch.documentId;
      if (!id || checked.has(id) || planned.some((p) => p.changes.some((x) => x.isNew && x.documentId === id))) continue;
      checked.add(id);
      await this.permissions.requireLevel(scope, { type: 'document', id }, 'edit').catch((e: unknown) => {
        if (e instanceof HttpException) throw new PushRefused('forbidden', t('error.git.push.cannotEdit', { path: ch.path }));
        throw e;
      });
    }
  }

  private modelCommit(p: PlannedCommit, branch: string): ModelCommit {
    return {
      id: p.id,
      branch,
      parents: p.parents,
      header: p.header,
      at: new Date(),
      changes: p.changes.map((ch) => ({
        documentId: ch.documentId,
        revisionId: ch.revisionId,
        branchId: null,
        parentDocumentId: ch.parentDocumentId,
        slug: ch.slug,
        removed: ch.removed,
        ext: ch.ext,
      })),
    };
  }

  /**
   * Write the planned commits through the ordinary paths, in the caller's
   * transaction. Refused as stale if the branch moved since it was read.
   *
   * ponytail: page bodies go to MinIO inside the transaction; stage them before
   * it, as a merge does, if a push of many pages runs into the timeout.
   */
  private async write(
    workspaceId: string,
    projectId: string,
    branch: string,
    head: string | null,
    planned: PlannedCommit[],
    userId: string,
    isDefault: boolean,
  ): Promise<{ created: string[]; revisionFor: (documentId: string) => string | null }> {
    return this.prisma.withTransaction(async () => {
      await this.commits.lock(projectId);
      if ((await this.commits.headCommit(projectId, branch)) !== head) {
        throw new PushRefused('fetch first', t('error.git.push.stale', { branch }));
      }
      const docs = new Map<string, string>();
      const revisions = new Map<string, string>();
      const commitIds = new Map<string, string>();
      const created: string[] = [];
      const doc = (id: string | null) => (id ? (docs.get(id) ?? id) : null);
      const rev = (id: string) => revisions.get(id) ?? id;
      for (const p of planned) {
        const changes: CommitChange[] = [];
        // Parents before children, so a new page's parent exists when it is created.
        for (const ch of [...p.changes].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
          let documentId = ch.documentId;
          if (ch.isNew) {
            const res = await this.documents.createDocument(
              { workspaceId, projectId, title: ch.isNew.title, kind: ch.isNew.kind, parentId: doc(ch.parentDocumentId) ?? undefined, visibility: 'workspace' },
              userId,
            );
            documentId = res.documentId;
            docs.set(ch.documentId, documentId);
            created.push(documentId);
            await this.prisma.document.update({ where: { id: documentId }, data: { slug: ch.slug } });
          }
          const branchRow = await this.prisma.documentBranch.findUnique({ where: { documentId_name: { documentId, name: branch } } });
          if (!branchRow) {
            await this.documents.createBranch(documentId, { name: branch, fromRevisionId: ch.baseRevisionId && !ch.isNew ? rev(ch.baseRevisionId) : undefined }, userId);
          }
          let revisionId = rev(ch.revisionId);
          if (ch.content) revisionId = await this.writeRevision(documentId, branch, ch, p.subject, userId, rev);
          revisions.set(ch.revisionId, revisionId);
          changes.push({ documentId, revisionId, parentDocumentId: doc(ch.parentDocumentId), slug: ch.slug, removed: ch.removed });
        }
        if (isDefault) await this.documents.applyPlaces(projectId, changes, userId);
        const id = await this.commits.recordPushed({
          workspaceId,
          projectId,
          branch,
          parents: p.parents.map((x) => commitIds.get(x) ?? x),
          header: p.header,
          changes,
        });
        commitIds.set(p.id, id);
      }
      const last = new Map(planned.flatMap((p) => p.changes.map((ch) => [doc(ch.documentId)!, rev(ch.revisionId)] as const)));
      // One feed row per pushed ref, beside each revision's own `revision.finalized`
      // (triggers and chat notifications read those). Post-commit, as every record is.
      const tip = planned.at(-1)!;
      this.prisma.onCommit(() =>
        this.activity.record({
          workspaceId,
          projectId,
          actor: userId,
          action: 'git.pushed',
          subjectId: commitIds.get(tip.id),
          metadata: { branch, commits: planned.length, pages: last.size, sha: tip.sha, subject: tip.subject },
        }),
      );
      return { created, revisionFor: (documentId: string) => last.get(documentId) ?? null };
    });
  }

  private async writeRevision(documentId: string, branch: string, ch: Planned, subject: string, userId: string, rev: (id: string) => string): Promise<string> {
    const source = 'copyOf' in ch.content! ? await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: rev(ch.content!.copyOf) } }) : null;
    const contentType = source?.contentType ?? (ch.ext === 'md' ? 'text/markdown' : `application/${ch.ext}`);
    const draft = await this.documents.createRevision(documentId, { branch, message: subject || undefined, contentType }, undefined, userId);
    if (ch.secondParent) {
      const hasFirst = await this.prisma.revisionParent.count({ where: { revisionId: draft.revisionId } });
      await this.prisma.revisionParent.create({ data: { revisionId: draft.revisionId, parentRevisionId: rev(ch.secondParent), parentOrder: hasFirst ? 2 : 1 } });
    }
    const row = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId }, select: { s3Key: true, contentType: true } });
    const body = source ? Buffer.from(await this.storage.getObjectBytes(source.s3Key)) : (ch.content as { body: Buffer }).body;
    const idLine = source ? source.idLine : (ch.content as { idLine: IdLine | null }).idLine;
    await this.storage.putObjectBytes(row.s3Key, new Uint8Array(body), row.contentType);
    if (idLine) await this.prisma.documentRevision.update({ where: { id: draft.revisionId }, data: { idLine: idLine as object } });
    try {
      // `dedupe: false`: every pushed change is a commit, an id-line-only edit included.
      return (await this.documents.finalizeRevision(documentId, draft.revisionId, { commit: false, dedupe: false })).revisionId;
    } catch (e) {
      // A spec that does not parse, a fixture naming an unknown operation: finalize's own refusal.
      if (e instanceof HttpException && e.getStatus() < 500) throw new PushRefused('rejected', t('error.git.push.rejected', { path: ch.path, reason: e.message }));
      throw e;
    }
  }

  /** The open merge request a pushed merge commit lands: into this branch, whose source head is the commit's second parent. */
  private async mergedBy(projectId: string, branch: string, last: PlannedCommit): Promise<{ id: string; documentId: string } | null> {
    const second = last.parents[1];
    if (!second) return null;
    const open = await this.prisma.mergeRequest.findMany({
      where: { status: 'open', targetBranch: { name: branch }, document: { projectId } },
      select: { id: true, documentId: true, sourceBranch: { select: { name: true } } },
    });
    for (const mr of open) if ((await this.commits.headCommit(projectId, mr.sourceBranch.name)) === second) return mr;
    return null;
  }

  /** A merge gate's refusal, in the words the web merge uses. */
  private gateRefusal(e: unknown): never {
    if (e instanceof PushRefused) throw e;
    if (e instanceof HttpException && e.getStatus() < 500) {
      const body = e.getResponse() as { reason?: string };
      throw new PushRefused(body.reason ?? 'refused', e.message);
    }
    throw e;
  }

  /**
   * After a push to a branch: the open merge request it updates, or one it
   * opens — on `-o merge_request.create`, or as a draft whenever the push
   * created a page, so a head-less page always has its merge request.
   */
  private async openMergeRequest(
    projectId: string,
    branch: string,
    planned: PlannedCommit[],
    created: string[],
    options: string[],
    userId: string,
  ): Promise<string[]> {
    const opt = (k: string) => options.find((o) => o === `merge_request.${k}` || o.startsWith(`merge_request.${k}=`));
    const val = (k: string) => opt(k)?.split('=').slice(1).join('=') || undefined;
    const projectBranchId = await this.commits.projectBranch(projectId, branch);
    const open = await this.prisma.mergeRequest.findFirst({
      where: { status: 'open', sourceBranch: { projectBranchId } },
      select: { id: true, title: true },
    });
    let mr = open;
    if (!mr && (opt('create') || created.length)) {
      // Opened from a page this push gave a revision of its own, else any page it changed.
      const changed = planned.flatMap((p) => p.changes);
      const rows = await this.prisma.documentBranch.findMany({
        where: { projectBranchId, headRevisionId: { not: null } },
        select: { documentId: true, revisions: { where: { status: { not: 'draft' } }, select: { id: true }, take: 1 } },
      });
      const anchor = rows.find((r) => r.revisions.length)?.documentId ?? rows.find((r) => changed.some((ch) => ch.documentId === r.documentId))?.documentId ?? rows[0]?.documentId;
      if (!anchor) return [];
      const title = val('title') ?? planned.at(-1)!.subject ?? branch;
      const res = await this.mergeRequests.create(anchor, { sourceBranch: branch, targetBranch: val('target'), title: title || branch, description: val('description') }, userId);
      mr = { id: res.mergeRequest.mergeRequestId, title: res.mergeRequest.title };
      if (opt('draft') || !opt('create')) await this.prisma.mergeRequest.update({ where: { id: mr.id }, data: { isDraft: true } });
    }
    if (!mr) return [];
    if (created.length) await this.prisma.document.updateMany({ where: { id: { in: created } }, data: { pendingMergeRequestId: mr.id } });
    return [t(open ? 'error.git.push.mrUpdated' : 'error.git.push.mrCreated', { title: mr.title, url: this.mrUrl(mr.id) })];
  }

  private mrUrl(id: string): string {
    return `${this.webBaseUrl}/merge-requests/${id}`;
  }
}

/** A commit object's parent SHAs and everything after its `tree` and `parent` lines, verbatim. */
function parseCommit(raw: Buffer): { parents: string[]; header: Buffer } {
  const parents: string[] = [];
  let at = 0;
  for (;;) {
    const nl = raw.indexOf(0x0a, at);
    const line = raw.subarray(at, nl).toString('latin1');
    if (line.startsWith('tree ')) at = nl + 1;
    else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
      at = nl + 1;
    } else break;
  }
  return { parents, header: Buffer.from(raw.subarray(at)) };
}

/** A new page's title: its frontmatter `title:`, else its first `# ` heading, else its file name. */
function titleOf(text: string, fileName: string): string {
  try {
    const fm = matter(text).data as { title?: unknown };
    if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  } catch {
    // Unparseable frontmatter is the page's own business; the heading or the name will do.
  }
  return /^#[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim() || fileName;
}

/** What a new file is: a page, or an API spec by its top-level key. */
function kindOf(ext: PageExt, text: string, path: string): 'page' | 'openapi' | 'asyncapi' {
  if (ext === 'md') return 'page';
  const key = /^\s*\{?\s*["']?(openapi|asyncapi)["']?\s*:/m.exec(text)?.[1];
  if (!key) throw new PushRefused('not an API spec', t('error.git.push.notSpec', { path }));
  return key as 'openapi' | 'asyncapi';
}
