import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashObject, isValidRefName, writePack, type GitObject } from './git-objects.js';
import { GitView, ProjectModel, stripIdLine, withIdLine, type ModelChange, type Visibility } from './git-view.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8' }).trim();

const header = (msg: string, at: number) =>
  Buffer.from(`author Анна <u@users.noreply.knowledge> ${at} +0000\ncommitter Анна <u@users.noreply.knowledge> ${at} +0000\n\n${msg}\n`);

/** A, B under A, H (hidden from bob), a merged branch, a private draft branch, a move and an archive. */
function project(): ProjectModel {
  const m = new ProjectModel();
  const ch = (doc: string, rev: string, o: Partial<ModelChange> = {}): ModelChange => ({
    documentId: doc, revisionId: rev, branchId: null, parentDocumentId: null, slug: doc.toLowerCase(), removed: false, ext: 'md', ...o,
  });
  let at = 1_800_000_000;
  const add = (id: string, branch: string, parents: string[], changes: ModelChange[]) =>
    m.add({ id, branch, parents, header: header(id, at++), at: new Date(at * 1000), changes });
  add('c1', 'main', [], [ch('A', 'a1'), ch('B', 'b1', { parentDocumentId: 'A' }), ch('H', 'h1')]);
  add('c2', 'main', ['c1'], [ch('B', 'b2', { parentDocumentId: 'A' })]);
  add('c3', 'fix', ['c2'], [ch('A', 'a2')]);
  add('c4', 'main', ['c2'], [ch('H', 'h2')]);
  add('c5', 'main', ['c4', 'c3'], [ch('A', 'a3')]);
  add('c6', 'draft/u', ['c5'], [ch('B', 'b3', { parentDocumentId: 'A', branchId: 'priv' })]);
  add('c7', 'main', ['c5'], [ch('B', 'b2', { slug: 'b2' })]);
  add('c8', 'main', ['c7'], [ch('A', 'a3', { removed: true })]);
  return m;
}

const blobs = new Map<string, Buffer>();
const blobOf = (c: ModelChange) => {
  const body = withIdLine(`${c.documentId}-id`, Buffer.from(`# ${c.revisionId}\n`), c.ext);
  const sha = hashObject('blob', body);
  blobs.set(sha, body);
  return sha;
};

const everyone: Visibility = { documents: new Set(['A', 'B', 'H']), hiddenBranches: new Set() };
const bob: Visibility = { documents: new Set(['A', 'B']), hiddenBranches: new Set(['priv']) };

