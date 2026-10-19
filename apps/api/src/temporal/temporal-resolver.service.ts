import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ResolvedAsOf } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TemporalPoint } from '../graph/temporal.js';
import { t } from '../i18n/t.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns an `asOf` / `knownAt` pair into the instants a graph read uses (#81).
 * `asOf` is an ISO date, `rev:<uuid>` (that revision's finalize time) or
 * `tag:<name>` (a release tag's instant); `knownAt` is an ISO date. Neither
 * given is no point at all: the caller reads the live projection.
 *
 * A revision or tag is looked up in PG under the caller's workspace, and one
 * from another workspace is a 404 — the same answer as one that does not
 * exist, so the lookup cannot be used to probe ids.
 */
@Injectable()
export class TemporalResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(workspaceId: string, asOf?: string, knownAt?: string): Promise<TemporalPoint | undefined> {
    const rawAsOf = asOf?.trim() || undefined;
    const rawKnownAt = knownAt?.trim() || undefined;
    if (!rawAsOf && !rawKnownAt) return undefined;

    const now = Date.now();
    const known = rawKnownAt ? Math.min(parseDate(rawKnownAt), now) : null;
    const { kind, at } = rawAsOf ? await this.instantOf(workspaceId, rawAsOf, now) : { kind: 'now' as const, at: now };
    const resolved: ResolvedAsOf = {
      kind,
      ref: rawAsOf ?? 'now',
      at: new Date(at).toISOString(),
      knownAt: known === null ? null : new Date(known).toISOString(),
    };
    return { at, knownAt: known, resolved };
  }

  private async instantOf(workspaceId: string, raw: string, now: number): Promise<{ kind: ResolvedAsOf['kind']; at: number }> {
    if (raw.startsWith('rev:')) {
      const id = raw.slice(4);
      if (!UUID.test(id)) throw new BadRequestException(t('error.temporal.badAsOf', { value: raw }));
      const revision = await this.prisma.documentRevision.findUnique({
        where: { id },
        select: { finalizedAt: true, document: { select: { workspaceId: true } } },
      });
      if (!revision || revision.document.workspaceId !== workspaceId) {
        throw new NotFoundException(t('error.temporal.revisionNotFound', { id }));
      }
      if (!revision.finalizedAt) throw new BadRequestException(t('error.temporal.revisionNotFinalized', { id }));
      return { kind: 'revision', at: revision.finalizedAt.getTime() };
    }
    if (raw.startsWith('tag:')) {
      const name = raw.slice(4);
      const tag = await this.prisma.releaseTag.findUnique({ where: { workspaceId_name: { workspaceId, name } }, select: { at: true } });
      if (!tag) throw new NotFoundException(t('error.temporal.unknownTag', { name }));
      return { kind: 'tag', at: Math.min(tag.at.getTime(), now) };
    }
    return { kind: 'date', at: Math.min(parseDate(raw), now) };
  }
}

function parseDate(raw: string): number {
  const ms = ISO_DATE.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) throw new BadRequestException(t('error.temporal.badAsOf', { value: raw }));
  return ms;
}
