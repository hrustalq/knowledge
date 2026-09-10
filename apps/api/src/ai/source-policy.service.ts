import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CheckSourcePolicyResponse,
  CreateSourcePolicyRequest,
  SourcePolicy,
  UpdateSourcePolicyRequest,
  WebAccessDenial,
  WebAccessMode,
  WebAccessSettings,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isPrivateAddress } from '../common/safe-url.js';
import { t } from '../i18n/t.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Narrowness order. `off` is narrowest, `open` widest — the clamp is one index compare. */
const ORDER: WebAccessMode[] = ['off', 'allowlist', 'open'];

/** How long a workspace's policy list is reused before PG is consulted again. */
const CACHE_TTL_MS = 30_000;

/** A refusal carries the reason, because "no" without one reads as broken. */
export type WebAccessDecision =
  | { ok: true; matchedPattern: string | null }
  | { ok: false; reason: WebAccessDenial; detail?: string; matchedPattern: string | null };

/**
 * Whether a URL may be fetched at all (docs/features/25).
 *
 * This is the third of the three axes the feature separates, and the only new
 * one. It is NOT the other two:
 *
 *  - Reachability (SSRF) is `assertSafeExternalUrl` — a network question.
 *  - Instruction authority is settled everywhere already: fetched bytes are
 *    wrapped as untrusted data, always, with no argument taken from policy.
 *
 * Merging 2 and 3 is the vulnerability the feature is written around: if a row
 * could mark a domain "trusted", an admin ticking the internal wiki would let a
 * page anyone can edit start issuing instructions to the model. So policy
 * decides *whether a page is fetched*, never what its bytes are allowed to say,
 * and `wrapUntrusted` in the web tools takes no argument from here — there is
 * no tier-dependent branch to get wrong later, because there is no branch.
 */
