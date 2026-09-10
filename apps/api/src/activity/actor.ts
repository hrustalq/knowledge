/**
 * The AUTH_MODE=none actor's two spellings, in a module that imports nothing.
 *
 * Lifted out of `activity.service.ts` because that file imports
 * `EventsPublisher`, and `EventsPublisher` now reaches the notification
 * fan-out: importing these constants from there would close a file cycle
 * (events.publisher → notifications.service → activity.service →
 * events.publisher) whose damage lands on Nest's `design:paramtypes` metadata,
 * which is evaluated at class-definition time and would see `undefined`.
 *
 * `activity.service.ts` re-exports all three, so every existing import site
 * keeps working.
 */

/** The literal `ActivityService.record` writes when a call site passes no actor. */
export const DEV_ACTOR = 'dev';
/** DEV_PRINCIPAL.userId — the same person, as an id. */
export const DEV_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The AUTH_MODE=none actor has two spellings in the activity table and always
 * has: `ActivityService.record` falls back to the literal 'dev' when a call
 * site passes no actor, while the call sites that DO pass one hand over
 * `principal.userId`, which for the dev principal is the zeros stub. Both are
 * the same person, so a profile that picked one would silently under-report —
 * measurably: a real workspace here holds 270 rows under the stub and 23 under
 * 'dev'.
 *
 * Widening is deliberately limited to this one pair. Every other actor
 * resolves to itself, so no real user's rows can ever be folded into another's.
 */
export function actorIdentities(actor: string): string[] {
  return actor === DEV_ACTOR || actor === DEV_ACTOR_ID ? [DEV_ACTOR, DEV_ACTOR_ID] : [actor];
}

/** Whether an actor string is the dev principal under either spelling. */
export function isDevActor(actor: string | null | undefined): boolean {
  return actor === DEV_ACTOR || actor === DEV_ACTOR_ID;
}
