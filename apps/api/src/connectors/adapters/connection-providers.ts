import type { ConnectionProvider, ConnectionResource, ConnectorKind } from '@knowledge/contracts';
import { connectorFetch, type ConnectorContext } from './connector.types.js';
import { FIGMA_API } from './figma.js';
import { parseServiceAccountKey } from './google-drive.adapter.js';
import { jiraHeaders } from './jira.adapter.js';
import { githubHeaders, gitlabHeaders } from './repo-archive.js';

/**
 * What a connection can say about itself and reach upstream (#564): the
 * account behind a token, and the resources and branches the link screen
 * offers. Keyed by provider, not by adapter: one GitHub connection serves two
 * kinds, so these live once per account system rather than once per kind.
 * Auth headers are the adapters' own helpers, so a probe dials exactly as a sync would.
 */

export type ProbeContext = Pick<ConnectorContext, 'credential' | 'debug' | 'allowPrivate' | 'signal'>;

export interface ProviderAccount {
  id: string;
  label: string;
  avatarUrl: string | null;
}

const GITHUB_API = 'https://api.github.com';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_HEADERS = { 'Notion-Version': '2022-06-28', 'content-type': 'application/json' };
/** Listings stop here: a picker is searched, not scrolled through ten thousand rows. */
const MAX_PAGES = 5;
const PER_PAGE = 100;

async function json<T>(url: string, ctx: ProbeContext, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await connectorFetch(url, { ...init, headers: { accept: 'application/json', ...headers }, signal: ctx.signal }, ctx);
  return (await res.json()) as T;
}

const github = (ctx: ProbeContext) => githubHeaders(ctx as ConnectorContext);
const gitlab = (ctx: ProbeContext) => gitlabHeaders(ctx as ConnectorContext);
const bearer = (ctx: ProbeContext) => ({ authorization: `Bearer ${ctx.credential ?? ''}` });
/** Zendesk's `email:token` becomes `email/token:token` Basic, as the adapter sends it. */
function zendeskAuth(ctx: ProbeContext) {
  const [email, ...rest] = (ctx.credential ?? '').split(':');
  return { authorization: `Basic ${Buffer.from(`${email}/token:${rest.join(':')}`).toString('base64')}` };
}

/**
 * Who `ctx.credential` is upstream. Throws the upstream refusal (a
 * `ConnectorRequestError`) for a token that does not work, so a bad paste is
 * answered before it is stored. A plain git host has no account API: null.
 */
