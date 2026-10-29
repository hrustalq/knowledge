// Who did something: a person, the dev principal, or an agent.

/** The AUTH_MODE=none principal, in both spellings it reaches the client as. */
export const DEV_ACTOR_ID = '00000000-0000-0000-0000-000000000000'

/** Stub/zeros ids read as "dev" everywhere else in the UI (see ActivityFeed). */
export function actorLabel(id: string | null | undefined): string {
  if (!id || id === DEV_ACTOR_ID || id === 'dev') return 'dev'
  return id.slice(0, 8)
}

/**
 * Does this actor have a profile behind it?
 *
 * Activity rows are written by three kinds of actor: real accounts, the dev
 * principal (no `users` row), and agents (a slug key, not an id). Only the first
 * has a page to open, so only the first gets a chip. The API answers the same
 * question with `activity/actor.ts`; this is its client-side half, and the
 * literal lives in one place on each side rather than four.
 */
export function isRealAccount(actor: string | null | undefined): boolean {
  return !!actor && actor !== DEV_ACTOR_ID && UUID_RE.test(actor)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
