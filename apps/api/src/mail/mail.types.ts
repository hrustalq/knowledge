import type { NotificationReason } from '@knowledge/contracts';

/**
 * Directed reasons — the ones addressed at a person by name — are the only
 * notifications that reach email (docs/features/41). A watch is a subscription
 * to news, and news belongs in the inbox; being named is the interruption.
 */
// `alert` (#674): a source-backed page's source needs its owner — paused, gone, failing.
export const MAILED_REASONS: readonly NotificationReason[] = ['mention', 'review-requested', 'assigned', 'alert'];

/** Takes a string: the stored `notifications.reason` column is free TEXT. */
export const isMailedReason = (reason: string): boolean => (MAILED_REASONS as readonly string[]).includes(reason);

/**
 * One queued message. The recipient is always a `users` row, resolved at send
 * time: the address and the language are read when the mail leaves, not when
 * it was asked for, so a person who switched to Russian in between gets
 * Russian. Tokens travel in the job because only their hash is stored.
 */
export type MailJob =
  | { template: 'verify-email'; userId: string; token: string }
  | { template: 'password-reset'; userId: string; token: string }
  | { template: 'invite'; userId: string; token: string; inviter: string | null }
  | { template: 'password-changed'; userId: string }
  | { template: 'notification'; notificationId: string };
