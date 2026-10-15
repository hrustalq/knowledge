import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Connector } from '@prisma/client';
import type { RepoGuidanceImportResponse } from '@knowledge/contracts';
import { ActivityService } from '../../activity/activity.service.js';
import { SYSTEM_ACTOR } from '../../activity/actor.js';
import { AiSkillsService } from '../../ai/ai-skills.service.js';
import { t, withLocale } from '../../i18n/t.js';
import { asLocale } from '../../i18n/locale.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { downloadRepoArchive, repoSubdir } from '../adapters/repo-archive.js';
import { REPO_CONNECTOR_KINDS } from '../code-research/repo-snapshot.service.js';
import { ConnectorsService } from '../connectors.service.js';
import {
  clipInstructions,
  guidanceSkillName,
  planGuidanceImport,
  readGuidanceFiles,
  type GuidanceFile,
  type GuidanceOp,
} from './repo-guidance.js';

/**
 * Repo guidance import (#70): the `AGENTS.md`, `CLAUDE.md`, `.cursorrules`…
 * of a connected repository become **disabled** skills with provenance.
 *
 * Those files are fetched bytes, so they cross the trust boundary only when an
 * admin enables one; after that a commit can propose new text
 * (`pending_instructions`) but never change what the skill says. The plan is
 * `planGuidanceImport`'s; this applies it.
 *
 * API-side, on purpose: a skill is configuration, attributed to a person — the
 * caller of the manual route, or the connector's creator after a sync. Its own
 * archive download rather than `RepoSnapshotService`: a snapshot keeps the
 * whole tree in memory for the code tools and is filtered to `subdir`, while
 * guidance is read at the repository root too and needs nothing kept.
 */