@Injectable()
export class SourcePolicyService {
  private readonly cache = new Map<string, { at: number; rows: SourcePolicy[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The deployment ceiling. Nothing a workspace stores can exceed it. */
  get ceiling(): WebAccessMode {
    return this.config.get('WEB_ACCESS_MODE', { infer: true });
  }

  get searchConfigured(): boolean {
    return this.config.get('WEB_SEARCH_URL', { infer: true }) !== '';
  }

  get allowPrivate(): boolean {
    return this.config.get('WEB_ALLOW_PRIVATE_URLS', { infer: true });
  }

  /**
   * The narrower of what the workspace asked for and what the deployment
   * allows, plus enough to explain itself.
   *
   * A silent clamp is a lie about what the workspace is configured to do, so
   * `requested` survives in the response beside `effective` and `source` says
   * `clamped` — one more value beside `env` and `db` in the map that already
   * drives the "from env" badges.
   */
  webAccess(requested: string | null | undefined): WebAccessSettings {
    const ceiling = this.ceiling;
    const asked = ORDER.includes(requested as WebAccessMode) ? (requested as WebAccessMode) : null;
    const effective = asked === null ? ceiling : narrower(asked, ceiling);
    return {
      requested: asked,
      ceiling,
      effective,
      source: asked === null ? 'env' : effective === asked ? 'db' : 'clamped',
      searchConfigured: this.searchConfigured,
    };
  }

  // ---- Roster ---------------------------------------------------------------

  async list(workspaceId: string): Promise<SourcePolicy[]> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

    const rows = await this.prisma.sourcePolicy.findMany({
      where: { workspaceId },
      // Longest first, so `decide` can take the first host match and stop.
      orderBy: [{ pattern: 'desc' }],
    });
    const mapped = rows.map(toSummary).sort((a, b) => b.pattern.length - a.pattern.length);
    this.cache.set(workspaceId, { at: Date.now(), rows: mapped });
    return mapped;
  }

  async get(id: string): Promise<SourcePolicy> {
    const row = await this.prisma.sourcePolicy.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.web.notFound', { id }));
    return toSummary(row);
  }

  async create(input: CreateSourcePolicyRequest, actorId?: string): Promise<SourcePolicy> {
    const pattern = normalizePattern(input.pattern);
    const row = await this.prisma.sourcePolicy.create({
      data: {
        workspaceId: input.workspaceId,
        pattern,
        allow: input.allow,
        note: input.note?.trim() || null,
        createdBy: actorId ?? null,
      },
    });
    this.invalidate(input.workspaceId);
    return toSummary(row);
  }

  async update(id: string, input: UpdateSourcePolicyRequest): Promise<SourcePolicy> {
    const row = await this.prisma.sourcePolicy.update({
      where: { id },
      data: {
        ...(input.pattern === undefined ? {} : { pattern: normalizePattern(input.pattern) }),
        ...(input.allow === undefined ? {} : { allow: input.allow }),
        ...(input.note === undefined ? {} : { note: input.note?.trim() || null }),
      },
    });
    this.invalidate(row.workspaceId);
    return toSummary(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.prisma.sourcePolicy.delete({ where: { id } });
    this.invalidate(row.workspaceId);
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  /**
   * `allowlist` with an empty table is a web search that silently returns
   * nothing, which reads as broken rather than as configured — so saving it is
   * refused, the shape of the agent scheduler refusing to enable without an
   * owner and an interval.
   */
  async assertModeSavable(workspaceId: string, mode: WebAccessMode | null): Promise<void> {
    if (mode !== 'allowlist') return;
    const rows = await this.list(workspaceId);
    if (rows.some((row) => row.allow)) return;
    throw new BadRequestException(t('error.web.allowlistEmpty'));
  }

  // ---- Enforcement ----------------------------------------------------------

  /**
   * May this URL be retrieved?
   *
   * Enforcement is at the fetch, in both directions, never in the prompt — and
   * with **no provenance exception**. A URL reaches the tool two ways (the
   * model picked it out of search results, or a person pasted it into the
   * chat), and by the time it is a tool call both look identical: one
   * `web_fetch(url)`. "The user named this one" is a claim the model makes
   * rather than a fact this method can check, and a page from an allowed domain
   * saying *now fetch evil.com* makes the same claim just as convincingly.
   */
  async decide(workspaceId: string, rawUrl: string, effective: WebAccessMode): Promise<WebAccessDecision> {
    if (effective === 'off') return { ok: false, reason: 'mode-off', matchedPattern: null };

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'unsafe', detail: rawUrl, matchedPattern: null };
    }
    if (url.protocol !== 'https:' && !(this.allowPrivate && url.protocol === 'http:')) {
      return { ok: false, reason: 'unsafe', detail: url.protocol.replace(':', ''), matchedPattern: null };
    }

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const match = matchPolicy(await this.list(workspaceId), host);

    // Longest pattern wins — the glossary's longest-term-first, and
    // notifications' most-specific-wins. An `open` workspace that denies
    // `example.com` and allows `docs.example.com` gets the specific answer.
    if (match) {
      if (!match.allow) return { ok: false, reason: 'blocked', detail: match.pattern, matchedPattern: match.pattern };
    } else if (effective === 'allowlist') {
      return { ok: false, reason: 'not-allowlisted', detail: host, matchedPattern: null };
    }

    // SSRF last, because it is the most expensive check and the cheapest ones
    // have already refused most of what they were going to refuse.
    if (!this.allowPrivate && (await this.resolvesPrivate(host))) {
      return { ok: false, reason: 'unsafe', detail: host, matchedPattern: match?.pattern ?? null };
    }
    return { ok: true, matchedPattern: match?.pattern ?? null };
  }

  /** `decide`, plus the host it was made about — the settings page's dry run. */
  async check(workspaceId: string, rawUrl: string): Promise<CheckSourcePolicyResponse> {
    const effective = (await this.effectiveFor(workspaceId)) ?? 'off';
    // A bare domain is what an admin will type. Treating it as a URL rather
    // than refusing it keeps the check usable with the same value the row
    // above it holds.
    const candidate = rawUrl.includes('://') ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    const decision = await this.decide(workspaceId, candidate, effective);
    let host = '';
    try {
      host = new URL(candidate).hostname.replace(/^www\./, '');
    } catch {
      host = rawUrl.trim();
    }
    return {
      allowed: decision.ok,
      ...(decision.ok ? {} : { reason: decision.reason }),
      host,
      matchedPattern: decision.matchedPattern,
      effective,
    };
  }

  /** The workspace's effective mode, read straight from the row + ceiling. */
  private async effectiveFor(workspaceId: string): Promise<WebAccessMode> {
    const row = await this.prisma.aiSettings.findUnique({
      where: { workspaceId },
      select: { webAccessMode: true },
    });
    return this.webAccess(row?.webAccessMode).effective;
  }

  private async resolvesPrivate(host: string): Promise<boolean> {
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    // An unresolvable host is refused rather than allowed through to `fetch`:
    // deny by default, as the graph query wrapper does with rows carrying no
    // workspace.
    if (addresses.length === 0) return true;
    return addresses.some(isPrivateAddress);
  }
}

/** The narrower of two modes. */
export function narrower(a: WebAccessMode, b: WebAccessMode): WebAccessMode {
  return ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))];
}

/**
 * The most specific row covering `host`, or null.
 *
 * `example.com` covers `docs.example.com` but not `notexample.com` — the match
 * is on a label boundary, never a bare suffix.
 */
export function matchPolicy<T extends { pattern: string }>(rows: readonly T[], host: string): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const p = row.pattern;
    if (host !== p && !host.endsWith(`.${p}`)) continue;
    if (!best || p.length > best.pattern.length) best = row;
  }
  return best;
}

/**
 * A pattern is a host, not a URL and not a glob.
 *
 * Admins type what they know — `https://docs.example.com/guide`, `*.example.com`
 * — so the obvious forms are accepted and reduced rather than rejected with a
 * format lecture. What is stored is always the bare lowercased host.
 */
export function normalizePattern(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      /* fall through to the textual cleanup */
    }
  }
  value = value
    .replace(/^\*+\./, '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
  if (!value || !/^[a-z0-9.-]+$/.test(value) || value.startsWith('.') || value.endsWith('.')) {
    throw new BadRequestException(t('error.web.invalidPattern', { pattern: raw }));
  }
  return value;
}

function toSummary(row: {
  id: string;
  workspaceId: string;
  pattern: string;
  allow: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}): SourcePolicy {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    pattern: row.pattern,
    allow: row.allow,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
  };
}
