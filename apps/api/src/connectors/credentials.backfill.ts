import type { Prisma, PrismaClient } from '@prisma/client';
import { credentialSiteFor, type ConnectionProvider } from '@knowledge/contracts';
import { decryptSecret } from '../ai/secret-box.js';

type Db = Pick<PrismaClient, 'credential' | 'connection' | 'githubUserToken' | 'figmaOauthGrant'>;
type Fields = Omit<Prisma.CredentialUncheckedCreateInput, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Moves every sign-in into `credentials` (#857, phase 1) and points each
 * connection at its credential. Run at API boot by `ConnectionsBackfill`,
 * after connectors are bound, and idempotent.
 *
 * Until the readers switch over, the old rows are the source of truth, so a
 * row already moved is refreshed whenever its source changed after it — which
 * also heals the drift left by rolling back to an image that writes only the
 * old columns. Envelopes are copied as they are: one key sealed both.
 *
 * - GitHub sign-ins: one per person, as `github_user_tokens` is keyed.
 * - Figma sign-ins: one per Figma account across every owner, because Figma
 *   keeps one token per app per Figma user.
 * - Pasted tokens: matched by owner, provider, site and decrypted secret,
 *   never by account — two fine-grained tokens for one account reach
 *   different repositories, and merging them would change what one dials.
 *
 * Returns how many credentials it created or refreshed.
 */
export async function backfillCredentials(db: Db, key: Buffer | null): Promise<number> {
  let written = 0;

  for (const t of await db.githubUserToken.findMany()) {
    const { changed } = await sync(db, { userId: t.userId, provider: 'github', method: 'oauth' }, t.updatedAt, {
      userId: t.userId,
      provider: 'github',
      method: 'oauth',
      site: null,
      accountId: String(t.githubUserId),
      accountLabel: t.githubLogin,
      accountAvatarUrl: t.githubAvatarUrl,
      secret: t.accessToken,
      refreshSecret: t.refreshToken,
      expiresAt: t.expiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
    });
    if (changed) written++;
  }

  for (const g of await db.figmaOauthGrant.findMany()) {
    const { id, changed } = await sync(db, { provider: 'figma', method: 'oauth', accountId: g.figmaUserId }, g.updatedAt, {
      userId: g.connectedBy,
      provider: 'figma',
      method: 'oauth',
      site: null,
      accountId: g.figmaUserId,
      accountLabel: g.handle,
      secret: g.accessToken,
      refreshSecret: g.refreshToken,
      expiresAt: g.expiresAt,
    });
    if (changed) written++;
    await db.connection.updateMany({
      where: { provider: 'figma', method: 'oauth', externalRef: g.figmaUserId, credentialId: null },
      data: { credentialId: id },
    });
  }

  const tokens = await db.connection.findMany({
    where: { method: 'token', credential: { not: null } },
    include: { credentialRow: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const c of tokens) {
    const bound = c.credentialRow;
    if (bound) {
      // Moved already; refresh it only from a rotation it has not seen.
      if (c.updatedAt <= bound.updatedAt || c.credential === bound.secret) continue;
      if (decryptSecret(c.credential, key) === decryptSecret(bound.secret, key)) continue;
      await db.credential.update({ where: { id: bound.id }, data: { secret: c.credential!, secretHint: c.credentialHint } });
      written++;
      continue;
    }
    const secret = decryptSecret(c.credential, key);
    // A token sealed with another key cannot be matched or used; it stays put.
    if (!secret) continue;
    const site = credentialSiteFor(c.provider as ConnectionProvider, c.site);
    const mine = await db.credential.findMany({
      where: { userId: c.createdBy, provider: c.provider, method: 'token', site },
      orderBy: { createdAt: 'asc' },
    });
    let id = mine.find((m) => decryptSecret(m.secret, key) === secret)?.id;
    if (!id) {
      ({ id } = await db.credential.create({
        data: {
          userId: c.createdBy,
          provider: c.provider,
          method: 'token',
          site,
          accountId: c.accountId,
          accountLabel: c.accountLabel,
          accountAvatarUrl: c.accountAvatarUrl,
          secret: c.credential!,
          secretHint: c.credentialHint,
        },
        select: { id: true },
      }));
      written++;
    }
    await db.connection.update({ where: { id: c.id }, data: { credentialId: id } });
  }

  return written;
}

/** Creates the credential `where` names, or refreshes it from a source that changed after it. */
async function sync(db: Db, where: Prisma.CredentialWhereInput, sourceUpdatedAt: Date, data: Fields) {
  const found = await db.credential.findFirst({ where, orderBy: { createdAt: 'asc' } });
  if (!found) {
    const { id } = await db.credential.create({ data, select: { id: true } });
    return { id, changed: true };
  }
  if (sourceUpdatedAt <= found.updatedAt) return { id: found.id, changed: false };
  await db.credential.update({ where: { id: found.id }, data });
  return { id: found.id, changed: true };
}