@Injectable()
export class RepoGuidanceService {
  private readonly logger = new Logger(RepoGuidanceService.name);
  /** One import per connector at a time — a sync event and a click must not both download. */
  private readonly inFlight = new Map<string, Promise<RepoGuidanceImportResponse>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly skills: AiSkillsService,
    private readonly activity: ActivityService,
  ) {}

  /** Whether a connector is one this reads at all — checked before any download. */
  isRepository(row: Pick<Connector, 'kind'>): boolean {
    return REPO_CONNECTOR_KINDS.has(row.kind);
  }

  /**
   * Import one connector's guidance files. `actorId` is the person asking; the
   * sync path passes none, and the connector's creator stands in.
   */
  importFrom(connectorId: string, actorId?: string): Promise<RepoGuidanceImportResponse> {
    const running = this.inFlight.get(connectorId);
    if (running) return running;
    const work = this.run(connectorId, actorId).finally(() => this.inFlight.delete(connectorId));
    this.inFlight.set(connectorId, work);
    return work;
  }

  private async run(connectorId: string, actorId?: string): Promise<RepoGuidanceImportResponse> {
    const row = await this.connectors.require(connectorId);
    if (!this.isRepository(row)) {
      throw new BadRequestException(t('error.connector.guidanceNotARepository', { name: row.name }));
    }

    const ctx = await this.connectors.contextFor(row, async () => undefined);
    const archive = await downloadRepoArchive(ctx);
    const read = readGuidanceFiles(archive.files, repoSubdir(ctx));

    const existing = await this.prisma.aiSkill.findMany({
      where: { workspaceId: row.workspaceId, source: 'repo', sourceConnectorId: row.id },
    });
    const ops = planGuidanceImport(existing, read);

    const result: RepoGuidanceImportResponse = {
      connectorId: row.id,
      found: read.present.size,
      created: 0,
      updated: 0,
      pending: 0,
      removed: 0,
      unchanged: 0,
      truncated: read.files.filter((f) => clipInstructions(f.text).truncated).map((f) => f.path),
      skipped: read.skipped,
    };

    const author = actorId ?? row.createdBy ?? null;
    const locale = actorId ? undefined : await this.localeOf(author);
    const apply = () => this.apply(row, ops, author, result);
    if (locale) await withLocale(locale, apply);
    else await apply();
    result.unchanged = read.files.length - (result.created + result.updated + result.pending);

    const changed = result.created + result.updated + result.pending + result.removed;
    if (changed > 0) {
      this.skills.invalidate(row.workspaceId);
      void this.activity.record({
        workspaceId: row.workspaceId,
        actor: actorId ?? SYSTEM_ACTOR,
        action: 'ai.skill.imported',
        subjectId: row.id,
        metadata: {
          connector: row.name,
          created: result.created,
          updated: result.updated,
          pending: result.pending,
          removed: result.removed,
        },
      });
    }
    this.logger.log(
      `guidance ${row.id} (${row.name}): ${read.present.size} found, +${result.created} ~${result.updated} ` +
        `pending ${result.pending} -${result.removed}`,
    );
    return result;
  }

  /**
   * Ops one at a time rather than in a transaction: they touch different rows,
   * and a skill created by a concurrent import in another process (the unique
   * index refuses the second) is counted unchanged instead of failing the rest.
   */
  private async apply(row: Connector, ops: GuidanceOp[], author: string | null, result: RepoGuidanceImportResponse): Promise<void> {
    const taken = new Set(
      (await this.prisma.aiSkill.findMany({ where: { workspaceId: row.workspaceId }, select: { name: true } })).map((s) => s.name),
    );
    const now = new Date();

    for (const op of ops) {
      switch (op.kind) {
        case 'create': {
          const name = guidanceSkillName(row.name, op.file.path, taken);
          try {
            await this.prisma.aiSkill.create({
              data: {
                workspaceId: row.workspaceId,
                name,
                description: this.describe(row, op.file),
                instructions: op.instructions,
                triggers: [],
                enabled: false,
                createdBy: author,
                source: 'repo',
                sourceConnectorId: row.id,
                sourcePath: op.file.path,
                sourceSha: op.file.sha,
              },
            });
            taken.add(name);
            result.created += 1;
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
          }
          break;
        }
        case 'replace':
          await this.prisma.aiSkill.update({
            where: { id: op.id },
            data: {
              instructions: op.instructions,
              description: this.describe(row, op.file),
              sourceSha: op.file.sha,
              pendingInstructions: null,
              sourceRemovedAt: null,
            },
          });
          result.updated += 1;
          break;
        case 'pending':
          await this.prisma.aiSkill.update({
            where: { id: op.id },
            data: { pendingInstructions: op.instructions, sourceSha: op.file.sha, sourceRemovedAt: null },
          });
          result.pending += 1;
          break;
        case 'settle':
          await this.prisma.aiSkill.update({
            where: { id: op.id },
            data: { pendingInstructions: null, sourceSha: op.file.sha, sourceRemovedAt: null },
          });
          break;
        case 'restore':
          await this.prisma.aiSkill.update({ where: { id: op.id }, data: { sourceRemovedAt: null } });
          break;
        case 'remove':
          // Disabled, not deleted: an admin may have enabled and edited it, and
          // a file that comes back should find the skill it was.
          await this.prisma.aiSkill.update({
            where: { id: op.id },
            data: { enabled: false, pendingInstructions: null, sourceRemovedAt: now },
          });
          result.removed += 1;
          break;
      }
    }
  }

  private describe(row: Connector, file: GuidanceFile): string {
    const { instructions, truncated } = clipInstructions(file.text);
    const text = truncated
      ? t('connector.guidance.skillDescriptionTruncated', {
          connector: row.name,
          path: file.path,
          kept: instructions.length,
          total: file.text.length,
        })
      : t('connector.guidance.skillDescription', { connector: row.name, path: file.path });
    return text.slice(0, 500);
  }

  private async localeOf(userId: string | null) {
    if (!userId) return undefined;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
    return user ? asLocale(user.locale) : undefined;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

