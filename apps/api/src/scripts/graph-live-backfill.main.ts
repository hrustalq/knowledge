import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BootstrapModule } from '../config/bootstrap.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphModule } from '../graph/graph.module.js';
import { GraphService } from '../graph/graph.service.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';

/**
 * One-time reconciliation of the live projection (#83).
 *
 * Before #83 every revision's chunks and frontmatter/inferred edges were
 * served by workspace-wide reads — removed text, dropped tags and unmerged
 * branch drafts included. New ingestion now stamps `live` and retires the
 * previous revision, but rows written before that carry no flag and read as
 * live. This stamps them: per document, the indexed head of the default branch
 * becomes live and every other revision becomes history.
 *
 *   make graph-live-backfill                         every workspace
 *   make graph-live-backfill ARGS="--workspace <id>" one workspace
 *   make graph-live-backfill ARGS="--dry-run"        report only
 *
 * Idempotent: a second run rewrites the same flags. Safe alongside a running
 * worker — the processor reconciles the same way after every job, and both
 * converge on the current head.
 */

@Module({ imports: [BootstrapModule, PrismaModule, GraphModule, FulltextModule] })
class BackfillModule {}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const workspaceId = option('--workspace');
  const dryRun = args.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(BackfillModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const graph = app.get(GraphService);
  const fulltext = app.get<FulltextProvider>(FULLTEXT_PROVIDER);

  const docs = await prisma.document.findMany({
    where: workspaceId ? { workspaceId } : {},
    select: {
      id: true,
      workspaceId: true,
      defaultBranch: true,
      branches: { select: { id: true, name: true, headRevisionId: true } },
    },
  });

  let live = 0;
  let fallback = 0;
  let none = 0;
  let failed = 0;
  for (const doc of docs) {
    const branch = doc.branches.find((b) => b.name === doc.defaultBranch);
    // The head when it is indexed. Otherwise the newest indexed revision on
    // the default branch — what readers were served before the head was
    // written, and what the processor will replace once the head indexes.
    const head = branch?.headRevisionId
      ? await prisma.documentRevision.findUnique({ where: { id: branch.headRevisionId }, select: { id: true, status: true } })
      : null;
    let target: string | null = head?.status === 'indexed' ? head.id : null;
    if (!target && branch) {
      const latest = await prisma.documentRevision.findFirst({
        where: { documentId: doc.id, status: 'indexed', OR: [{ branchId: branch.id }, { branchId: null }] },
        orderBy: { revisionNumber: 'desc' },
        select: { id: true },
      });
      target = latest?.id ?? null;
      if (target) fallback += 1;
    }
    if (target) live += 1;
    else none += 1;
    if (dryRun) continue;

    try {
      await graph.setLiveRevision(doc.workspaceId, doc.id, target);
      await fulltext.setLiveRevision(doc.workspaceId, doc.id, target);
    } catch (e) {
      failed += 1;
      console.error(`document ${doc.id}: ${(e as Error).message}`);
    }
  }

  console.log(
    `${dryRun ? '[dry run] ' : ''}${docs.length} document(s): ${live} with a live revision ` +
      `(${fallback} via the newest indexed revision, head not yet indexed), ${none} with none, ${failed} failed.`,
  );
  await app.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
