import type { AvatarUrl } from '@knowledge/contracts';

/**
 * Turning a stored avatar key into something a client can render.
 *
 * One helper rather than the expression inlined at eight mappers, because what
 * it returns is a contract: a bare `/v1/...` path (never absolute — one value
 * has to work through the dev proxy, in production and during SSR) carrying a
 * `?v=` stamp.
 *
 * The stamp is the part worth stating. Replacing a picture reuses its object
 * key, so without it every reader keeps the one they already fetched — and the
 * person who just changed their face is the one most certain the app is broken.
 * `avatarUpdatedAt` is the only thing that changes on replace, which is why the
 * column exists at all.
 *
 * The key itself is never sent. It is an internal bucket path, and the route
 * below it is what applies the ACL and signs a short-lived URL.
 */
function avatarUrl(
  prefix: string,
  id: string,
  row: { avatarKey: string | null; avatarUpdatedAt: Date | null },
): AvatarUrl {
  if (!row.avatarKey) return null;
  const stamp = row.avatarUpdatedAt?.getTime() ?? 0;
  return `${prefix}/${id}/avatar?v=${stamp}`;
}

export function userAvatarUrl(
  row: { id: string; avatarKey: string | null; avatarUpdatedAt: Date | null } | null | undefined,
): AvatarUrl {
  return row ? avatarUrl('/v1/users', row.id, row) : null;
}

export function projectAvatarUrl(
  row: { id: string; avatarKey: string | null; avatarUpdatedAt: Date | null } | null | undefined,
): AvatarUrl {
  return row ? avatarUrl('/v1/projects', row.id, row) : null;
}
