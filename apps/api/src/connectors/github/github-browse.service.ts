import { Injectable, Logger } from '@nestjs/common';
import type {
  GithubBranchSummary,
  GithubInstallationSummary,
  GithubRepoSummary,
} from '@knowledge/contracts';
import { safeFetch } from '../../common/safe-fetch.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GithubAppService, toAccount } from './github-app.service.js';
import { GithubOauthService } from './github-oauth.service.js';

/**
 * What the repository picker reads (docs/features/30).
 *
 * Everything here acts as the **user**, not as the App. `GET /app/installations`
 * would list every account the App is installed on, across every customer — so
 * an account switcher built on it would show people orgs they have nothing to
 * do with. `GET /user/installations` answers the question the switcher is
 * actually asking, and it needs the OAuth token.
 *
 * The result is then intersected with the installations recorded for *this
 * workspace*, so that connecting your GitHub account does not silently widen a
 * workspace to every org you personally belong to.
 *
 * No method throws. These endpoints answer "what can I see", and an upstream
 * hiccup is something for the picker to render, not a 500 to catch — the same
 * envelope `AiPluginTestResponse` established.
 */

/**
 * `/user/installations/{id}/repositories` has no search parameter, so filtering
 * is ours to do and the page count is the only bound on it. Ten pages at 100 is
 * a thousand repositories per account, past which a person is going to type a
 * query rather than scroll anyway.
 */
const MAX_PAGES = 10;
const PER_PAGE = 100;

@Injectable()
export class GithubBrowseService {
  private readonly logger = new Logger(GithubBrowseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly app: GithubAppService,
    private readonly oauth: GithubOauthService,
  ) {}

  /**
   * The accounts this person can pick from, in this workspace.
   *
   * An installation recorded for the workspace but not visible to this user is
   * dropped: they cannot browse it, so offering it would produce an empty
   * repository list and no explanation.
   */
  async installations(workspaceId: string, userId: string): Promise<GithubInstallationSummary[]> {
    const token = await this.oauth.tokenFor(userId);
    if (!token) return [];

    const rows = await this.prisma.githubInstallation.findMany({ where: { workspaceId } });
    if (rows.length === 0) return [];
    const inWorkspace = new Set(rows.map((r) => String(r.installationId)));

    const visible = await this.userInstallations(token);
    return visible
      .filter((account) => inWorkspace.has(account.installationId))
      .map((account) => ({
        installationId: account.installationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
        accountAvatarUrl: account.accountAvatarUrl,
        repositorySelection: account.repositorySelection,
        suspended: account.suspended,
      }));
  }

