import { t } from '../../i18n/t.js';
import { normalizePrincipals } from './acl-layers.js';
import { githubHeaders, repoHost } from './repo-archive.js';
import {
  connectorFetch,
  type ConnectorContext,
  type ExternalAcl,
  type ExternalGroupMember,
  type ExternalPrincipal,
} from './connector.types.js';

/** GitHub caps `per_page` at 100; this many pages is 5 000 people, past which the list is cut short (fail closed). */
const MAX_PAGES = 50;

/**
 * Who may read a GitHub repository, as an ACL for every page from it (#76,
 * phase 6). Shared by markdown-git and codebase: a repository has one ACL, so
 * every file and every wiki page in it gets the same one.
 *
 * - Public → `source-wide`.
 * - Private → its collaborators (`affiliation=all`, which already includes
 *   people who reach it through a team or the org's base permission), plus its
 *   teams as mirrored groups. push/maintain/admin mirror as edit, pull/triage as view.
 *
 * Team members need the App's `members: read` organisation permission
 * (`GITHUB_PERMISSION_REQUIREMENTS`). Without it the team mirrors empty, and the
 * collaborator list still admits everyone the team would have.
 *
 * Cached per `ctx.config` the way `resolveBranch` is: one repository read per
 * run, however many pages ask.
 */
const aclCache = new WeakMap<object, Promise<ExternalAcl>>();

export function githubRepoAcl(ctx: ConnectorContext): Promise<ExternalAcl> {
  let pending = aclCache.get(ctx.config);
  if (!pending) {
    pending = readRepoAcl(ctx);
    aclCache.set(ctx.config, pending);
    // A failure must not stick for the rest of the run's context.
    pending.catch(() => aclCache.delete(ctx.config));
  }
  return pending;
}

async function readRepoAcl(ctx: ConnectorContext): Promise<ExternalAcl> {
  const host = repoHost(ctx);
  if (host.kind !== 'github') {
    throw new Error(t('error.connector.aclUnsupportedHost', { host: new URL(host.origin).hostname }, ctx.locale));
  }
  const repo = `${encodeURIComponent(host.owner)}/${encodeURIComponent(host.repo)}`;
  const meta = (await (
    await connectorFetch(`https://api.github.com/repos/${repo}`, { headers: githubHeaders(ctx), signal: ctx.signal }, ctx)
  ).json()) as { private?: boolean; owner?: { type?: string } };
  if (meta.private !== true) return { audience: 'source-wide', principals: [] };

  const principals: ExternalPrincipal[] = [];
  const collaborators = await paged<GithubCollaborator>(
    ctx,
    `https://api.github.com/repos/${repo}/collaborators?affiliation=all`,
  );
  for (const c of collaborators) {
    principals.push({
      type: 'user',
      externalId: String(c.id),
      name: c.login,
      level: c.permissions?.push || c.permissions?.maintain || c.permissions?.admin ? 'edit' : 'view',
    });
  }

  if (meta.owner?.type === 'Organization') {
    // Listing teams can be refused where collaborators are not; the people are
    // already in the list above, so a refusal only costs the group.
    const teams = await paged<GithubTeam>(ctx, `https://api.github.com/repos/${repo}/teams`).catch((err: Error) => {
      ctx.debug('acl: teams unreadable', { error: err.message });
      return [];
    });
    for (const team of teams) {
      principals.push({
        type: 'group',
        externalId: team.slug,
        name: team.name,
        level: team.permission === 'push' || team.permission === 'maintain' || team.permission === 'admin' ? 'edit' : 'view',
      });
    }
  }
  return { audience: 'restricted', principals: normalizePrincipals(principals) };
}

/** A team's members. Needs `members: read`; a refusal throws, and the caller leaves the group empty. */
export async function githubTeamMembers(ctx: ConnectorContext, team: ExternalPrincipal): Promise<ExternalGroupMember[]> {
  const host = repoHost(ctx);
  const members = await paged<{ id: number; login: string }>(
    ctx,
    `https://api.github.com/orgs/${encodeURIComponent(host.owner)}/teams/${encodeURIComponent(team.externalId)}/members`,
  );
  return members.map((m) => ({ externalId: String(m.id), name: m.login }));
}

async function paged<T>(ctx: ConnectorContext, url: string): Promise<T[]> {
  const out: T[] = [];
  const join = url.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await connectorFetch(
      `${url}${join}per_page=100&page=${page}`,
      { headers: githubHeaders(ctx), signal: ctx.signal },
      ctx,
    );
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

interface GithubCollaborator {
  id: number;
  login: string;
  permissions?: { pull?: boolean; triage?: boolean; push?: boolean; maintain?: boolean; admin?: boolean };
}
interface GithubTeam {
  slug: string;
  name: string;
  permission?: string;
}
