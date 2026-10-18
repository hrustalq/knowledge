// SPIKE #80: 50 docs × 5 peers across two instances, ~1 KB/s of typing per doc.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
const DOCS = Number(process.env.DOCS ?? 50), PEERS = 5, SECONDS = Number(process.env.SECONDS ?? 60);
const run = Date.now();
// One socket per peer-process per instance, multiplexing docs, as a browser tab would not — each peer its own socket.
const peers = [];
for (let d = 0; d < DOCS; d++) {
  for (let p = 0; p < PEERS; p++) {
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://localhost:${p % 2 ? 3001 : 3000}/v1/collab`, name: `collab:ws:b15a6532-2a1a-4f47-a9e7-37b54b1a0374:load-${run}-${d}`, document, token: 'dev', WebSocketPolyfill: WebSocket,
    });
    peers.push({ d, p, document, provider, synced: new Promise((r) => provider.on('synced', r)) });
  }
}
await Promise.all(peers.map((x) => x.synced));
console.log(`connected ${peers.length} peers on ${DOCS} docs`);
const dup = peers.filter((x) => x.p === 0).map((x) => (x.document.getText('probe').toString().match(/SEED;/g) ?? []).length);
console.log('SEED; occurrences per doc:', JSON.stringify(dup));
// Each doc: one typist at a time sends ~1 KB/s as 20 chars every 20 ms; awareness cursor every 200 ms.
const typists = peers.filter((x) => x.p === 0);
const t0 = Date.now();
let sent = 0;
const typing = setInterval(() => {
  for (const x of typists) { const t = x.document.getText('probe'); t.insert(t.length, 'abcdefghijklmnopqrstuvwxyz01234567'); sent += 34; }
}, 20);
const cursors = setInterval(() => {
  for (const x of peers) x.provider.setAwarenessField('cursor', { at: Math.random() });
}, 200);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(typing); clearInterval(cursors);
await new Promise((r) => setTimeout(r, 1500));
const lens = new Set(peers.filter((x) => x.d === 0).map((x) => x.document.getText('probe').length));
console.log(`typed ${(sent / 1024 / ((Date.now() - t0) / 1000) / DOCS).toFixed(2)} KB/s per doc for ${SECONDS}s; doc0 peers converged: ${lens.size === 1}`);
for (const x of peers) x.provider.destroy();
setTimeout(() => process.exit(0), 500);
