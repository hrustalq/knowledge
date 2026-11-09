// A leaf that imports nothing, so any domain barrel can import it at runtime
// without closing a cycle through `core`.

/**
 * The shape of every id in this system: any version digit, nil allowed.
 * class-validator's `@IsUUID()` rejects nil-style ids (the zeros
 * `AUTHOR_ID_STUB` included), so DTOs use `@Matches(UUID_RE)` instead.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
