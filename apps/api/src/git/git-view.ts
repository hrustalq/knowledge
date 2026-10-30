import { hashObject, treeBody, type GitObject } from './git-objects.js';

/**
 * Stored project commits rendered as git objects for one reader (#636,
 * docs/features/71 "One reader's view"). Ported from the spike's `view.mjs`.
 *
 * A commit with no change this reader may see drops out, and its children
 * reattach to the nearest kept first-parent ancestor. Rendering is
 * incremental: history is append-only, so a commit's SHA never changes once
 * computed, and a new commit costs only the directories on its changed paths.
 */

export type PageExt = 'md' | 'yaml' | 'json';

/** One page's tree state after a commit: a `project_commit_changes` row, plus what the path needs. */
export interface ModelChange {
  documentId: string;
  revisionId: string;
  /** The page branch the revision was written on, for private-branch visibility. */
  branchId: string | null;
  parentDocumentId: string | null;
  slug: string;
  removed: boolean;
  ext: PageExt;
}

export interface ModelCommit {
  id: string;
  branch: string;
  /** Ordered: order 1 first. */
  parents: string[];
  /** Everything after `tree` and `parent`, verbatim. */
  header: Buffer;
  at: Date;
  changes: ModelChange[];
}

/** Page states as a delta chain along first parents, flattened every 32 links. */
class State {
  parent: State | null;
  delta: Map<string, ModelChange>;
  depth: number;

  constructor(parent: State | null, delta: Map<string, ModelChange>) {
    this.parent = parent;
    this.delta = delta;
    this.depth = parent ? parent.depth + 1 : 0;
    if (this.depth > 32) {
      const flat = new Map(delta);
      for (let s = parent; s; s = s.parent) for (const [k, v] of s.delta) if (!flat.has(k)) flat.set(k, v);
      this.parent = null;
      this.delta = flat;
      this.depth = 0;
    }
  }

  get(doc: string): ModelChange | undefined {
    return this.delta.get(doc) ?? this.parent?.get(doc);
  }
}

const EMPTY_STATE = new State(null, new Map());

/** Every commit of one project, in write order. Shared by all of its views. */
export class ProjectModel {
  readonly commits: ModelCommit[] = [];
  readonly byId = new Map<string, ModelCommit>();
  /** Branch name -> its latest commit. */
  readonly heads = new Map<string, string>();
  private readonly states = new Map<string, State>();

  add(commit: ModelCommit): void {
    this.commits.push(commit);
    this.byId.set(commit.id, commit);
    this.heads.set(commit.branch, commit.id);
  }

  /** Page states after commit `id`. Change rows hold a page's full state, so a delta replaces. */
  stateOf(id: string | null): State {
    if (id == null) return EMPTY_STATE;
    const hit = this.states.get(id);
    if (hit) return hit;
    const commit = this.byId.get(id);
    if (!commit) return EMPTY_STATE;
    const state = new State(this.stateOf(commit.parents[0] ?? null), new Map(commit.changes.map((ch) => [ch.documentId, ch])));
    this.states.set(id, state);
    return state;
  }
}

/** What one reader sees: pages, and the private page branches they may not read. */
export interface Visibility {
  documents: ReadonlySet<string>;
  hiddenBranches: ReadonlySet<string>;
}

// Copy-on-write directory nodes: a file is its blob SHA, a directory a node.
interface Dir {
  entries: Map<string, string | Dir>;
  sha?: string;
}
const EMPTY_DIR: Dir = { entries: new Map() };

const getAt = (node: Dir, parts: string[]): string | Dir | undefined =>
  parts.reduce<string | Dir | undefined>((n, p) => (n && typeof n === 'object' ? n.entries.get(p) : undefined), node);

function setAt(node: Dir, parts: string[], value: string | Dir): Dir {
  const entries = new Map(node.entries);
  const [head, ...rest] = parts;
  if (rest.length === 0) entries.set(head, value);
  else {
    const child = entries.get(head);
    entries.set(head, setAt(child && typeof child === 'object' ? child : EMPTY_DIR, rest, value));
  }
  return { entries };
}