const dirs: string[] = [];
function render(visibility: Visibility) {
  const view = new GitView(project(), visibility, blobOf).advance();
  const { objects, blobs: used } = view.drain();
  const all: GitObject[] = [...objects.values(), ...[...used].map((sha) => ({ type: 'blob' as const, body: blobs.get(sha)! }))];
  const dir = mkdtempSync(join(tmpdir(), 'git-view-'));
  dirs.push(dir);
  git(dir, 'init', '--bare', '-q');
  execFileSync('git', ['--git-dir', dir, 'index-pack', '--stdin'], { input: writePack(all) });
  const refs = [...view.branchRefs()].map(([b, sha]) => `${sha} refs/heads/${b}\n`).join('');
  writeFileSync(join(dir, 'packed-refs'), refs);
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  return { view, dir };
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('GitView', () => {
  it('renders a history git accepts, with the merge and the tree as it stands now', () => {
    const { dir, view } = render(everyone);
    expect(() => git(dir, 'fsck', '--strict', '--no-dangling')).not.toThrow();
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(['b2.md', 'h.md']);
    expect(git(dir, 'rev-list', '--merges', 'main')).toBe(view.shaOf('c5'));
    expect(git(dir, 'rev-parse', `${view.shaOf('c5')}^2`)).toBe(view.shaOf('c3'));
    expect([...view.branchRefs().keys()].sort()).toEqual(['draft/u', 'fix', 'main']);
    expect(git(dir, 'show', 'main:b2.md')).toBe('---\nknowledge-id: B-id\n---\n# b2');
  });

  it('gives one visible set the same SHAs every time', () => {
    expect(render(everyone).view.shaOf('c8')).toBe(render(everyone).view.shaOf('c8'));
  });

  it('keeps a hidden page and a private branch out of a reader\'s history', () => {
    const { dir, view } = render(bob);
    expect(() => git(dir, 'fsck', '--strict', '--no-dangling')).not.toThrow();
    expect(git(dir, 'log', '--all', '--format=%s', '--', 'h.md')).toBe('');
    expect(git(dir, 'log', '--all', '--format=%s')).not.toMatch(/c4|c6/);
    expect([...view.branchRefs().keys()].sort()).toEqual(['fix', 'main']);
    expect(view.shaOf('c8')).not.toBe(render(everyone).view.shaOf('c8'));
  });

  it('clones over upload-pack', () => {
    const { dir } = render(everyone);
    const work = mkdtempSync(join(tmpdir(), 'git-clone-'));
    dirs.push(work);
    execFileSync('git', ['clone', '-q', `file://${dir}`, join(work, 'c')]);
    expect(execFileSync('git', ['-C', join(work, 'c'), 'ls-files'], { encoding: 'utf8' }).trim()).toBe('b2.md\nh.md');
  });

  it('trial-renders a push as advance would, then takes it back', () => {
    const model = project();
    const view = new GitView(model, everyone, blobOf).advance();
    const c9 = { id: 'c9', branch: 'main', parents: ['c8'], header: header('c9', 1_900_000_000), at: new Date(), changes: [{ documentId: 'N', revisionId: 'n1', branchId: null, parentDocumentId: 'B', slug: 'n', removed: false, ext: 'md' as const }] };
    const [sha] = view.trial([c9], new Map(), ['N']);
    expect(view.shaOf('c9')).toBeNull();
    expect(model.commits).toHaveLength(8);
    expect(model.heads.get('main')).toBe('c8');
    expect(everyone.documents.has('N')).toBe(false);
    model.add(c9);
    const later = new GitView(model, { documents: new Set(['A', 'B', 'H', 'N']), hiddenBranches: new Set() }, blobOf).advance();
    expect(later.shaOf('c9')).toBe(sha);
    expect(later.index('c9').get('b2/n.md')?.documentId).toBe('N');
  });

  it('re-derives the tree of a commit that moves a page and one under it', () => {
    const m = new ProjectModel();
    const ch = (doc: string, o: Partial<ModelChange> = {}): ModelChange => ({
      documentId: doc, revisionId: `${doc}1`, branchId: null, parentDocumentId: null, slug: doc.toLowerCase(), removed: false, ext: 'md', ...o,
    });
    m.add({ id: 'k1', branch: 'main', parents: [], header: header('k1', 1), at: new Date(), changes: [ch('P'), ch('Q', { parentDocumentId: 'P' }), ch('R', { parentDocumentId: 'Q' })] });
    m.add({ id: 'k2', branch: 'main', parents: ['k1'], header: header('k2', 2), at: new Date(), changes: [ch('P', { slug: 'x' }), ch('Q', { parentDocumentId: 'P', slug: 'y' })] });
    const view = new GitView(m, { documents: new Set(['P', 'Q', 'R']), hiddenBranches: new Set() }, blobOf).advance();
    expect([...view.index('k2').keys()].sort()).toEqual(['x.md', 'x/y.md', 'x/y/r.md']);
  });
});

describe('withIdLine', () => {
  it.each([
    ['md', '# T\n', '---\nknowledge-id: X\n---\n# T\n'],
    ['md', '---\ntitle: T\n---\nx', '---\nknowledge-id: X\ntitle: T\n---\nx'],
    ['md', '---\r\ntitle: T\r\n---\r\n', '---\r\nknowledge-id: X\r\ntitle: T\r\n---\r\n'],
    ['yaml', 'openapi: 3.1.0\n', 'x-knowledge-id: X\nopenapi: 3.1.0\n'],
    ['json', '{"openapi":"3.1.0"}', '{\n  "x-knowledge-id": "X","openapi":"3.1.0"}'],
    ['json', '{}', '{\n  "x-knowledge-id": "X"\n}'],
  ] as const)('%s %j', (ext, body, served) => {
    expect(withIdLine('X', Buffer.from(body), ext).toString()).toBe(served);
  });
});

describe('stripIdLine', () => {
  const id = '8c1e0a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f';
  it.each([
    ['md', '# T\n'],
    ['md', '---\ntitle: T\n---\nx'],
    ['md', '---\r\ntitle: T\r\n---\r\n'],
    ['yaml', 'openapi: 3.1.0\n'],
    ['json', '{"openapi":"3.1.0"}'],
    ['json', '{}'],
  ] as const)('takes the canonical line back out of %s %j', (ext, body) => {
    const s = stripIdLine(withIdLine(id, Buffer.from(body), ext), ext);
    expect(s.id).toBe(id);
    expect(s.body.toString()).toBe(body);
  });

  it.each([
    ['md', `---\ntitle: T\nknowledge-id:   ${id.toUpperCase()}  \n---\n# T\n`, '---\ntitle: T\n---\n# T\n'],
    ['md', `---\nknowledge-id: ${id}\n---\n\n# T\n`, '\n# T\n'],
    ['yaml', `openapi: 3.1.0\nx-knowledge-id: ${id}\ninfo: {}\n`, 'openapi: 3.1.0\ninfo: {}\n'],
    ['json', `{ "x-knowledge-id" : "${id}" , "openapi": "3.1.0" }`, '{ "openapi": "3.1.0" }'],
  ] as const)('gives a pushed %s blob back byte for byte: %j', (ext, blob, body) => {
    const s = stripIdLine(Buffer.from(blob), ext);
    expect([s.id, s.body.toString()]).toEqual([id, body]);
    expect(withIdLine(id, s.body, ext, s.idLine).toString()).toBe(blob);
  });

  it('leaves an id outside the frontmatter as content, and serves a file without one as it was', () => {
    const blob = Buffer.from(`# T\n\nknowledge-id: ${id}\n`);
    const s = stripIdLine(blob, 'md');
    expect(s).toMatchObject({ id: null, idLine: { offset: 0, text: '' } });
    expect(withIdLine(id, s.body, 'md', s.idLine).equals(blob)).toBe(true);
  });
});

describe('isValidRefName', () => {
  it.each([
    ['main', true], ['draft/8c1e-2', true], ['фича', true],
    ['a b', false], ['a..b', false], ['.hidden', false], ['x.lock', false], ['a//b', false], ['a/', false], ['@', false], ['a@{1', false], ['v1:2', false],
  ])('%s → %s', (name, ok) => expect(isValidRefName(name)).toBe(ok));
});
