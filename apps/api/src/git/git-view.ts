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

  /** Every page this state holds an entry for. */
  documents(): Set<string> {
    const out = this.parent?.documents() ?? new Set<string>();
    for (const k of this.delta.keys()) out.add(k);
    return out;
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

  /** Take back the last `ids.length` commits `add` appended (a trial render). */
  drop(ids: string[], heads: Map<string, string>): void {
    this.commits.length -= ids.length;
    for (const id of ids) {
      this.byId.delete(id);
      this.states.delete(id);
    }
    this.heads.clear();
    for (const [k, v] of heads) this.heads.set(k, v);
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
    private blobOf: (change: ModelChange) => string,
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

  /** The kept commit a SHA of this view names, if any: what a push's parent line means. */
  idOf(sha: string): string | null {
    for (const [id, s] of this.sha) if (s === sha) return id;
    return null;
  }

  /** The tree of kept commit `id` as `path -> page state`: what a push's diff against it touches. */
  index(id: string | null): Map<string, ModelChange> {
    const out = new Map<string, ModelChange>();
    if (id == null) return out;
    const state = this.model.stateOf(id);
    for (const doc of state.documents()) {
      const e = state.get(doc)!;
      if (e.removed || !this.visibility.documents.has(doc) || !this.sees(e)) continue;
      out.set(`${this.dirOf(state, doc)}.${e.ext}`, e);
    }
    return out;
  }

  /**
   * The SHAs `commits` would render to here, appended after everything
   * rendered so far, and then taken back: reproduce-or-refuse for a push
   * (docs/features/71 invariant 1), on top of the cached parent trees.
   * `blobs` names the blob of each change these commits add.
   */
  trial(commits: ModelCommit[], blobs: Map<string, string>, newDocuments: string[] = []): (string | null)[] {
    this.advance();
    // Pages the push creates are the pusher's to see.
    const documents = this.visibility.documents as Set<string>;
    const added = newDocuments.filter((d) => !documents.has(d));
    for (const d of added) documents.add(d);
    const heads = new Map(this.model.heads);
    const saved = { next: this.next, keptBranches: new Set(this.keptBranches), fresh: this.fresh, freshBlobs: this.freshBlobs, blobOf: this.blobOf };
    const blobOf = saved.blobOf;
    this.fresh = new Map();
    this.freshBlobs = new Set();
    this.blobOf = (ch) => blobs.get(ch.revisionId) ?? blobOf(ch);
    try {
      for (const c of commits) this.model.add(c);
      this.advance();
      return commits.map((c) => this.shaOf(c.id));
    } finally {
      const ids = commits.map((c) => c.id);
      for (const id of ids) {
        this.mapped.delete(id);
        this.kept.delete(id);
        this.sha.delete(id);
        this.trees.delete(id);
      }
      this.model.drop(ids, heads);
      Object.assign(this, saved);
      for (const d of added) documents.delete(d);
    }
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

  /** Whether two visible pages moved in one commit, one inside the other's directory before or after. */
  private nestedMoves(visible: ModelChange[], before: State, after: State): boolean {
    const moves = visible.flatMap((ch) => {
      if (!before.get(ch.documentId)) return [];
      const from = this.dirOf(before, ch.documentId);
      const to = this.dirOf(after, ch.documentId);
      return from === to ? [] : [{ from, to }];
    });
    return moves.some((m) => moves.some((o) => o !== m && (m.from.startsWith(`${o.from}/`) || m.to.startsWith(`${o.to}/`))));
  }

  /** The whole tree a state places in view. */
  private fromState(state: State): Dir {
    let tree = EMPTY_DIR;
    for (const doc of state.documents()) {
      const e = state.get(doc)!;
      if (e.removed || !this.visibility.documents.has(doc) || !this.sees(e)) continue;
      const blob = this.blobOf(e);
      this.freshBlobs.add(blob);
      tree = setAt(tree, `${this.dirOf(state, doc)}.${e.ext}`.split('/'), blob);
    }
    return tree;
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
    // A pushed commit can move a page and something under it at once, which
    // the per-change surgery below cannot express: such a commit's tree is
    // re-derived from state. No server write nests moves, so no stored
    // commit's SHA depends on which of the two ran.
    if (this.nestedMoves(visible, before, after)) tree = this.fromState(after);
    else {
      // Every old file goes first, then directories move, then files land: a
      // push can archive `a.md` and move `b.md` onto its path in one commit,
      // and change rows come back from the database in no particular order.
      const placed = visible.map((ch) => {
        const old = before.get(ch.documentId);
        return { ch, old, from: old ? this.dirOf(before, ch.documentId) : null, to: this.dirOf(after, ch.documentId) };
      });
      for (const { old, from } of placed) if (old && !old.removed) tree = removeAt(tree, `${from}.${old.ext}`.split('/'));
      for (const { from, to } of placed) {
        if (!from || from === to) continue;
        const sub = getAt(tree, from.split('/'));
        if (sub && typeof sub === 'object') tree = setAt(removeAt(tree, from.split('/')), to.split('/'), sub);
      }
      for (const { ch, to } of placed) {
        if (ch.removed) continue;
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
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Bytes a push's id line occupied: inserted at `offset` of the stored body, it gives the pushed blob back. */
export interface IdLine {
  offset: number;
  text: string;
}

/**
 * A page body as served: the id line put in as a web-written revision gets it
 * (docs/features/71 "The tree mapping"). The first frontmatter key of a
 * markdown page, the first line of a YAML spec, the first member of a JSON one.
 * Bytes in, bytes out: nothing but the inserted line changes. A pushed
 * revision's own `idLine` replaces the canonical one, `text: ""` included.
 */
export function withIdLine(documentId: string, body: Buffer, ext: PageExt, idLine?: IdLine | null): Buffer {
  const insert = (offset: number, text: string) =>
    Buffer.concat([body.subarray(0, offset), Buffer.from(text), body.subarray(offset)]);
  if (idLine) return insert(idLine.offset, idLine.text);
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

/**
 * The inverse, for a pushed blob: find its id line, take it out, and record
 * exactly what was taken and where, so `withIdLine(id, body, ext, idLine)`
 * gives the blob back byte for byte however the person laid it out. Looked
 * for where `withIdLine` puts it: a line of a markdown file's leading
 * frontmatter (a block holding nothing else goes with it), a top-level line
 * of a YAML spec, the first member of a JSON one. Elsewhere it is content.
 */
export function stripIdLine(blob: Buffer, ext: PageExt): { body: Buffer; idLine: IdLine; id: string | null } {
  const text = blob.toString('latin1');
  let m: { start: number; end: number; id: string } | null = null;
  if (ext === 'json') {
    const hit = new RegExp(`^(\\s*\\{)(\\s*"x-${ID_KEY}"\\s*:\\s*"(${UUID})"\\s*,?)`).exec(text);
    if (hit) m = { start: hit[1].length, end: hit[0].length, id: hit[3] };
  } else if (ext === 'yaml') {
    const hit = new RegExp(`^x-${ID_KEY}:[ \\t]*(${UUID})[ \\t]*\\r?\\n`, 'm').exec(text);
    if (hit) m = { start: hit.index, end: hit.index + hit[0].length, id: hit[1] };
  } else {
    const open = /^---\r?\n/.exec(text);
    const close = open && /^---[ \t]*(\r?\n|$)/m.exec(text.slice(open[0].length));
    if (open && close) {
      const fm = text.slice(open[0].length, open[0].length + close.index);
      const hit = new RegExp(`^${ID_KEY}:[ \\t]*(${UUID})[ \\t]*\\r?\\n`, 'm').exec(fm);
      if (hit) {
        const start = open[0].length + hit.index;
        m = { start, end: start + hit[0].length, id: hit[1] };
        // The block held the id alone: it goes too, as `withIdLine` adds it to a page with none.
        if (hit[0].length === fm.length) m = { start: 0, end: open[0].length + close.index + close[0].length, id: hit[1] };
      }
    }
  }
  if (!m) return { body: blob, idLine: { offset: 0, text: '' }, id: null };
  return {
    body: Buffer.concat([blob.subarray(0, m.start), blob.subarray(m.end)]),
    idLine: { offset: m.start, text: blob.subarray(m.start, m.end).toString('utf8') },
    id: m.id.toLowerCase(),
  };
}
