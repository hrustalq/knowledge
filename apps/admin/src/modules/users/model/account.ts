// What both users pages read off an account: no component of its own, so it is
// a couple of functions here rather than an entity.
import type { UserSummary } from '@knowledge/contracts'

/** Status badges, in the order they read. */
export function accountBadges(user: UserSummary): { key: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }[] {
  return [
    ...(user.isAdmin ? [{ key: 'platformAdmin', variant: 'default' as const }] : []),
    ...(user.disabled ? [{ key: 'disabled', variant: 'destructive' as const }] : []),
    ...(!user.emailVerified ? [{ key: 'unverified', variant: 'secondary' as const }] : []),
    ...(!user.disabled && !user.isAdmin ? [{ key: 'active', variant: 'outline' as const }] : []),
  ]
}

/** How the person can sign in: password, API key, both or neither. */
export function credentialKeys(user: UserSummary): string[] {
  return [...(user.hasPassword ? ['password'] : []), ...(user.hasApiKey ? ['apiKey'] : [])]
}