function removeAt(node: Dir, parts: string[]): Dir {
  const [head, ...rest] = parts;
  const child = node.entries.get(head);
  if (child === undefined) return node;
  const entries = new Map(node.entries);
  if (rest.length === 0 || typeof child === 'string') entries.delete(head);
  else {
    const next = removeAt(child, rest);
    // git has no empty directories
    if (next.entries.size === 0) entries.delete(head);
    else entries.set(head, next);
  }
  return { entries };
}

export class GitView {
  private next = 0;
  /** Commit id -> the kept commit it maps to, or null before any. */
  private readonly mapped = new Map<string, string | null>();
  /** Kept commit id -> its mapped parents. */
  private readonly kept = new Map<string, string[]>();
  private readonly sha = new Map<string, string>();
  private readonly trees = new Map<string, Dir>();
  /** Branches with at least one commit of their own in view: the only ones advertised. */
  private readonly keptBranches = new Set<string>();
  private fresh = new Map<string, GitObject>();
  private freshBlobs = new Set<string>();

  constructor(
    private readonly model: ProjectModel,
    private readonly visibility: Visibility,
    /** The blob SHA of a change's page body, id line included. Known for every visible change before `advance`. */
    private readonly blobOf: (change: ModelChange) => string,
  ) {}

  sees(change: ModelChange): boolean {
    return (
      this.visibility.documents.has(change.documentId) &&
      !(change.branchId !== null && this.visibility.hiddenBranches.has(change.branchId))
    );
  }

  /** Render every commit the model gained since the last call. */
  advance(): this {
    for (; this.next < this.model.commits.length; this.next++) this.one(this.model.commits[this.next]);
    return this;
  }

  /** Visible changes of commits not yet rendered: the blobs `advance` is about to need. */
  pending(): ModelChange[] {
    return this.model.commits.slice(this.next).flatMap((c) => c.changes.filter((ch) => !ch.removed && this.sees(ch)));
  }

  /** Trees and commits created since the last drain, and the blob SHAs they newly reference. */
  drain(): { objects: Map<string, GitObject>; blobs: Set<string> } {
    const out = { objects: this.fresh, blobs: this.freshBlobs };
    this.fresh = new Map();
    this.freshBlobs = new Set();
    return out;
  }

