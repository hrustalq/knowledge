import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorRun } from '@prisma/client';
import {
  CHANGELOG_HUB_KEY,
  CHANGELOG_UNRELEASED_KEY,
  WIKI_CONFIG_PATH,
  changelogTagOf,
  effectiveWikiConfig,
  isWikiUnitKey,
  wikiAutoRegenerate,
  wikiDelivery,
  type ListReleasesResponse,
  type ReleaseNoteInfo,
  type RepoWikiInfo,
  type RepoWikiSection,
  type WikiSection,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { listTags, readRepoFile, sortTagsByVersion } from './adapters/repo-history.js';
import { resolveBranch } from './adapters/repo-archive.js';
import { steeringFromText } from './adapters/wiki-steering.js';
import { ConnectorsService } from './connectors.service.js';

/**
 * The repo wiki's read side and its one write (docs/features/46).
 *
 * Controller-free, so the REST routes and the MCP tools share it. Nothing it
 * reports is stored: the sections are the connector's links, staleness is the
 * last run's items compared with those links, the open merge request is a
 * join, and the steering is read from the host and passed through the same
 * `effectiveWikiConfig` the adapter uses — so the Wiki tab cannot disagree with
 * what a sync will actually do.
 */
@Injectable()
export class RepoWikiService {
  private readonly ceiling: { maxEffort: Env['WIKI_MAX_EFFORT']; maxDiagramNodes: number };
  private readonly maxReleases: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly documents: DocumentsService,
    config: ConfigService<Env, true>,
  ) {
    this.ceiling = {
      maxEffort: config.get('WIKI_MAX_EFFORT', { infer: true }),
      maxDiagramNodes: config.get('WIKI_DIAGRAM_MAX_NODES', { infer: true }),
    };
    this.maxReleases = config.get('CHANGELOG_MAX_RELEASES', { infer: true });
  }

  async info(connectorId: string): Promise<RepoWikiInfo> {
    const row = await this.requireCodebase(connectorId);
    const config = (row.config ?? {}) as Record<string, unknown>;
    const ctx = await this.connectors.contextFor(row, async () => undefined);

    let configUnreadable: string | null = null;
    let text: string | null = null;
    try {
      text = await readRepoFile(ctx, WIKI_CONFIG_PATH, await resolveBranch(ctx));
    } catch (err) {
      configUnreadable = (err as Error).message.slice(0, 300);
    }
    const steering = steeringFromText(text);
    const wiki = effectiveWikiConfig(config, steering.config, this.ceiling);

    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId },
      select: { documentId: true, externalId: true, externalVersion: true, externalTitle: true, lastPulledAt: true },
    });
    const byKey = new Map(links.map((l) => [l.externalId, l]));
    const stale = await this.staleKeys(connectorId, byKey);
    const openMr = await this.openMergeRequests(connectorId);

    const keys: string[] = ['overview'];
    if (wiki.enabled) {
      for (const section of ['architecture', 'data-flow', 'api'] as const) {
        if (wiki.sections.includes(section)) keys.push(`wiki:${section}`);
      }
    }
    if (wiki.changelog.enabled) keys.push(CHANGELOG_HUB_KEY);
    keys.push(...links.map((l) => l.externalId).filter((k) => k.startsWith('module:')).sort());

    const sections: RepoWikiSection[] = keys.map((key) => {
      const link = byKey.get(key);
      return {
        key,
        section: sectionOf(key),
        title: link?.externalTitle ?? key,
        documentId: link?.documentId ?? null,
        version: link?.externalVersion ?? null,
        lastRegeneratedAt: link?.lastPulledAt?.toISOString() ?? null,
        stale: stale.has(key),
        openMergeRequestId: link ? (openMr.get(link.documentId) ?? null) : null,
      };
    });

    return {
      connectorId,
      enabled: wiki.enabled,
      changelog: wiki.changelog.enabled,
      delivery: wikiDelivery(config),
      autoRegenerate: wikiAutoRegenerate(config),
      effort: wiki.effort,
      source: steering.source,
      configErrors: steering.errors,
      configUnreadable,
      sections,
    };
  }

  /**
   * Queue a run that re-derives the wiki, or the named sections of it.
   *
   * `force` forgets the stored input versions of the targeted pages, so they
   * re-derive even though nothing changed upstream — the one way to pick up a
   * new prompt or model without waiting for a commit. A run is scoped only when
   * every targeted page already exists; a page that has never been created
   * needs the walk, which is what files it under the overview.
   */
  async regenerate(
    connectorId: string,
    opts: { sections?: WikiSection[]; force?: boolean; actorId?: string },
  ): Promise<ConnectorRun> {
    const row = await this.requireCodebase(connectorId);
    const config = (row.config ?? {}) as Record<string, unknown>;
    const wiki = effectiveWikiConfig(config, null, this.ceiling);
    if (!wiki.enabled && config.changelog !== 'on') {
      throw new BadRequestException(t('error.wiki.disabled'));
    }

    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId },
      select: { id: true, externalId: true },
    });
    const wanted = opts.sections?.length ? new Set(opts.sections) : null;
    const targeted = wanted ? links.filter((l) => wanted.has(sectionOf(l.externalId))) : links;

    if (opts.force && targeted.length > 0) {
      await this.prisma.connectorLink.updateMany({
        where: { id: { in: targeted.map((l) => l.id) } },
        data: { externalVersion: null },
      });
    }

    const expected = wanted ? expectedKeys(wanted, wiki) : [];
    const allExist = expected.every((key) => links.some((l) => l.externalId === key));
    const scope = wanted && allExist && targeted.length > 0 ? targeted.map((l) => l.externalId) : undefined;
    return this.connectors.createRun(row, 'pull', 'manual', { externalIds: scope, actorId: opts.actorId });
  }

  async releases(connectorId: string): Promise<ListReleasesResponse> {
    const row = await this.requireCodebase(connectorId);
    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId, externalId: { startsWith: 'changelog:' } },
      select: { externalId: true, documentId: true },
    });

    const releases: ReleaseNoteInfo[] = [];
    for (const link of links) {
      const tag = changelogTagOf(link.externalId);
      if (tag === null && link.externalId !== CHANGELOG_UNRELEASED_KEY) continue;
      const frontmatter = await this.documents
        .getContent(link.documentId)
        .then((c) => c.frontmatter ?? {})
        .catch(() => ({}) as Record<string, unknown>);
      releases.push({
        tag,
        date: typeof frontmatter.date === 'string' ? frontmatter.date : null,
        documentId: link.documentId,
        breakingCount: numberOr0(frontmatter.breakingCount),
        suspectedCount: numberOr0(frontmatter.suspectedCount),
        generated: true,
      });
    }

    // Tags the backfill cap left ungenerated are listed too, from the host.
    let error: string | null = null;
    const config = (row.config ?? {}) as Record<string, unknown>;
    const wiki = effectiveWikiConfig(config, null, this.ceiling);
    try {
      const ctx = await this.connectors.contextFor(row, async () => undefined);
      const known = new Set(releases.map((r) => r.tag));
      for (const tag of (await listTags(ctx, wiki.changelog.tagPattern)).slice(this.maxReleases)) {
        if (!known.has(tag.name)) {
          releases.push({ tag: tag.name, date: null, documentId: null, breakingCount: 0, suspectedCount: 0, generated: false });
        }
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }

    const unreleased = releases.filter((r) => r.tag === null);
    const tagged = sortTagsByVersion(releases.filter((r) => r.tag !== null).map((r) => ({ ...r, name: r.tag! })));
    return {
      connectorId,
      releases: [...unreleased, ...tagged.map(({ name: _name, ...r }) => r)],
      error,
    };
  }

  // --- internals ---

  private async requireCodebase(connectorId: string): Promise<Connector> {
    const row = await this.connectors.require(connectorId);
    if (row.kind !== 'codebase') throw new BadRequestException(t('error.wiki.notACodebase', { kind: row.kind }));
    return row;
  }

  /** Units whose last pull saw other inputs than their page was derived from. */
  private async staleKeys(
    connectorId: string,
    links: Map<string, { externalVersion: string | null }>,
  ): Promise<Set<string>> {
    const last = await this.prisma.connectorRun.findFirst({
      where: { connectorId, direction: 'pull', completedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!last) return new Set();
    const items = await this.prisma.connectorRunItem.findMany({
      where: { runId: last.id },
      select: { externalId: true, externalVersion: true },
    });
    return new Set(
      items
        .filter((i) => i.externalVersion && links.has(i.externalId) && links.get(i.externalId)!.externalVersion !== i.externalVersion)
        .map((i) => i.externalId),
    );
  }

  /** Page → its newest open regeneration merge request. */
  private async openMergeRequests(connectorId: string): Promise<Map<string, string>> {
    const conflicts = await this.prisma.connectorConflict.findMany({
      where: { connectorId, reason: 'regenerated', mergeRequestId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { documentId: true, mergeRequestId: true },
    });
    if (conflicts.length === 0) return new Map();
    const open = new Set(
      (
        await this.prisma.mergeRequest.findMany({
          where: { id: { in: conflicts.map((c) => c.mergeRequestId!) }, status: 'open' },
          select: { id: true },
        })
      ).map((m) => m.id),
    );
    const out = new Map<string, string>();
    for (const c of conflicts) {
      if (open.has(c.mergeRequestId!) && !out.has(c.documentId)) out.set(c.documentId, c.mergeRequestId!);
    }
    return out;
  }
}

/** Which wiki section a unit key belongs to. */
export function sectionOf(key: string): WikiSection {
  if (key === 'overview') return 'overview';
  if (key.startsWith('module:')) return 'modules';
  if (key === CHANGELOG_HUB_KEY || key.startsWith('changelog:')) return 'changelog';
  if (isWikiUnitKey(key)) return key.slice('wiki:'.length) as WikiSection;
  return 'overview';
}

/** The keys a section regeneration must find already created to run scoped. */
function expectedKeys(sections: Set<WikiSection>, wiki: ReturnType<typeof effectiveWikiConfig>): string[] {
  const keys: string[] = [];
  if (sections.has('overview')) keys.push('overview');
  for (const s of ['architecture', 'data-flow', 'api'] as const) {
    if (sections.has(s) && wiki.sections.includes(s)) keys.push(`wiki:${s}`);
  }
  if (sections.has('changelog')) keys.push(CHANGELOG_HUB_KEY, CHANGELOG_UNRELEASED_KEY);
  return keys;
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
