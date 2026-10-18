import { Injectable } from '@nestjs/common';
import { Prisma, type IdentityProvider, type User } from '@prisma/client';
import type { SsoLoginError } from '@knowledge/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { currentLocale } from '../../i18n/t.js';
import { AuditService } from '../audit.service.js';
import type { ExternalIdentity } from './oidc-claims.js';
import { presetOf } from './oidc-presets.js';
import { RoleSyncService } from './role-sync.service.js';

export type SsoLoginOutcome =
  | { ok: true; user: User; created: boolean }
  | { ok: false; error: SsoLoginError; reason: string; userId?: string };

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1);

/**
 * The single convergence point of every SSO kind (#75): given who a provider
 * says signed in, decide which account that is — or that it is none.
 *
 * 1. A known (provider, subject) is that account, whatever the address now says.
 * 2. Otherwise an existing account is linked by address only when the IdP
 *    vouches for the address **and** its domain is one this provider may
 *    assert. Either alone is an account takeover: an unverified `email` claim
 *    is whatever the person typed, and a verified address on a domain the
 *    provider does not own is someone else's.
 * 3. Otherwise, with JIT on and the same two conditions, a new SSO-only
 *    account (no password) is created.
 * 4. A disabled account is refused whichever way it was found.
 * 5. Memberships follow the asserted groups and the JIT default role
 *    (`RoleSyncService`), never touching a row a person set by hand.
 *
 * Sessions are not opened here: the browser trades a single-use code for one
 * (`SsoFlowService.exchange`), so the token never travels in a URL.
 */
@Injectable()
export class SsoLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly roleSync: RoleSyncService,
  ) {}

  async resolve(provider: IdentityProvider, identity: ExternalIdentity): Promise<SsoLoginOutcome> {
    const found = await this.findOrCreate(provider, identity);
    if (!found.ok) return found;
    const { user, created } = found;
    if (user.disabledAt) return { ok: false, error: 'account-disabled', reason: 'disabled', userId: user.id };

    await this.roleSync.apply({
      provider,
      userId: user.id,
      groups: identity.groups,
      groupsKnown: !identity.notes.includes('groups-overage'),
    });
    await this.prisma.userIdentity.updateMany({
      where: { providerId: provider.id, subject: identity.subject },
      data: { lastLoginAt: new Date() },
    });
    return { ok: true, user, created };
  }

  private async findOrCreate(
    provider: IdentityProvider,
    identity: ExternalIdentity,
    retried = false,
  ): Promise<SsoLoginOutcome> {
    const linked = await this.prisma.userIdentity.findUnique({
      where: { providerId_subject: { providerId: provider.id, subject: identity.subject } },
      include: { user: true },
    });
    if (linked) return { ok: true, user: linked.user, created: false };

    if (!identity.email) return { ok: false, error: 'email-missing', reason: 'no email claim' };
    const email = identity.email;
    const refusal = this.refuseAddress(provider, identity, email);
    const existing = await this.prisma.user.findUnique({ where: { email } });

    try {
      if (existing) {
        if (refusal) return { ...refusal, userId: existing.id };
        await this.prisma.userIdentity.create({
          data: { userId: existing.id, providerId: provider.id, subject: identity.subject, emailAtLink: email },
        });
        void this.audit.record({
          workspaceId: provider.workspaceId,
          actor: existing.id,
          action: 'sso.identity_linked',
          params: { providerId: provider.id, email },
          ok: true,
          target: existing.id,
        });
        return { ok: true, user: existing, created: false };
      }

      if (!provider.jitEnabled) return { ok: false, error: 'jit-disabled', reason: 'jit off' };
      if (refusal) return refusal;
      const user = await this.prisma.user.create({
        data: {
          email,
          displayName: (identity.displayName ?? email.slice(0, email.indexOf('@'))).slice(0, 120),
          passwordHash: null,
          // The provider vouched for it, which is what a confirmation link proves.
          emailVerifiedAt: new Date(),
          locale: currentLocale(),
          identities: { create: { providerId: provider.id, subject: identity.subject, emailAtLink: email } },
        },
      });
      void this.audit.record({
        workspaceId: provider.workspaceId,
        actor: user.id,
        action: 'sso.jit_user_created',
        params: { providerId: provider.id, email },
        ok: true,
        target: user.id,
      });
      return { ok: true, user, created: true };
    } catch (e) {
      // Two first sign-ins racing: the loser's insert hits a unique index, and
      // the winner's row is now there to be found.
      if (!retried && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.findOrCreate(provider, identity, true);
      }
      throw e;
    }
  }

  /** Why this provider may not speak for `email`, or null when it may. */
  private refuseAddress(
    provider: IdentityProvider,
    identity: ExternalIdentity,
    email: string,
  ): { ok: false; error: SsoLoginError; reason: string } | null {
    if (!identity.emailVerified) return { ok: false, error: 'email-not-verified', reason: 'email not verified by the IdP' };
    const domain = domainOf(email);
    if (!provider.allowedDomains.includes(domain)) {
      return { ok: false, error: 'domain-not-allowed', reason: `domain ${domain} not allowed` };
    }
    // Google: the account must belong to the Workspace org, not merely carry its address.
    if (presetOf(provider.preset) === 'google' && !(identity.hostedDomain && provider.allowedDomains.includes(identity.hostedDomain))) {
      return { ok: false, error: 'domain-not-allowed', reason: `hd ${identity.hostedDomain ?? 'missing'} not allowed` };
    }
    return null;
  }
}
