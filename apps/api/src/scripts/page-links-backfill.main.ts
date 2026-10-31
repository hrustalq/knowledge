import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import matter from 'gray-matter';
import { isApiSpecKind, isTestFixtureKind } from '@knowledge/contracts';
import { BootstrapModule } from '../config/bootstrap.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageService } from '../storage/storage.service.js';
import type { Env } from '../config/env.js';
import { pageLinkTargets, replacePageLinks } from '../ingestion/page-links.js';

/**
 * One-time fill of `page_links` (#673) for pages indexed before it existed.
 *
 * Per document: read the indexed default-branch head's markdown and write its
 * links, exactly as ingestion does after every head. A head not yet indexed is
 * skipped — its job writes the links when it lands. Spec and fixture
 * documents are skipped too: their body is a projection, re-made on their next
 * index.
 *
 *   make page-links-backfill                          every workspace
 *   make page-links-backfill ARGS="--workspace <id>"  one workspace
 *   make page-links-backfill ARGS="--dry-run"         count only
 *
 * Idempotent, and safe alongside a running worker: the write is the same
 * head-guarded replace, so whichever runs last writes the current head.
 */

@Module({ imports: [BootstrapModule, PrismaModule, StorageModule] })
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
  const storage = app.get(StorageService);
  const webBaseUrl = app.get(ConfigService<Env, true>).get('WEB_BASE_URL', { infer: true });

  const docs = await prisma.document.findMany({
    where: workspaceId ? { workspaceId } : {},
    select: { id: true, workspaceId: true, kind: true, defaultBranch: true, branches: { select: { name: true, headRevisionId: true } } },
  });
  let written = 0;
  let links = 0;
  let skipped = 0;
  let failed = 0;
  for (const doc of docs) {
    const headId = doc.branches.find((b) => b.name === doc.defaultBranch)?.headRevisionId;
    const head = headId
      ? await prisma.documentRevision.findUnique({ where: { id: headId }, select: { id: true, status: true, s3Key: true } })
      : null;
    if (!head || head.status !== 'indexed' || isApiSpecKind(doc.kind) || isTestFixtureKind(doc.kind)) {
      skipped += 1;
      continue;
    }
    try {
      const found = pageLinkTargets(matter(await storage.getObjectText(head.s3Key)).content, webBaseUrl, doc.id);
      links += found.length;
      if (dryRun) continue;
      if (await replacePageLinks(prisma, { workspaceId: doc.workspaceId, documentId: doc.id, revisionId: head.id, links: found })) {
        written += 1;
      } else skipped += 1;
    } catch (e) {
      failed += 1;
      console.error(`document ${doc.id}: ${(e as Error).message}`);
    }
  }

  console.log(
    `${dryRun ? '[dry run] ' : ''}${docs.length} document(s): ${written} written, ${links} link(s) found, ` +
      `${skipped} skipped (no indexed head, a spec or fixture, or the head moved), ${failed} failed.`,
  );
  await app.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
