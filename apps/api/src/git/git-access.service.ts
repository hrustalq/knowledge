import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DEFAULT_LOCALE, parseAcceptLanguage, type Locale } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { clientIp } from '../common/client-ip.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenAuthService } from '../auth/token-auth.service.js';
import { FeaturesService } from '../auth/features.service.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { UUID_RE } from '../permissions/acl-read.js';
import type { AccessScope } from '../permissions/access-scope.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';
import { t, withLocale } from '../i18n/t.js';

export interface GitCaller {
  principal: Principal;
  scope: AccessScope;
  locale: Locale;
}

/**
 * Who may fetch a project over git (#636, docs/features/71 "Authentication").
 * HTTP Basic with a `kn_` key as the password, any username. Then the very
 * checks a REST read of the project makes: the key's narrowing, membership,
 * the project's restriction, the workspace toggle. A capture key and a guest
 * are refused in v1.
 */
@Injectable()
export class GitAccessService {
  private readonly enabled: boolean;
  private readonly perMin: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenAuthService,
    private readonly permissions: PermissionService,
    private readonly features: FeaturesService,
    private readonly limiter: PublicRateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('GIT_REMOTE_ENABLED', { infer: true });
    this.perMin = config.get('PUBLIC_RATE_LIMIT_PER_MIN', { infer: true });
  }

  /**
   * The locale of `remote:` text: `Accept-Language` when git sends it, else
   * the key owner's (Apple's git sends none, docs/features/71 finding 4).
   */
  async authorize(req: Request, workspaceId: string, repo: string): Promise<GitCaller> {
    const asked = parseAcceptLanguage(req.headers['accept-language']);
    return withLocale(asked ?? DEFAULT_LOCALE, async () => {
      const projectId = repo.replace(/\.git$/, '');
      if (!this.enabled || !UUID_RE.test(workspaceId) || !UUID_RE.test(projectId)) throw this.notFound();
      const principal = await this.principalOf(req);
      const locale = asked ?? principal.locale ?? DEFAULT_LOCALE;
      return withLocale(locale, async () => {
        if (principal.apiKey?.scope === 'capture') throw new ForbiddenException(t('error.git.captureKey'));
        const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
        // The URL's workspace must own the project: the cross-tenant guard.
        if (!project || project.workspaceId !== workspaceId) throw this.notFound();
        await this.permissions.requireResource(principal, workspaceId, { type: 'project', id: projectId }, 'viewer', false);
        const scope = await this.permissions.scopeFor(principal, workspaceId);
        // A guest's visible set is not closed upward, so a path could name a page they cannot open.
        if (scope.guest) throw new ForbiddenException(t('error.git.guest'));
        await this.features.require(workspaceId, 'git');
        return { principal, scope, locale };
      });
    });
  }

  private async principalOf(req: Request): Promise<Principal> {
    if (this.config.get('AUTH_MODE', { infer: true }) !== 'api-key') return this.tokens.resolve(undefined);
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const decoded = basic ? Buffer.from(basic[1], 'base64').toString() : '';
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (!basic || !password) throw new UnauthorizedException(t('error.git.credentials'));
    // Every credentialed request counts, like a public read: a guess costs a request.
    if (!(await this.limiter.hit(`git:ip:${clientIp(req)}`, this.perMin, 60_000, false))) {
      throw new RateLimitedException(t('error.auth.rateLimited'), 60);
    }
    // A `ks_` session is a browser credential and a `kt_` ticket a URL one; git takes keys only.
    if (!password.startsWith('kn_')) throw new UnauthorizedException(t('error.git.credentials'));
    return this.tokens.resolve(password);
  }

  private notFound(): NotFoundException {
    return new NotFoundException(t('error.git.notFound'));
  }
}
