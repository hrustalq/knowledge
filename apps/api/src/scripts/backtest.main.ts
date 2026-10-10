import { NestFactory } from '@nestjs/core';
import { createWriteStream, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackBacktestCase, FeedbackCaseScore, FeedbackMetrics } from '@knowledge/contracts';
import { scoreFeedbackCase, summarizeFeedbackScores } from '@knowledge/contracts';
import { backtestDir } from '@knowledge/observability';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import type { SearchDto } from '../search/search.dto.js';
import { EXPORT_MAX_ROWS, FeedbackDatasetService } from '../feedback/feedback-dataset.service.js';

/**
 * Retrieval and pipeline backtest.
 *
 * The September measurement that found recall@1 = 4.2% was a scratchpad script
 * that no longer exists, so the number cannot be reproduced or compared against.
 * This is that measurement, in the repo.
 *
 *   make backtest ARGS="--generate --limit 120"                       known-item retrieval quality
 *   make backtest ARGS="--report"                                     aggregate the recorded stream
 *   make backtest ARGS="--export-feedback --workspace <id> --out f"   votes → labelled dataset (NDJSON)
 *   make backtest ARGS="--feedback f.ndjson --k 10"                   replay that dataset through search
 *
 * The split is not arbitrary. **Recall needs ground truth.** The generator
 * makes its own: it issues each document's own title as a query and knows which
 * document should come back. The recorded stream carries no notion of a correct
 * answer, so --report can only answer questions of volume and latency — which
 * is most of what you want day to day, and all of what production traffic can
 * tell you on its own. Human feedback (docs/features/38, phase 5) is the ground
 * truth production *can* give: an up-vote names the pages that answered, a
 * "wrong" or "irrelevant sources" down-vote names the pages that did not, and a
 * report that ended in a merged fix names the page that answers now.
 * --export-feedback turns those rows into FeedbackBacktestCase lines — the same
 * lines GET /v1/ai/feedback/export streams — and --feedback replays them, so a
 * retrieval change is measured against what real people asked.
 */

const DEMO_WORKSPACE = '11111111-1111-4111-8111-111111111111';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function summarize(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number) => percentile(sorted, q).toFixed(1);
  return `${label.padEnd(22)} n=${String(values.length).padEnd(6)} p50=${p(50).padStart(9)}ms  p95=${p(95).padStart(9)}ms  max=${p(100).padStart(9)}ms`;
}