export async function identify(provider: ConnectionProvider, site: string | null, ctx: ProbeContext): Promise<ProviderAccount | null> {
  switch (provider) {
    case 'github': {
      const me = await json<{ id: number; login: string; avatar_url?: string }>(`${GITHUB_API}/user`, ctx, github(ctx));
      return { id: String(me.id), label: me.login, avatarUrl: me.avatar_url ?? null };
    }
    case 'gitlab': {
      const me = await json<{ id: number; username: string; avatar_url?: string }>(`${site}/api/v4/user`, ctx, gitlab(ctx));
      return { id: String(me.id), label: me.username, avatarUrl: me.avatar_url ?? null };
    }
    case 'atlassian': {
      const me = await json<{ accountId: string; displayName?: string; emailAddress?: string; avatarUrls?: Record<string, string> }>(
        `${site}/rest/api/3/myself`,
        ctx,
        jiraHeaders(ctx),
      );
      return { id: me.accountId, label: me.emailAddress ?? me.displayName ?? me.accountId, avatarUrl: me.avatarUrls?.['48x48'] ?? null };
    }
    case 'confluence-server': {
      const me = await json<{ userKey?: string; username?: string; displayName?: string }>(`${site}/rest/api/user/current`, ctx, bearer(ctx));
      const id = me.userKey ?? me.username ?? '';
      // An unauthenticated call answers 200 as the anonymous user.
      if (!id) throw new Error('Confluence answered as the anonymous user: the token was not accepted');
      return { id, label: me.username ?? me.displayName ?? id, avatarUrl: null };
    }
    case 'notion': {
      const me = await json<{ id: string; name?: string; avatar_url?: string | null }>(`${NOTION_API}/users/me`, ctx, {
        ...bearer(ctx),
        ...NOTION_HEADERS,
      });
      return { id: me.id, label: me.name ?? me.id, avatarUrl: me.avatar_url ?? null };
    }
    case 'google': {
      // A service account key names its account; nothing to dial.
      const key = parseServiceAccountKey(ctx.credential);
      return { id: key.clientEmail, label: key.clientEmail, avatarUrl: null };
    }
    case 'linear': {
      const body = await json<{ data?: { viewer?: { id: string; name?: string; email?: string; avatarUrl?: string } } }>(
        'https://api.linear.app/graphql',
        ctx,
        { authorization: ctx.credential ?? '', 'content-type': 'application/json' },
        { method: 'POST', body: JSON.stringify({ query: '{ viewer { id name email avatarUrl } }' }) },
      );
      const me = body.data?.viewer;
      if (!me) throw new Error('Linear did not say who this key belongs to');
      return { id: me.id, label: me.email ?? me.name ?? me.id, avatarUrl: me.avatarUrl ?? null };
    }
    case 'zendesk': {
      const { user } = await json<{ user?: { id: number; email?: string; name?: string; photo?: { content_url?: string } | null } }>(
        `${site}/api/v2/users/me.json`,
        ctx,
        zendeskAuth(ctx),
      );
      // Zendesk answers an unauthenticated call with an anonymous user, id null.
      if (!user?.id) throw new Error('Zendesk answered as an anonymous user: the token was not accepted');
      return { id: String(user.id), label: user.email ?? user.name ?? String(user.id), avatarUrl: user.photo?.content_url ?? null };
    }
    case 'intercom': {
      const me = await json<{ id: string; email?: string; name?: string; app?: { name?: string } }>(`${site}/me`, ctx, {
        ...bearer(ctx),
        'intercom-version': '2.11',
      });
      return { id: me.id, label: me.app?.name ?? me.email ?? me.name ?? me.id, avatarUrl: null };
    }
    case 'figma': {
      const me = await json<{ id: string; handle?: string; email?: string; img_url?: string }>(`${FIGMA_API}/v1/me`, ctx, {
        'X-Figma-Token': ctx.credential ?? '',
      });
      return { id: me.id, label: me.handle ?? me.email ?? me.id, avatarUrl: me.img_url ?? null };
    }
    case 'git':
    // A web host's token (#674) has no account to ask about.
    case 'web':
      return null;
  }
}

/**
 * What a token connection can reach for `kind`, newest activity first and
 * filtered by `q`. Null for a kind with no listing — the link screen then
 * shows the typed fields it always had. GitHub App connections are listed by
 * `GithubBrowseService`, as the person (doc 30), not here.
 */
