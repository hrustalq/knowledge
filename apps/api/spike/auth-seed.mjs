// SPIKE #80: read-only enforcement, auth-denied reason, seed-once under a 5-client race.
import { HocuspocusProvider } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';

const name = `collab:ws:${process.argv[2]}:race-${Date.now()}`;
const mk = (port, token, n = name) => {
  const document = new Y.Doc();
  const events = {};
  const provider = new HocuspocusProvider({
    url: `ws://localhost:${port}/v1/collab`, name: n, document, token, WebSocketPolyfill: WebSocket,
    onAuthenticationFailed: (d) => (events.denied = d.reason),
    onAuthenticated: (d) => (events.scope = d.scope),
  });
  return { document, provider, events, synced: new Promise((r) => provider.on('synced', r)) };
};

// 5 clients, both instances, all at once, on a doc nobody has loaded.
const peers = [3000, 3001, 3000, 3001, 3000].map((p) => mk(p, 'dev'));
await Promise.all(peers.map((p) => p.synced));
await new Promise((r) => setTimeout(r, 500));
const texts = peers.map((p) => p.document.getText('probe').toString());
console.log('seed race:', JSON.stringify(texts), 'seeded once:', texts.every((t) => t === 'SEED;'));

// Read-only peer writes; nobody else may see it, and it must not persist.
const ro = mk(3001, 'ro');
await ro.synced;
ro.document.getText('probe').insert(0, 'RO-WRITE;');
await new Promise((r) => setTimeout(r, 800));
console.log('ro scope:', ro.events.scope, '| writer sees ro write:', peers[0].document.getText('probe').toString().includes('RO-WRITE'));

const denied = mk(3000, 'deny');
await new Promise((r) => setTimeout(r, 800));
console.log('denied reason:', denied.events.denied, '| synced:', denied.provider.isSynced);
for (const p of [...peers, ro, denied]) p.provider.destroy();
setTimeout(() => process.exit(0), 300);