/** Known-item retrieval: each document's own title, answered by that document. */
async function generate(): Promise<void> {
  const workspaceId = option('--workspace', DEMO_WORKSPACE);
  const limit = Number(option('--limit', '120'));
  const k = Number(option('--k', '10'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const prisma = app.get(PrismaService);
  const search = app.get(SearchService);

  const docs = await prisma.document.findMany({
    where: { workspaceId },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  if (docs.length === 0) {
    console.error(`No documents in workspace ${workspaceId} — nothing to measure.`);
    await app.close();
    process.exit(1);
  }

  let hitAt1 = 0;
  let hitAtK = 0;
  let reciprocalRankSum = 0;
  let missed = 0;

  for (const doc of docs) {
    const dto = { workspaceId, query: doc.title, limit: k } as SearchDto;
    const { results } = await search.search(dto);
    const rank = results.findIndex((r) => r.documentId === doc.id);
    if (rank === 0) hitAt1 += 1;
    if (rank >= 0) {
      hitAtK += 1;
      reciprocalRankSum += 1 / (rank + 1);
    } else {
      missed += 1;
    }
  }

  const pct = (n: number) => ((n / docs.length) * 100).toFixed(1);
  console.log('');
  console.log(`known-item retrieval — workspace ${workspaceId}`);
  console.log(`queries              ${docs.length} (each document's own title)`);
  console.log(`recall@1             ${pct(hitAt1)}%  (${hitAt1}/${docs.length})`);
  console.log(`recall@${k}${String(k).length === 1 ? ' ' : ''}            ${pct(hitAtK)}%  (${hitAtK}/${docs.length})`);
  console.log(`MRR@${k}               ${(reciprocalRankSum / docs.length).toFixed(4)}`);
  console.log(`not in top ${k}        ${missed}`);
  console.log('');
  console.log('Every query above also wrote a search.executed event, so `--report`');
  console.log('will show where the time went.');

  await app.close();
  // BullMQ/ioredis keep handles open — the generate-openapi entrypoint exits
  // explicitly for the same reason.
  process.exit(0);
}

/** Aggregate the recorded stream: volumes and latencies, no ground truth needed. */
function report(): void {
  const dir = backtestDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('ops-') && f.endsWith('.jsonl'));
  } catch {
    console.error(`No log directory at ${dir}. Run the app with OPS_JSONL_ENABLED=true first.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No ops-*.jsonl in ${dir}.`);
    process.exit(1);
  }

  const http: number[] = [];
  const httpByStatus = new Map<number, number>();
  const searchTotal: number[] = [];
  const searchVector: number[] = [];
  const searchFulltext: number[] = [];
  const emptySearches: number[] = [];
  const aiCalls: number[] = [];
  let aiFailures = 0;
  const ingestTotal: number[] = [];
  const ingestSteps = new Map<string, number[]>();
  let ingestFailures = 0;
  let unparsable = 0;

  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        unparsable += 1;
        continue;
      }
      const ms = Number(e.durationMs ?? 0);
      switch (e.kind) {
        case 'http.request': {
          http.push(ms);
          const status = Number(e.status ?? 0);
          httpByStatus.set(status, (httpByStatus.get(status) ?? 0) + 1);
          break;
        }
        case 'search.executed': {
          searchTotal.push(ms);
          if (typeof e.vectorMs === 'number') searchVector.push(e.vectorMs);
          if (typeof e.fulltextMs === 'number') searchFulltext.push(e.fulltextMs);
          if (Array.isArray(e.results) && e.results.length === 0) emptySearches.push(ms);
          break;
        }
        case 'ai.call': {
          aiCalls.push(ms);
          if (e.ok === false) aiFailures += 1;
          break;
        }
        case 'ingest.step': {
          ingestTotal.push(ms);
          if (e.ok === false) ingestFailures += 1;
          for (const s of (e.steps ?? []) as Array<{ step: string; ms: number }>) {
            ingestSteps.set(s.step, [...(ingestSteps.get(s.step) ?? []), s.ms]);
          }
          break;
        }
      }
    }
  }

  console.log('');
  console.log(`backtest report — ${files.length} file(s) in ${dir}`);
  if (unparsable > 0) console.log(`  (${unparsable} unparsable line(s) skipped)`);
  console.log('');

  if (http.length) {
    console.log(summarize('http.request', http));
    const statuses = [...httpByStatus.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`  by status            ${statuses.map(([s, n]) => `${s}:${n}`).join('  ')}`);
  }
  if (searchTotal.length) {
    console.log(summarize('search total', searchTotal));
    if (searchVector.length) console.log(summarize('  vector leg', searchVector));
    if (searchFulltext.length) console.log(summarize('  fulltext leg', searchFulltext));
    // An empty result set is a retrieval failure that returns 200, which is why
    // it needs counting separately — no error rate will ever show it.
    console.log(`  returned nothing     ${emptySearches.length}/${searchTotal.length}`);
  }
  if (aiCalls.length) {
    console.log(summarize('ai.call', aiCalls));
    console.log(`  failed               ${aiFailures}/${aiCalls.length}`);
  }
  if (ingestTotal.length) {
    console.log(summarize('ingest total', ingestTotal));
    for (const [step, values] of ingestSteps) console.log(summarize(`  ${step}`, values));
    console.log(`  failed               ${ingestFailures}/${ingestTotal.length}`);
  }
  console.log('');
}