export async function listResources(
  provider: ConnectionProvider,
  kind: ConnectorKind,
  site: string | null,
  ctx: ProbeContext,
  q: string,
): Promise<ConnectionResource[] | null> {
  const needle = q.trim().toLowerCase();
  const keep = (r: ConnectionResource) =>
    !needle || r.label.toLowerCase().includes(needle) || (r.description?.toLowerCase().includes(needle) ?? false);
  const newestFirst = (rows: ConnectionResource[]) =>
    rows.filter(keep).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  if (provider === 'github') {
    const rows: ConnectionResource[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await json<RawGithubRepo[]>(
        `${GITHUB_API}/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        ctx,
        github(ctx),
      );
      rows.push(...batch.map(githubRepoResource));
      if (batch.length < PER_PAGE) break;
    }
    return newestFirst(rows);
  }

  if (provider === 'gitlab') {
    const rows: ConnectionResource[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        membership: 'true',
        simple: 'true',
        order_by: 'last_activity_at',
        per_page: String(PER_PAGE),
        page: String(page),
        ...(needle ? { search: needle } : {}),
      });
      const batch = await json<RawGitlabProject[]>(`${site}/api/v4/projects?${params}`, ctx, gitlab(ctx));
      for (const p of batch) {
        rows.push({
          id: p.path_with_namespace,
          label: p.path_with_namespace,
          description: p.description ?? null,
          namespace: p.namespace?.full_path ?? p.path_with_namespace.split('/').slice(0, -1).join('/'),
          private: p.visibility !== 'public',
          defaultBranch: p.default_branch ?? null,
          updatedAt: p.last_activity_at ?? null,
          url: p.web_url,
          config: { repoUrl: p.web_url },
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return newestFirst(rows);
  }

  if (provider === 'atlassian' && kind === 'confluence') {
    const body = await json<{ results?: Array<{ key: string; name: string; type?: string; _links?: { webui?: string } }> }>(
      `${site}/wiki/api/v2/spaces?limit=250&sort=name`,
      ctx,
      jiraHeaders(ctx),
    );
    return (body.results ?? [])
      .map((s) => ({
        id: s.key,
        label: `${s.name} (${s.key})`,
        description: null,
        namespace: null,
        private: s.type === 'personal',
        defaultBranch: null,
        updatedAt: null,
        url: s._links?.webui ? `${site}/wiki${s._links.webui}` : null,
        config: { baseUrl: `${site}/wiki`, spaceKey: s.key },
      }))
      .filter(keep);
  }

  if (provider === 'atlassian' && kind === 'jira') {
    const params = new URLSearchParams({ maxResults: '100', orderBy: 'name', ...(needle ? { query: needle } : {}) });
    const body = await json<{ values?: Array<{ key: string; name: string; isPrivate?: boolean }> }>(
      `${site}/rest/api/3/project/search?${params}`,
      ctx,
      jiraHeaders(ctx),
    );
    return (body.values ?? []).map((p) => ({
      id: p.key,
      label: `${p.name} (${p.key})`,
      description: null,
      namespace: null,
      private: Boolean(p.isPrivate),
      defaultBranch: null,
      updatedAt: null,
      url: `${site}/browse/${p.key}`,
      config: { baseUrl: site ?? '', projectKey: p.key, jql: `project = ${p.key}` },
    }));
  }

  if (provider === 'notion') {
    const body = await json<{ results?: RawNotionDatabase[] }>(`${NOTION_API}/search`, ctx, { ...bearer(ctx), ...NOTION_HEADERS }, {
      method: 'POST',
      body: JSON.stringify({ query: q.trim(), filter: { property: 'object', value: 'database' }, page_size: 100 }),
    });
    return newestFirst(
      (body.results ?? []).map((d) => ({
        id: d.id,
        label: d.title?.map((t) => t.plain_text).join('') || d.id,
        description: null,
        namespace: null,
        private: false,
        defaultBranch: null,
        updatedAt: d.last_edited_time ?? null,
        url: d.url ?? null,
        config: { databaseId: d.id },
      })),
    );
  }

  return null;
}

/** A repository's branches, default first. `repo` is the resource id (`owner/name`, or GitLab's full path). */
export async function listBranches(
  provider: ConnectionProvider,
  site: string | null,
  ctx: ProbeContext,
  repo: string,
): Promise<Array<{ name: string; isDefault: boolean }>> {
  let defaultBranch = '';
  const names: string[] = [];
  if (provider === 'github') {
    const path = repo.split('/').map(encodeURIComponent).join('/');
    defaultBranch = (await json<{ default_branch?: string }>(`${GITHUB_API}/repos/${path}`, ctx, github(ctx))).default_branch ?? '';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await json<Array<{ name: string }>>(`${GITHUB_API}/repos/${path}/branches?per_page=${PER_PAGE}&page=${page}`, ctx, github(ctx));
      names.push(...batch.map((b) => b.name));
      if (batch.length < PER_PAGE) break;
    }
  } else if (provider === 'gitlab') {
    const base = `${site}/api/v4/projects/${encodeURIComponent(repo)}`;
    defaultBranch = (await json<{ default_branch?: string }>(base, ctx, gitlab(ctx))).default_branch ?? '';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await json<Array<{ name: string }>>(`${base}/repository/branches?per_page=${PER_PAGE}&page=${page}`, ctx, gitlab(ctx));
      names.push(...batch.map((b) => b.name));
      if (batch.length < PER_PAGE) break;
    }
  }
  return names
    .map((name) => ({ name, isDefault: name === defaultBranch }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

interface RawGithubRepo {
  full_name: string;
  owner?: { login?: string } | null;
  private?: boolean;
  description?: string | null;
  default_branch?: string;
  html_url: string;
  pushed_at?: string | null;
}
interface RawGitlabProject {
  path_with_namespace: string;
  description?: string | null;
  namespace?: { full_path?: string } | null;
  visibility?: string;
  default_branch?: string | null;
  last_activity_at?: string | null;
  web_url: string;
}
interface RawNotionDatabase {
  id: string;
  title?: Array<{ plain_text: string }>;
  last_edited_time?: string;
  url?: string;
}

export function githubRepoResource(r: RawGithubRepo): ConnectionResource {
  return {
    id: r.full_name,
    label: r.full_name,
    description: r.description ?? null,
    namespace: r.owner?.login ?? r.full_name.split('/')[0],
    private: Boolean(r.private),
    defaultBranch: r.default_branch ?? null,
    updatedAt: r.pushed_at ?? null,
    url: r.html_url,
    config: { repoUrl: r.html_url },
  };
}
