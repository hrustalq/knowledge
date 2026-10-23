import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackBacktestCase, FeedbackCaseScore, FeedbackMetrics, TrustWeights } from '@knowledge/contracts';
import { scoreFeedbackCase, summarizeFeedbackScores } from '@knowledge/contracts';
import { backtestDir } from '@knowledge/observability';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import type { SearchDto } from '../search/search.dto.js';
import type { SearchKnobs, SearchPool } from '../search/ranking.js';
import {
  amendCost,
  dedupeCost,
  HOLDOUT_SHARE,
  KNOWN_ITEM_K,
  MAX_RECALL_DROP,
  TUNED_WEIGHTS,
  tuneSearch,
  tuneThreshold,
  type Replay,
  type ThresholdTuning,
} from '../search/tuning.js';
import { VerificationPolicyService } from '../verification/verification-policy.service.js';
import { CommunitiesService } from '../communities/communities.service.js';
import { AiConfigService } from '../ai/ai-config.service.js';
import { systemScope, type AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { AccessService } from '../auth/access.service.js';
import { EXPORT_MAX_ROWS, FeedbackDatasetService } from '../feedback/feedback-dataset.service.js';
import type { Env } from '../config/env.js';
import { cosine, GraphService, type StoredChunk } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { chunkEmbedText } from '../ingestion/markdown.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import { visibilityWhere } from '../permissions/access-scope.js';
import {
  amendErrors,
  dedupeErrors,
  pickCase,
  probeTexts,
  TEMPLATE_MIN_PAGES,
  splitScores,
  templatedHeadings,
  thresholdGrid,
  type CalibrationCase,
  type CaseScores,
} from '../captures/capture-calibration.js';
import { BUILT_IN_CASES, caseTexts, measure, recommend, type LabelledFinding } from '../learner/learner-calibration.js';
import { BootstrapModule } from '../config/bootstrap.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import type { AgentFinding } from '@knowledge/contracts';

/**
 * Retrieval and pipeline backtest.
 *
 * The September measurement that found recall@1 = 4.2% was a scratchpad script
 * that no longer exists, so the number cannot be reproduced or compared against.
 * This is that measurement, in the repo.
 *
 *   make backtest ARGS="--generate --limit 120"                       known-item retrieval quality
 *   make backtest ARGS="--generate --as <userId>"                     the same, through one person's page restrictions
 *   make backtest ARGS="--generate --with '{"communityPriorWeight":0.5}'"   … under other knobs, for a before/after in one session (#475)
 *   make backtest ARGS="--report"                                     aggregate the recorded stream
 *   make backtest ARGS="--export-feedback --workspace <id> --out f"   votes → labelled dataset (NDJSON)
 *   make backtest ARGS="--feedback f.ndjson --k 10"                   replay that dataset through search
 *   make backtest ARGS="--captures --workspace <id> --limit 200"      capture dedupe/amend thresholds (#234)
 *   EMBEDDINGS_PROVIDER=stub EMBEDDINGS_DIM=768 make backtest ARGS="--captures --reembed"
 *                                                                     the same, for a model the workspace was not indexed with
 *   make backtest ARGS="--captures --verbose"                         … and each case's scores and nearest other page
 *   make backtest ARGS="--learner"                                    learner cluster threshold, built-in labelled findings (#305)
 *   make backtest ARGS="--learner --workspace <id>"                   … plus that workspace's style findings, labelled by rule
 *   make tune ARGS="--workspace <id> [--feedback f.ndjson]"           propose search knobs + capture thresholds (#305), writes nothing
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

/**
 * `--with '<json>'` (#475): override the workspace's effective search knobs
 * for this run only, so a before/after pair runs in one session on the same
 * data — `--with '{"communityPriorWeight":0.5}'`. Nothing is written.
 */
function overrideKnobs(app: INestApplicationContext): Record<string, unknown> {
  const raw = option('--with', '');
  if (!raw) return {};
  const over = JSON.parse(raw) as Record<string, unknown>;
  const policy = app.get(VerificationPolicyService);
  const effective = policy.effective.bind(policy);
  policy.effective = async (workspaceId: string) => ({ ...(await effective(workspaceId)), ...over });
  return over;
}

/**
 * The broad-query set (#475, docs/features/63): every community the scope may
 * see whole, at every level, asked by its own title and answered by its member
 * pages. No model writes the questions, so the set is reproducible; it is only
 * as good as the atlas's titles.
 */
async function broadCases(app: INestApplicationContext, workspaceId: string, scope: AccessScope): Promise<FeedbackBacktestCase[]> {
  const communities = await app.get(CommunitiesService).scored(scope);
  return communities.map((c) => ({
    workspaceId,
    query: c.title,
    surface: 'assistant',
    rating: 'up',
    reason: null,
    expectedDocumentIds: c.members,
    rejectedDocumentIds: [],
    createdAt: '',
  }));
}

/** Share of a community's pages in the top 5, out of as many as could fit: 1 when the top 5 is all members. */
function broadRecallAt5(ranked: readonly string[], members: readonly string[]): number {
  const want = new Set(members);
  return ranked.slice(0, 5).filter((id) => want.has(id)).length / Math.min(5, want.size);
}

/**
 * Known-item retrieval: each document's own title, answered by that document.
 *
 * `--as <userId>` searches with that person's `AccessScope` instead of the
 * unfiltered system scope (#76), and asks only for the pages they can open: a
 * page they cannot see is not a miss, it is out of the question set. Run it
 * once without and once with, on the same workspace, to see what the
 * restriction filter costs a reader it does not exclude.
 */
async function generate(): Promise<void> {
  const workspaceId = option('--workspace', DEMO_WORKSPACE);
  const limit = Number(option('--limit', '120'));
  const k = Number(option('--k', '10'));
  const asUser = option('--as', '');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const prisma = app.get(PrismaService);
  const search = app.get(SearchService);
  const over = overrideKnobs(app);

  let scope: AccessScope = systemScope(workspaceId);
  if (asUser) {
    const principal = await app.get(AccessService).principalFor(asUser, 'en');
    scope = await app.get(PermissionService).scopeFor(principal, workspaceId);
  }

  const all = await prisma.document.findMany({
    where: { workspaceId },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  const visible = await app.get(PermissionService).visibleDocumentIds(scope, all.map((d) => d.id));
  const docs = all.filter((d) => visible.has(d.id));

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
    const { results } = await search.search(dto, scope);
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
  console.log(`known-item retrieval — workspace ${workspaceId}${asUser ? `, as ${asUser}` : ''}`);
  if (asUser) console.log(`hidden from them     ${all.length - docs.length} of ${all.length} (left out of the question set)`);
  console.log(`queries              ${docs.length} (each document's own title)`);
  console.log(`recall@1             ${pct(hitAt1)}%  (${hitAt1}/${docs.length})`);
  console.log(`recall@${k}${String(k).length === 1 ? ' ' : ''}            ${pct(hitAtK)}%  (${hitAtK}/${docs.length})`);
  console.log(`MRR@${k}               ${(reciprocalRankSum / docs.length).toFixed(4)}`);
  console.log(`not in top ${k}        ${missed}`);
  if (Object.keys(over).length) console.log(`knobs overridden     ${JSON.stringify(over)}`);

  // #475: the broad questions, beside the known items, from the same session.
  const broad = await broadCases(app, workspaceId, scope);
  if (broad.length === 0) {
    console.log('broad queries        none (no communities built — run the atlas agent first)');
  } else {
    let sum = 0;
    for (const c of broad) {
      const { results } = await search.search({ workspaceId, query: c.query, limit: k, groupBy: 'page' } as SearchDto, scope);
      sum += broadRecallAt5(results.map((r) => r.documentId), c.expectedDocumentIds);
    }
    console.log(`broad queries        ${broad.length} (each community's own title, every level)`);
    console.log(`broad recall@5       ${((sum / broad.length) * 100).toFixed(1)}%  (share of each community's pages in its top 5)`);
  }
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
  const collabStores: number[] = [];
  const collabBytes: number[] = [];
  const collabRefused = new Map<string, number>();
  let collabPeers = 0;
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
        case 'collab.store': {
          collabStores.push(ms);
          collabBytes.push(Number(e.bytes ?? 0));
          collabPeers = Math.max(collabPeers, Number(e.peers ?? 0));
          if (e.outcome !== 'stored') collabRefused.set(String(e.outcome), (collabRefused.get(String(e.outcome)) ?? 0) + 1);
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
  if (collabStores.length) {
    console.log(summarize('collab.store', collabStores));
    const size = [...collabBytes].sort((a, b) => a - b);
    const kb = (q: number) => `${(percentile(size, q) / 1024).toFixed(1)}KB`;
    console.log(`  draft size           p50=${kb(50)}  p95=${kb(95)}  max=${kb(100)}`);
    console.log(`  most peers on a doc  ${collabPeers}`);
    const refused = [...collabRefused.entries()].map(([outcome, n]) => `${outcome}:${n}`).join('  ');
    console.log(`  refused              ${refused || 'none'}`);
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
    const { results } = await search.search(dto, systemScope(dto.workspaceId));
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

/** Labelled capture probes and their scores — the data both `--captures` and `--tune` read. */
async function captureScores(app: INestApplicationContext, workspaceId: string, limit: number, reembed: boolean) {
  const prisma = app.get(PrismaService);
  const embedder = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const scope = systemScope(workspaceId);
  const pages = await prisma.document.findMany({
    where: { workspaceId, archivedAt: null, ...LISTED_PAGE, AND: [visibilityWhere(scope)] },
    select: { id: true, title: true, projectId: true },
    orderBy: { createdAt: 'asc' },
  });
  const pageById = new Map(pages.map((p) => [p.id, p]));
  let chunks: StoredChunk[] = (await app.get(GraphService).liveChunks(workspaceId, await app.get(PermissionService).documentFilterFor(scope))).filter(
    (c) => pageById.has(c.documentId),
  );
  if (reembed) {
    const texts = chunks.map((c) => chunkEmbedText({ index: c.idx, text: c.text, headingPath: c.headingPath }, pageById.get(c.documentId)!.title));
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) vectors.push(...(await embedder.embedBatch(texts.slice(i, i + 32))));
    chunks = chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
  }

  const byPage = new Map<string, StoredChunk[]>();
  const byProject = new Map<string, StoredChunk[]>();
  for (const c of chunks) {
    byPage.set(c.documentId, [...(byPage.get(c.documentId) ?? []), c]);
    const projectId = pageById.get(c.documentId)!.projectId;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), c]);
  }
  const templated = templatedHeadings(byPage.values());
  const cases: CalibrationCase[] = [];
  for (const page of pages) {
    if (cases.length >= limit) break;
    const picked = pickCase({ documentId: page.id, title: page.title }, byPage.get(page.id) ?? [], templated);
    if (picked) cases.push(picked);
  }
  if (cases.length === 0) {
    return { error: `No page in workspace ${workspaceId} has a removable section and a lead paragraph — nothing to measure.` } as const;
  }

  const texts = cases.flatMap((c) => {
    const t = probeTexts(c);
    return [t.amend, t.sameTitle, t.restatement];
  });
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) vectors.push(...(await embedder.embedBatch(texts.slice(i, i + 16))));
  if (chunks[0] && chunks[0].embedding.length !== vectors[0].length) {
    return { error: `Stored vectors are ${chunks[0].embedding.length}-d, the probes ${vectors[0].length}-d: this workspace was indexed with another model.` } as const;
  }

  const scores: CaseScores[] = cases.map((c, i) => {
    const corpus = byProject.get(pageById.get(c.documentId)!.projectId) ?? [];
    const score = (v: number[]) => corpus.map((ch) => ({ documentId: ch.documentId, headingPath: ch.headingPath, score: cosine(v, ch.embedding) }));
    return {
      amend: splitScores(c, score(vectors[i * 3]), true),
      sameTitle: splitScores(c, score(vectors[i * 3 + 1]), true),
      restatement: splitScores(c, score(vectors[i * 3 + 2]), false),
    };
  });
  return { cases, scores, pages, pageById, templated };
}

/**
 * Capture threshold calibration (#234): labelled probes cut from the
 * workspace's own pages (`captures/capture-calibration.ts` says which), scored
 * the way `CaptureService.similarPages` scores a capture — raw cosine, best
 * chunk per page, pages of the same project — then each class's score
 * distribution and what every candidate threshold would get wrong.
 *
 * By default the probes are embedded with the configured provider and scored
 * against the stored vectors, so the numbers are only meaningful when that
 * provider is the one the workspace was indexed with. `--reembed` embeds the
 * corpus too, with the configured provider and as ingestion would (title and
 * heading path first), so another model — the stub production runs, or a
 * candidate replacement — is measured by pointing the env at it, without
 * reindexing anything. The stale sweeper that would notice the changed model
 * runs only in the worker, so this process cannot schedule a reindex. Reads
 * only.
 */
async function calibrateCaptures(): Promise<void> {
  const workspaceId = option('--workspace', DEMO_WORKSPACE);
  const limit = Number(option('--limit', '200'));
  const reembed = flag('--reembed');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const embedder = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const provider = config.get('EMBEDDINGS_PROVIDER', { infer: true });
  const model = [
    provider,
    provider === 'openai-compatible' ? config.get('EMBEDDINGS_MODEL', { infer: true }) : '',
    `(${embedder.dimension}-d, ${reembed ? 'corpus re-embedded' : 'stored vectors'})`,
  ]
    .filter(Boolean)
    .join(' ');

  const data = await captureScores(app, workspaceId, limit, reembed);
  if ('error' in data) {
    console.error(data.error);
    await app.close();
    process.exit(1);
  }
  const { cases, scores, pages, pageById, templated } = data;

  if (flag('--verbose')) {
    console.log('');
    console.log('own     other   page → section  |  best other page');
    cases.forEach((c, i) => {
      const a = scores[i].amend;
      const other = a.otherDocumentId ? pageById.get(a.otherDocumentId)?.title : '—';
      console.log(`${a.own.toFixed(4)}  ${a.other.toFixed(4)}  ${c.title} → ${c.sectionTitle}  |  ${other}`);
    });
  }

  const dist = (label: string, values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const p = (q: number) => percentile(sorted, q).toFixed(4);
    return `${label.padEnd(30)} ${String(values.length).padStart(4)}  ${p(5)}  ${p(50)}  ${p(95)}`;
  };
  const pct = (share: number) => `${(share * 100).toFixed(1).padStart(5)}%`;
  const lowest = <T extends { threshold: number }>(rows: T[], sum: (r: T) => number) =>
    rows.reduce((best, r) => (sum(r) < sum(best) ? r : best), rows[0]).threshold;

  console.log('');
  console.log(`capture threshold calibration — workspace ${workspaceId}`);
  console.log(`embeddings           ${model}`);
  console.log(`cases                ${cases.length} of ${pages.length} pages (the rest have no removable section or no lead paragraph)`);
  console.log(`template headings    ${templated.size} shared by ${TEMPLATE_MIN_PAGES}+ pages, never sampled`);
  console.log('');
  console.log(`${'class (score against)'.padEnd(30)} ${'n'.padStart(4)}  p5      p50     p95`);
  console.log(dist('amend (own page − section)', scores.map((s) => s.amend.own)));
  console.log(dist('new page (best other page)', scores.map((s) => s.amend.other)));
  console.log(dist('restatement (own page)', scores.map((s) => s.restatement.own)));
  console.log(dist('same-title new fact (own − s.)', scores.map((s) => s.sameTitle.own)));
  console.log('');

  const amendRows = thresholdGrid().map((t) => amendErrors(scores, t));
  const amendSum = (r: (typeof amendRows)[number]) => r.scattered + r.wrongPage + r.falseAmend;
  const bestAmend = lowest(amendRows, amendSum);
  console.log('amend     scattered  wrong-page  false-amend     sum');
  for (const r of amendRows) {
    console.log(`  ${r.threshold.toFixed(2)}     ${pct(r.scattered)}      ${pct(r.wrongPage)}       ${pct(r.falseAmend)}  ${pct(amendSum(r))}${r.threshold === bestAmend ? '  ◀' : ''}`);
  }
  console.log('');
  const dedupeRows = thresholdGrid().map((t) => dedupeErrors(scores, t));
  const dedupeSum = (r: (typeof dedupeRows)[number]) => r.missed + r.dropped;
  const bestDedupe = lowest(dedupeRows, dedupeSum);
  console.log('dedupe    missed  dropped     sum');
  for (const r of dedupeRows) {
    console.log(`  ${r.threshold.toFixed(2)}    ${pct(r.missed)}   ${pct(r.dropped)}  ${pct(dedupeSum(r))}${r.threshold === bestDedupe ? '  ◀' : ''}`);
  }
  console.log('');
  console.log('scattered    an amend case whose best page is under the threshold — it becomes a new page');
  console.log('wrong-page   an amend case another page outranks, at or over the threshold — a section lands elsewhere');
  console.log('false-amend  a new-page case some other page clears — an unrelated page gains a section');
  console.log('missed       a restatement not dropped — a redundant section is proposed');
  console.log('dropped      a new fact under the page\'s own title dropped as a duplicate — knowledge is lost');
  console.log('◀ marks the lowest unweighted sum; the effective amend threshold never exceeds the dedupe one.');

  await app.close();
  process.exit(0);
}

/** The search knobs of a workspace's effective settings. */
function knobsOf(e: SearchKnobs): SearchKnobs {
  return {
    rrfK: e.rrfK,
    minCosine: e.minCosine,
    minCosineShare: e.minCosineShare,
    communityPriorWeight: e.communityPriorWeight,
    communityPriorFloor: e.communityPriorFloor,
    trustWeights: e.trustWeights,
  };
}

/**
 * `make tune` (#305, phase 4): propose the workspace's search knobs and capture
 * thresholds from the backtest's own datasets. Each distinct query is searched
 * once, recording its candidate pool, and every candidate knob setting
 * re-ranks those pools in memory (`search/tuning.ts`), so the stores see one
 * search per query — the ArcadeDB note on running backtests one at a time
 * still applies. Reads only: it prints a report and the PATCH bodies a person
 * may send, appends the same report to tune-<day>.jsonl beside the backtest
 * stream, and writes no setting.
 */
async function tune(): Promise<void> {
  const workspaceId = option('--workspace', DEMO_WORKSPACE);
  const k = Number(option('--k', '10'));
  const limit = Number(option('--limit', '120'));
  const file = option('--feedback', '');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  const prisma = app.get(PrismaService);
  const search = app.get(SearchService);
  const policy = app.get(VerificationPolicyService);
  const scope = systemScope(workspaceId);

  // Objective: the votes, from a saved export or straight from PostgreSQL,
  // and the broad questions (#475), each answered by any of its community's pages.
  const feedback: FeedbackBacktestCase[] = await broadCases(app, workspaceId, scope);
  if (file) feedback.push(...readCases(file).filter((c) => c.workspaceId === workspaceId));
  else {
    const stream = app.get(FeedbackDatasetService).cases(workspaceId, {});
    for (let n = await stream.next(); !n.done; n = await stream.next()) feedback.push(n.value);
  }
  // Constraint: known-item retrieval, as --generate measures it.
  const known: FeedbackBacktestCase[] = (
    await prisma.document.findMany({
      where: { workspaceId, archivedAt: null, ...LISTED_PAGE },
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
  ).map((d) => ({
    workspaceId,
    query: d.title,
    surface: 'assistant',
    rating: 'up',
    reason: null,
    expectedDocumentIds: [d.id],
    rejectedDocumentIds: [],
    createdAt: '',
  }));

  const pools = new Map<string, SearchPool | null>();
  for (const query of new Set([...feedback, ...known].map((c) => c.query))) {
    let pool = null as SearchPool | null;
    await search.search({ workspaceId, query, limit: k } as SearchDto, scope, undefined, (p) => (pool = p));
    pools.set(query, pool);
  }
  const replay = (cases: FeedbackBacktestCase[]): Replay[] => cases.map((c) => ({ case: c, pool: pools.get(c.query) ?? null }));
  const [effective, override] = await Promise.all([policy.effective(workspaceId), policy.override(workspaceId)]);
  const searchTuning = tuneSearch(replay(feedback), replay(known), knobsOf(effective), k);

  const capture = await app.get(AiConfigService).captureSettings(workspaceId);
  const probes = await captureScores(app, workspaceId, Number(option('--capture-limit', '200')), false);
  const keys = 'error' in probes ? [] : probes.cases.map((c) => c.documentId);
  const dedupe = 'error' in probes ? null : tuneThreshold(probes.scores, keys, capture.dedupeThreshold.effective, dedupeCost);
  const amend =
    'error' in probes || !dedupe
      ? null
      : tuneThreshold(probes.scores, keys, capture.amendThreshold.effective, amendCost, dedupe.proposal ?? dedupe.current);

  // The diff, against what applies now. trustWeights replaces the stored map,
  // so the states already overridden ride along.
  const healthPatch: Partial<Omit<SearchKnobs, 'trustWeights'>> & { trustWeights?: Partial<TrustWeights> } = {};
  const proposal = searchTuning.proposal;
  if (proposal) {
    if (proposal.rrfK !== effective.rrfK) healthPatch.rrfK = proposal.rrfK;
    if (proposal.minCosine !== effective.minCosine) healthPatch.minCosine = proposal.minCosine;
    if (proposal.minCosineShare !== effective.minCosineShare) healthPatch.minCosineShare = proposal.minCosineShare;
    if (proposal.communityPriorWeight !== effective.communityPriorWeight) healthPatch.communityPriorWeight = proposal.communityPriorWeight;
    if (proposal.communityPriorFloor !== effective.communityPriorFloor) healthPatch.communityPriorFloor = proposal.communityPriorFloor;
    const changed = Object.entries(proposal.trustWeights).filter(([state, v]) => v !== effective.trustWeights[state as keyof TrustWeights]);
    if (changed.length) healthPatch.trustWeights = { ...override.trustWeights, ...Object.fromEntries(changed) };
  }
  const aiPatch: { captureDedupeThreshold?: number; captureAmendThreshold?: number } = {};
  if (dedupe?.proposal != null) aiPatch.captureDedupeThreshold = dedupe.proposal;
  if (amend?.proposal != null) aiPatch.captureAmendThreshold = amend.proposal;

  const knobs = (kn: SearchKnobs) =>
    [
      `rrfK=${kn.rrfK}`,
      `minCosine=${kn.minCosine}`,
      `minCosineShare=${kn.minCosineShare}`,
      `communityPriorWeight=${kn.communityPriorWeight}`,
      `communityPriorFloor=${kn.communityPriorFloor}`,
      ...TUNED_WEIGHTS.map((s) => `${s}=${kn.trustWeights[s]}`),
    ].join('  ');
  const pct = (share: number) => `${(share * 100).toFixed(1).padStart(5)}%`;
  const threshold = (label: string, t: ThresholdTuning | null) => {
    if (!t) return console.log(`${label.padEnd(8)} skipped: ${'error' in probes ? probes.error : ''}`);
    console.log(`${label.padEnd(8)} current ${t.current.toFixed(2)}  candidate ${t.candidate.toFixed(2)}`);
    for (const [name, split] of [['train', t.train], ['holdout', t.holdout]] as const) {
      console.log(
        `  ${name.padEnd(8)} errors ${pct(split.current.sum)} → ${pct(split.candidate.sum)}   costly ${pct(split.current.guarded)} → ${pct(split.candidate.guarded)}`,
      );
    }
    console.log(`  → ${t.proposal === null ? 'no proposal' : 'propose'}: ${t.reason}`);
  };

  console.log('');
  console.log(`tune — workspace ${workspaceId}, k=${k}, holdout ${HOLDOUT_SHARE * 100}% of each set`);
  console.log(`feedback cases       ${feedback.length}${file ? ` from ${file}` : ' from the votes'} + the broad questions (objective: MRR)`);
  console.log(`known items          ${known.length} page titles (constraint: recall@${KNOWN_ITEM_K} drops ≤ ${MAX_RECALL_DROP * 100} point)`);
  console.log(`trust ranking        ${effective.trustRanking ? 'on' : 'off — the weights cannot move a result'}`);
  console.log('');
  console.log(`current    ${knobs(searchTuning.current)}`);
  console.log(`candidate  ${knobs(searchTuning.candidate)}`);
  for (const [set, splits] of [['feedback', searchTuning.feedback], ['known items', searchTuning.knownItems]] as const) {
    for (const [name, m] of [['train', splits.train], ['holdout', splits.holdout]] as const) {
      console.log(metricsLine(`${set} ${name} current`, m.current));
      console.log(metricsLine(`${set} ${name} candidate`, m.candidate));
    }
  }
  console.log(`  → ${proposal ? 'propose' : 'no proposal'}: ${searchTuning.reason}`);
  console.log('');
  console.log('capture thresholds (costly = dropped new facts for dedupe, false amends for amend: never more than today)');
  threshold('dedupe', dedupe);
  threshold('amend', amend);
  console.log('');

  const patches = [
    ...(Object.keys(healthPatch).length ? [`PATCH /v1/knowledge-health/settings?workspaceId=${workspaceId}  ${JSON.stringify(healthPatch)}`] : []),
    ...(Object.keys(aiPatch).length ? [`PATCH /v1/ai/settings  ${JSON.stringify({ workspaceId, ...aiPatch })}`] : []),
  ];
  if (patches.length === 0) console.log('Nothing to propose. No setting was written.');
  else {
    console.log('Proposed settings — apply by hand after reading the report. Nothing was written:');
    for (const line of patches) console.log(`  ${line}`);
  }

  const out = join(backtestDir(), `tune-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(backtestDir(), { recursive: true });
  appendFileSync(
    out,
    `${JSON.stringify({ ts: new Date().toISOString(), workspaceId, k, feedbackCases: feedback.length, knownItems: known.length, search: searchTuning, dedupe, amend, patches: { health: healthPatch, ai: aiPatch } })}\n`,
  );
  console.log(`Report appended to ${out}`);

  await app.close();
  process.exit(0);
}

/** Only what the learner calibration reads: env, Postgres and the embedding provider. */
@Module({ imports: [BootstrapModule, PrismaModule, EmbeddingModule] })
class LearnerCalibrationModule {}

/**
 * LEARNER_CLUSTER_THRESHOLD calibration (#305): labelled findings — the
 * built-in cases (`learner-calibration.ts`), plus, with `--workspace`, every
 * style finding that workspace's runs recorded, labelled by its rule — are
 * embedded with the configured provider and clustered by the learner's own
 * `clusterFindings` at every threshold of the grid. Reads only, and needs no
 * dismissal history: the question is how close two wordings of one mistake
 * sit in this embedding space, which the cases answer for any model.
 */
async function calibrateLearner(): Promise<void> {
  const workspaceId = option('--workspace', '');
  const minSize = Number(option('--min-size', '3'));
  const app = await NestFactory.createApplicationContext(LearnerCalibrationModule, { logger: false, abortOnError: false });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const embedder = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const provider = config.get('EMBEDDINGS_PROVIDER', { infer: true });
  const model = [provider, provider === 'openai-compatible' ? config.get('EMBEDDINGS_MODEL', { infer: true }) : '', `(${embedder.dimension}-d)`]
    .filter(Boolean)
    .join(' ');

  const cases: LabelledFinding[] = [...BUILT_IN_CASES];
  if (workspaceId) {
    const runs = await app.get(PrismaService).agentRun.findMany({
      where: { workspaceId, status: 'succeeded' },
      select: { findings: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    for (const run of runs) {
      for (const f of (Array.isArray(run.findings) ? run.findings : []) as unknown as AgentFinding[]) {
        if (f?.kind === 'style' && f.ruleId) cases.push({ label: `rule:${f.ruleId}`, kind: f.kind, title: f.title, detail: f.detail ?? '' });
      }
    }
  }
  const texts = caseTexts(cases);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) vectors.push(...(await embedder.embedBatch(texts.slice(i, i + 32))));
  const rows = thresholdGrid(60, 96, 2).map((t) => measure(cases, vectors, t, minSize));
  const best = recommend(rows);
  const current = config.get('LEARNER_CLUSTER_THRESHOLD', { infer: true });
  const pct = (share: number) => `${(share * 100).toFixed(1).padStart(5)}%`;

  console.log('');
  console.log('learner cluster threshold calibration');
  console.log(`embeddings           ${model}`);
  console.log(`cases                ${cases.length} (${BUILT_IN_CASES.length} built in${workspaceId ? `, ${cases.length - BUILT_IN_CASES.length} style findings from ${workspaceId}` : ''})`);
  console.log(`labels               ${new Set(cases.map((c) => c.label)).size}, ${rows[0]?.groups ?? 0} with ${minSize}+ findings (a cluster that could qualify)`);
  console.log('');
  console.log('  t      pair-recall  pair-precision  mixed  absorbed  recovered');
  for (const r of rows) {
    const marks = `${r.threshold === best ? '  ◀' : ''}${r.threshold === current ? '  (LEARNER_CLUSTER_THRESHOLD)' : ''}`;
    console.log(
      `  ${r.threshold.toFixed(2)}   ${pct(r.pairRecall)}       ${pct(r.pairPrecision)}       ${String(r.mixed).padStart(3)}    ${String(r.absorbed).padStart(4)}     ${r.recovered}/${r.groups}${marks}`,
    );
  }
  console.log('');
  console.log('pair-recall     same-mistake pairs at or above t: higher clusters more of a mistake together');
  console.log('pair-precision  pairs at or above t that are one mistake');
  console.log('mixed           clusters holding two mistakes — a learning drafted from both. Must be 0');
  console.log('absorbed        one-off findings swept into a cluster of the qualifying size. Must be 0');
  console.log(`recovered       mistakes with ${minSize}+ of their findings in one cluster — a learning can be drafted`);
  console.log(best === null ? 'No threshold avoids a mixed cluster: this model cannot separate the cases.' : `◀ the lowest threshold with nothing mixed or absorbed that recovers the most: ${best.toFixed(2)}`);

  await app.close();
  process.exit(0);
}

if (flag('--tune')) {
  await tune();
} else if (flag('--learner')) {
  await calibrateLearner();
} else if (flag('--captures')) {
  await calibrateCaptures();
} else if (flag('--generate')) {
  await generate();
} else if (flag('--export-feedback')) {
  await exportFeedback();
} else if (flag('--feedback')) {
  await replayFeedback();
} else {
  report();
}