/** Votes → the labelled dataset, read straight from PostgreSQL, one JSON line per usable vote. */
async function exportFeedback(): Promise<void> {
  const workspaceId = option('--workspace', DEMO_WORKSPACE);
  const out = option('--out', '');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  const dataset = app.get(FeedbackDatasetService);
  const sink = out ? createWriteStream(out, { encoding: 'utf8' }) : process.stdout;
  const stream = dataset.cases(workspaceId, { from: option('--from', '') || undefined, to: option('--to', '') || undefined });
  let written = 0;
  let next = await stream.next();
  while (!next.done) {
    sink.write(`${JSON.stringify(next.value)}\n`);
    written += 1;
    next = await stream.next();
  }
  if (out) await new Promise<void>((resolve, reject) => sink.end((e?: Error | null) => (e ? reject(e) : resolve())));
  console.error(`feedback dataset — workspace ${workspaceId}: ${written} case(s) from ${next.value.read} vote(s)${out ? ` → ${out}` : ''}`);
  if (next.value.truncated) console.error(`  stopped at the ${EXPORT_MAX_ROWS}-vote bound; narrow the window with --from / --to`);
  if (written === 0) console.error('  (no vote cited a page, or no vote blamed its pages — nothing to replay)');
  await app.close();
  process.exit(0);
}

function readCases(file: string): FeedbackBacktestCase[] {
  const cases: FeedbackBacktestCase[] = [];
  let bad = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as FeedbackBacktestCase;
      if (typeof c.query === 'string' && Array.isArray(c.expectedDocumentIds) && Array.isArray(c.rejectedDocumentIds)) cases.push(c);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) console.error(`  (${bad} unparsable line(s) skipped)`);
  return cases;
}

function metricsLine(label: string, m: FeedbackMetrics): string {
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1).padStart(5)}%` : '   n/a');
  return (
    `${label.padEnd(24)} n=${String(m.cases).padEnd(5)} ` +
    `recall@1=${pct(m.hitAt1, m.withExpected)}  recall@k=${pct(m.hitAtK, m.withExpected)}  ` +
    `MRR=${m.withExpected ? m.mrr.toFixed(4) : '   n/a'}  (${m.withExpected} labelled)  ` +
    `rejected-in-top-k=${pct(m.rejectedInTopK, m.withRejected)} (${m.withRejected} labelled)`
  );
}

/** Replay every case through SearchService.search and score it against its labels, split by surface and reason. */
async function replayFeedback(): Promise<void> {
  const file = option('--feedback', '');
  const k = Number(option('--k', '10'));
  const cases = readCases(file);
  if (cases.length === 0) {
    console.error(`No cases in ${file}. Export one with --export-feedback first.`);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  const search = app.get(SearchService);

  const all: FeedbackCaseScore[] = [];
  const bySurface = new Map<string, FeedbackCaseScore[]>();
  const byReason = new Map<string, FeedbackCaseScore[]>();
  for (const c of cases) {
    const dto = { workspaceId: c.workspaceId, query: c.query, limit: k } as SearchDto;
    const { results } = await search.search(dto);
    const score = scoreFeedbackCase(c, results.map((r) => r.documentId), k);
    all.push(score);
    bySurface.set(c.surface, [...(bySurface.get(c.surface) ?? []), score]);
    const reason = c.rating === 'up' ? 'up' : `down:${c.reason ?? 'none'}`;
    byReason.set(reason, [...(byReason.get(reason) ?? []), score]);
  }

  console.log('');
  console.log(`feedback replay — ${file}, k=${k}`);
  console.log(metricsLine('all', summarizeFeedbackScores(all)));
  console.log('by surface');
  for (const [s, scores] of [...bySurface.entries()].sort()) console.log(metricsLine(`  ${s}`, summarizeFeedbackScores(scores)));
  console.log('by rating / reason');
  for (const [r, scores] of [...byReason.entries()].sort()) console.log(metricsLine(`  ${r}`, summarizeFeedbackScores(scores)));
  console.log('');
  console.log('recall@1 / recall@k / MRR are over cases with expected pages; rejected-in-top-k over');
  console.log('cases with rejected pages — a case can carry both, one, or (never exported) neither.');

  await app.close();
  process.exit(0);
}

if (flag('--generate')) {
  await generate();
} else if (flag('--export-feedback')) {
  await exportFeedback();
} else if (flag('--feedback')) {
  await replayFeedback();
} else {
  report();
}
