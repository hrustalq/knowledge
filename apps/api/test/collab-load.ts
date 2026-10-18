/**
 * Load test for shared drafts (#80 phase 6, docs/features/56 § Load).
 *
 * `--docs` pages × `--peers` peers against one or more running API instances
 * (`--api`, comma-separated; peers are spread round-robin). One typist per
 * page appends 34 characters to the body every 20 ms (~1.7 KB/s) and every
 * peer moves its cursor every 200 ms, for `--seconds`. Prints edit latency to
 * the other peers (same machine, same clock), whether every page converged,
 * and the draft size. Store latency and write volume come from the API's
 * `collab.store` events: run with `OPS_JSONL_ENABLED=true`, then
 * `make backtest ARGS=--report`.
 *
 *   make collab-load ARGS="--docs 50 --peers 5 --seconds 60 --api http://localhost:3000,http://localhost:3001"
 *
 * Needs AUTH_MODE=none (it sends no ticket) and COLLAB_ENABLED=true. It
 * creates its pages in the first project it can find and archives
 * them afterwards. Outside src/ because `@hocuspocus/provider` is a
 * devDependency; Node runs it from source.
 */
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { collabDocName } from '@knowledge/contracts';

const { values } = parseArgs({
  options: {
    docs: { type: 'string', default: '50' },
    peers: { type: 'string', default: '5' },
    seconds: { type: 'string', default: '60' },
    api: { type: 'string', default: 'http://localhost:3000' },
  },
});
const DOCS = Number(values.docs);
const PEERS = Number(values.peers);
const SECONDS = Number(values.seconds);
const APIS = values.api.split(',');
const CHUNK = 'abcdefghijklmnopqrstuvwxyz01234567';
const BODY = 'body';

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${APIS[0]}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (res.headers.get('content-type')?.includes('json') ? res.json() : undefined) as Promise<T>;
}

const percentile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))] ?? 0;

let workspaceId = '';
let projectId = '';
for (const { workspaceId: id } of (await api<{ workspaces: { workspaceId: string }[] }>('/v1/workspaces')).workspaces) {
  const { projects } = await api<{ projects: { projectId: string }[] }>(`/v1/projects?workspaceId=${id}`);
  if (!projects[0]) continue;
  [workspaceId, projectId] = [id, projects[0].projectId];
  break;
}
if (!projectId) throw new Error('No workspace has a project to create the pages in.');
const page = `# Load\n\n${'A paragraph of ordinary page text, long enough to look like one. '.repeat(20)}\n`;

const pages: { documentId: string; name: string }[] = [];
for (let d = 0; d < DOCS; d++) {
  const { documentId } = await api<{ documentId: string }>('/v1/documents', {
    method: 'POST',
    body: { workspaceId, projectId, title: `Collab load ${Date.now()}-${d}`, content: { mode: 'inline', format: 'markdown', text: page } },
  });
  const { branches } = await api<{ branches: { branchId: string; name: string }[] }>(`/v1/documents/${documentId}/branches`);
  pages.push({ documentId, name: collabDocName(workspaceId, documentId, branches[0]!.branchId) });
}

const latencies: number[] = [];
const peers = pages.flatMap(({ name }, d) =>
  Array.from({ length: PEERS }, (_, p) => {
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({ url: `${APIS[(d * PEERS + p) % APIS.length]!.replace(/^http/, 'ws')}/v1/collab`, name, document, token: '' });
    provider.setAwarenessField('user', {});
    document.getMap<number>('load').observe((_event, tr) => {
      if (!tr.local) latencies.push(Date.now() - document.getMap<number>('load').get('t')!);
    });
    const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
    return { d, p, document, provider, synced };
  }),
);
const joinedAt = Date.now();
await Promise.all(peers.map((x) => x.synced));
console.log(`${peers.length} peers on ${DOCS} pages across ${APIS.length} instance(s), joined in ${Date.now() - joinedAt} ms`);

const typists = peers.filter((x) => x.p === 0);
for (const { document } of typists) {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('')]);
  document.getXmlFragment(BODY).push([paragraph]);
}
latencies.length = 0;
let typed = 0;
const startedAt = Date.now();
const typing = setInterval(() => {
  for (const { document } of typists) {
    const fragment = document.getXmlFragment(BODY);
    const text = (fragment.get(fragment.length - 1) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => {
      text.insert(text.length, CHUNK);
      document.getMap<number>('load').set('t', Date.now());
    });
    typed += CHUNK.length;
  }
}, 20);
const cursors = setInterval(() => {
  for (const { provider } of peers) provider.setAwarenessField('cursor', { at: Math.random() });
}, 200);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(typing);
clearInterval(cursors);
await new Promise((r) => setTimeout(r, 2000));

const seconds = (Date.now() - startedAt - 2000) / 1000;
const converged = pages.filter((_, d) => new Set(peers.filter((x) => x.d === d).map((x) => x.document.getXmlFragment(BODY).toString())).size === 1).length;
const sizes = typists.map((x) => Y.encodeStateAsUpdate(x.document).byteLength).sort((a, b) => a - b);
const sorted = latencies.sort((a, b) => a - b);
console.log(`typed ${(typed / 1024 / seconds / DOCS).toFixed(2)} KB/s per page for ${seconds.toFixed(0)} s`);
console.log(`edit latency to other peers  n=${sorted.length}  p50=${percentile(sorted, 50)} ms  p95=${percentile(sorted, 95)} ms  max=${percentile(sorted, 100)} ms`);
console.log(`converged ${converged}/${DOCS} pages`);
console.log(`draft state  p50=${(percentile(sizes, 50) / 1024).toFixed(1)} KB  max=${(percentile(sizes, 100) / 1024).toFixed(1)} KB`);

for (const { provider } of peers) provider.destroy();
for (const { documentId } of pages) await api(`/v1/documents/${documentId}/archive`, { method: 'POST', body: {} });
process.exit(converged === DOCS ? 0 : 1);
