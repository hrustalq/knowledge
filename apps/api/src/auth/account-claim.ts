import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * An identity provider or a directory that speaks for the address has just
 * linked an account whose address nobody ever confirmed (#1094). Signup proves
 * nothing, so whoever registered the address first may not be the person the
 * provider vouches for: every way in they set up ends here — the password,
 * live sessions, API keys, open reset and confirmation links, linked chat
 * accounts that answer as the person, and personal sign-ins (Plaud links,
 * credentials) — and the address becomes verified.
 *
 * One guarded statement claims it (`emailVerifiedAt: null`), so a verified
 * account is never touched and a second link does nothing. Joins the caller's
 * transaction when one is open. Returns whether this call claimed it.
 */
export async function claimUnverifiedAccount(prisma: PrismaService, userId: string): Promise<boolean> {
  return prisma.withTransaction(async () => {
    const now = new Date();
    const { count } = await prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { passwordHash: null, emailVerifiedAt: now },
    });
    if (count === 0) return false;
    await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await prisma.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
    await prisma.emailVerificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
    await prisma.chatIdentity.deleteMany({ where: { userId } });
    // A code they confirmed and have not proven yet would still link as this person.
    await prisma.chatLinkCode.updateMany({ where: { confirmedBy: userId, usedAt: null }, data: { usedAt: now } });
    // Personal sign-ins answer as whoever set them up: a Plaud link would keep
    // importing their recordings as this person, a credential is theirs to bind.
    // One a workspace connection already dials keeps working there, unowned.
    await prisma.plaudLink.deleteMany({ where: { userId } });
    const bound = await prisma.connection.findMany({ where: { credentialRow: { userId } }, select: { credentialId: true } });
    const keep = [...new Set(bound.flatMap((c) => (c.credentialId ? [c.credentialId] : [])))];
    await prisma.credential.deleteMany({ where: { userId, id: { notIn: keep } } });
    await prisma.credential.updateMany({ where: { userId }, data: { userId: null } });
    return true;
  });
}