  /**
   * Repositories in one installation, newest-pushed first, optionally filtered.
   *
   * The filter is a plain substring over `owner/name` and the description,
   * applied here rather than upstream because the endpoint offers nothing
   * better. Matching is case-insensitive on both sides.
   */
  async repositories(
    workspaceId: string,
    userId: string,
    installationId: string,
    query: string | undefined,
    limit: number,
  ): Promise<{ ok: boolean; repositories: GithubRepoSummary[]; error?: string }> {
    const guard = await this.assertVisible(workspaceId, userId, installationId);
    if ('error' in guard) return { ok: false, repositories: [], error: guard.error };

    const needle = query?.trim().toLowerCase() ?? '';
    const found: GithubRepoSummary[] = [];

    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await this.asUser(
          guard.token,
          `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=${PER_PAGE}&page=${page}`,
        );
        if (!res.ok) return { ok: false, repositories: [], error: `GitHub answered ${res.status}` };

        const body = (await res.json()) as { repositories?: RawRepo[] };
        const batch = body.repositories ?? [];
        for (const raw of batch) {
          const repo = toRepo(raw);
          if (!needle || matches(repo, needle)) found.push(repo);
        }
        // A short page is the last page; there is no point asking for another.
        if (batch.length < PER_PAGE) break;
        // Enough to answer with, and the caller only renders `limit` of them.
        if (found.length >= limit && !needle) break;
      }
    } catch (err) {
      this.logger.warn(`repository listing failed: ${(err as Error).message}`);
      return { ok: false, repositories: [], error: (err as Error).message.slice(0, 200) };
    }

    found.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
    return { ok: true, repositories: found.slice(0, limit) };
  }

  /**
   * Branches of one repository, the repo's default first.
   *
   * Authenticated as the installation rather than the user: this is the same
   * credential the sync will use, so a branch listed here is a branch the sync
   * can actually read. Listing as the user could offer a branch on a repository
   * the installation was never granted.
   */
  async branches(
    workspaceId: string,
    userId: string,
    installationId: string,
    owner: string,
    repo: string,
  ): Promise<{ ok: boolean; branches: GithubBranchSummary[]; error?: string }> {
    const guard = await this.assertVisible(workspaceId, userId, installationId);
    if ('error' in guard) return { ok: false, branches: [], error: guard.error };

    const token = await this.app.installationToken(installationId);
    if (!token) return { ok: false, branches: [], error: 'the installation could not be authenticated' };

    try {
      const meta = await this.asInstallation(token, `/repos/${encode(owner)}/${encode(repo)}`);
      if (!meta.ok) return { ok: false, branches: [], error: `GitHub answered ${meta.status}` };
      const defaultBranch = ((await meta.json()) as { default_branch?: string }).default_branch ?? '';

      const names: string[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await this.asInstallation(
          token,
          `/repos/${encode(owner)}/${encode(repo)}/branches?per_page=${PER_PAGE}&page=${page}`,
        );
        if (!res.ok) return { ok: false, branches: [], error: `GitHub answered ${res.status}` };
        const batch = (await res.json()) as Array<{ name?: string }>;
        for (const b of batch) if (b.name) names.push(b.name);
        if (batch.length < PER_PAGE) break;
      }

      const branches = names.map((name) => ({ name, isDefault: name === defaultBranch }));
      // Default first, then alphabetical — the one people want is the one they
      // should not have to scroll for.
      branches.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
      return { ok: true, branches };
    } catch (err) {
      this.logger.warn(`branch listing failed: ${(err as Error).message}`);
      return { ok: false, branches: [], error: (err as Error).message.slice(0, 200) };
    }
  }

  /**
   * Records an installation against a workspace, from the setup callback.
   *
   * A write on an otherwise read-only service, and it lives here because the
   * registry it writes is the one every read above intersects against — putting
   * it elsewhere would split one table across two owners.
   *
   * Upsert rather than insert: GitHub sends the setup callback again whenever
   * someone changes the repository selection, and the second visit must update
   * the row rather than collide with it.
   */
  async recordInstallation(workspaceId: string, installationId: string, userId: string | null): Promise<boolean> {
    const account = await this.app.installation(installationId);
    if (!account) return false;

    const data = {
      accountLogin: account.accountLogin,
      accountType: account.accountType,
      accountAvatarUrl: account.accountAvatarUrl,
      repositorySelection: account.repositorySelection,
      suspendedAt: account.suspended ? new Date() : null,
    };
    await this.prisma.githubInstallation.upsert({
      where: { workspaceId_installationId: { workspaceId, installationId: BigInt(installationId) } },
      create: { workspaceId, installationId: BigInt(installationId), createdBy: userId, ...data },
      update: data,
    });
    return true;
  }

  // --- internals ---

  /**
   * One gate for both list calls: this person is connected, and this
   * installation is one their workspace recorded *and* they can see.
   */
  private async assertVisible(
    workspaceId: string,
    userId: string,
    installationId: string,
  ): Promise<{ token: string } | { error: string }> {
    const token = await this.oauth.tokenFor(userId);
    if (!token) return { error: 'connect a GitHub account first' };

    const row = await this.prisma.githubInstallation.findFirst({
      where: { workspaceId, installationId: BigInt(installationId) },
    });
    if (!row) return { error: 'that installation is not connected to this workspace' };

    const visible = await this.userInstallations(token);
    if (!visible.some((a) => a.installationId === installationId)) {
      return { error: 'your GitHub account cannot reach that installation' };
    }
    return { token };
  }

  private async userInstallations(token: string): Promise<ReturnType<typeof toAccount>[]> {
    const out: ReturnType<typeof toAccount>[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await this.asUser(token, `/user/installations?per_page=${PER_PAGE}&page=${page}`);
        if (!res.ok) break;
        const body = (await res.json()) as { installations?: Parameters<typeof toAccount>[0][] };
        const batch = body.installations ?? [];
        for (const raw of batch) out.push(toAccount(raw));
        if (batch.length < PER_PAGE) break;
      }
    } catch (err) {
      this.logger.warn(`installation listing failed: ${(err as Error).message}`);
    }
    return out;
  }

  private asUser(token: string, path: string): Promise<Response> {
    return this.request(token, path);
  }

  private asInstallation(token: string, path: string): Promise<Response> {
    return this.request(token, path);
  }

  private request(token: string, path: string): Promise<Response> {
    return safeFetch(
      `${this.app.apiUrl}${path}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'knowledge-connector',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${token}`,
        },
      },
      // github.com is public regardless of CONNECTOR_ALLOW_PRIVATE_URLS.
      false,
    );
  }
}

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

interface RawRepo {
  name: string;
  full_name: string;
  owner?: { login?: string } | null;
  private?: boolean;
  description?: string | null;
  default_branch?: string;
  html_url: string;
  pushed_at?: string | null;
  language?: string | null;
}

export function toRepo(raw: RawRepo): GithubRepoSummary {
  return {
    fullName: raw.full_name,
    name: raw.name,
    ownerLogin: raw.owner?.login ?? raw.full_name.split('/')[0],
    private: Boolean(raw.private),
    description: raw.description ?? null,
    defaultBranch: raw.default_branch ?? 'main',
    htmlUrl: raw.html_url,
    pushedAt: raw.pushed_at ?? null,
    language: raw.language ?? null,
  };
}

export function matches(repo: GithubRepoSummary, needle: string): boolean {
  return (
    repo.fullName.toLowerCase().includes(needle) || (repo.description?.toLowerCase().includes(needle) ?? false)
  );
}
