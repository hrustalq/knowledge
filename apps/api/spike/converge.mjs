// SPIKE #80: two providers on two API instances; latency of A's edit reaching B.
import { HocuspocusProvider } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';

const [ws, doc, branch] = process.argv.slice(2);
const name = `collab:${ws}:${doc}:${branch}`;
const N = Number(process.env.N ?? 200);

function client(port) {
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://localhost:${port}/v1/collab`, name, document, token: 'dev',
    WebSocketPolyfill: WebSocket,
  });
  return { document, provider, synced: new Promise((r) => provider.on('synced', r)) };
}

const a = client(3000), b = client(3001);
// The /v1/events/ws gateway must keep working beside /v1/collab.
const live = new WebSocket('ws://localhost:3000/v1/events/ws');
const liveOk = new Promise((r) => live.on('message', (m) => r(String(m))));
live.on('open', () => live.send(JSON.stringify({ type: 'ping' })));

await Promise.all([a.synced, b.synced]);
console.log('live gateway:', await liveOk);
const ta = a.document.getText('probe'), tb = b.document.getText('probe');
const lat = [];
for (let i = 0; i < N; i++) {
  const marker = `m${i};`;
  const t0 = performance.now();
  const seen = new Promise((r) => {
    const f = () => { if (tb.toString().includes(marker)) { tb.unobserve(f); r(); } };
    tb.observe(f);
  });
  ta.insert(ta.length, marker);
  await seen;
  lat.push(performance.now() - t0);
}
lat.sort((x, y) => x - y);
const q = (p) => lat[Math.floor(p * (lat.length - 1))].toFixed(1);
console.log(`cross-instance edits=${N} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(1)}ms`);
console.log('converged:', ta.toString() === tb.toString(), 'len', ta.length);
a.provider.destroy(); b.provider.destroy(); live.close();
setTimeout(() => process.exit(0), 300);