  /** `refs/heads/<branch>` for every branch with a commit of its own in view. */
  branchRefs(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [branch, id] of this.model.heads) {
      const m = this.mapped.get(id);
      if (m != null && this.keptBranches.has(branch)) out.set(branch, this.sha.get(m)!);
    }
    return out;
  }

  /** The SHA a commit id renders to in this view: itself, or the kept ancestor it collapsed onto. */
  shaOf(id: string): string | null {
    const m = this.mapped.get(id);
    return m == null ? null : (this.sha.get(m) ?? null);
  }

  private put(type: 'tree' | 'commit', body: Buffer): string {
    const sha = hashObject(type, body);
    this.fresh.set(sha, { type, body });
    return sha;
  }

  private hashDir(node: Dir): string {
    if (node.sha) return node.sha;
    const list = [...node.entries].map(([name, v]) =>
      typeof v === 'string'
        ? { mode: '100644' as const, name, sha: v }
        : { mode: '40000' as const, name, sha: this.hashDir(v) },
    );
    return (node.sha = this.put('tree', treeBody(list)));
  }

  /** Where a page's file stem sits: under its parent page's directory, if that parent is in view. */
  private dirOf(state: State, doc: string): string {
    const e = state.get(doc)!;
    const parent = e.parentDocumentId;
    const up = parent && this.visibility.documents.has(parent) && state.get(parent) ? this.dirOf(state, parent) : '';
    return up ? `${up}/${e.slug}` : e.slug;
  }

  private isAncestor(a: string, b: string): boolean {
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === a) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...(this.kept.get(x) ?? []));
    }
    return false;
  }

  private one(c: ModelCommit): void {
    const ps: string[] = [];
    for (const p of c.parents) {
      const m = this.mapped.get(p) ?? null;
      if (m != null && !ps.includes(m)) ps.push(m);
    }
    // A second parent already behind the first adds nothing (`--simplify-merges`).
    if (ps.length === 2 && this.isAncestor(ps[1], ps[0])) ps.pop();
    const visible = c.changes.filter((ch) => this.sees(ch));
    // Nothing to show: collapse onto the parent. A merge whose first parent is
    // behind its second (Update branch on a branch this reader cannot see)
    // collapses onto the second, so a hidden branch never surfaces as a merge.
    if (visible.length === 0 && c.changes.length > 0 && (ps.length < 2 || this.isAncestor(ps[0], ps[1]))) {
      this.mapped.set(c.id, ps.at(-1) ?? null);
      return;
    }
    this.kept.set(c.id, ps);
    this.mapped.set(c.id, c.id);
    this.keptBranches.add(c.branch);

    // Tree = first kept parent's tree + this commit's visible changes. Invisible
    // pages never shape a visible page's path, so the commits dropped between
    // the two cannot have moved anything this view shows.
    const before = this.model.stateOf(c.parents[0] ?? null);
    const after = this.model.stateOf(c.id);
    let tree = ps[0] ? this.trees.get(ps[0])! : EMPTY_DIR;
    for (const ch of visible) {
      const old = before.get(ch.documentId);
      const from = old ? this.dirOf(before, ch.documentId) : null;
      const to = this.dirOf(after, ch.documentId);
      if (old && !old.removed) tree = removeAt(tree, `${from}.${old.ext}`.split('/'));
      if (from && from !== to) {
        // ponytail: one move per subtree per commit, which is all a server write makes;
        // re-derive the subtree from state when phase 4's pushes nest moves.
        const sub = getAt(tree, from.split('/'));
        if (sub && typeof sub === 'object') tree = setAt(removeAt(tree, from.split('/')), to.split('/'), sub);
      }
      if (!ch.removed) {
        const blob = this.blobOf(ch);
        this.freshBlobs.add(blob);
        tree = setAt(tree, `${to}.${ch.ext}`.split('/'), blob);
      }
    }
    this.trees.set(c.id, tree);
    const head = `tree ${this.hashDir(tree)}\n` + ps.map((p) => `parent ${this.sha.get(p)}\n`).join('');
    this.sha.set(c.id, this.put('commit', Buffer.concat([Buffer.from(head), c.header])));
  }
}

const ID_KEY = 'knowledge-id';

/**
 * A page body as served: the id line put in as a web-written revision gets it
 * (docs/features/71 "The tree mapping"). The first frontmatter key of a
 * markdown page, the first line of a YAML spec, the first member of a JSON one.
 * Bytes in, bytes out: nothing but the inserted line changes.
 */
export function withIdLine(documentId: string, body: Buffer, ext: PageExt): Buffer {
  const insert = (offset: number, text: string) =>
    Buffer.concat([body.subarray(0, offset), Buffer.from(text), body.subarray(offset)]);
  if (ext === 'yaml') return insert(0, `x-${ID_KEY}: ${documentId}\n`);
  if (ext === 'json') {
    const open = body.indexOf('{');
    if (open < 0) return body;
    const empty = /^\s*\}/.test(body.subarray(open + 1, open + 64).toString('latin1'));
    return insert(open + 1, `\n  "x-${ID_KEY}": "${documentId}"${empty ? '\n' : ','}`);
  }
  const fence = /^---(\r?\n)/.exec(body.subarray(0, 5).toString('latin1'));
  if (fence) return insert(fence[0].length, `${ID_KEY}: ${documentId}${fence[1]}`);
  return insert(0, `---\n${ID_KEY}: ${documentId}\n---\n`);
}
