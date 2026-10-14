import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reading an inbound webhook: verify the signature, then parse the body.
 *
 * A leaf, imported by whoever needs it, rather than exports on
 * `confluence.adapter.ts` where both of these grew up. Four adapters were
 * already importing them from there, which was a smell nobody had to pay for
 * until the App-level webhook (docs/features/32) wanted them from a controller
 * — and `dip-connector-adapter-stays-behind-the-registry` correctly refuses
 * that, because reaching a named adapter is how the closed catalogue in
 * `CONNECTOR_KIND_INFO` stops being the single source of truth.
 *
 * Lifting a shared helper into a leaf rather than routing around the rule is
 * the house answer; these two are about HTTP and HMAC and know nothing about
 * Confluence.
 */

/**
 * GitHub's `X-Hub-Signature-256` over the raw request body.
 *
 * Both the per-connector hook and the App-level one authenticate this way, with
 * different secrets. The comparison is `timingSafeEqual` over decoded bytes
 * rather than string equality — a signature check that returns early on the
 * first wrong character leaks the expected value a byte at a time.
 *
 * The body must be the **raw** bytes: Express has parsed and discarded them by
 * the time a handler runs, and re-serialising the parsed object does not
 * reproduce them, which is why `rawBody: true` is set in `main.ts`.
 */
export function verifyHubSignature(headers: Record<string, string>, rawBody: string, secret: string): boolean {
  const header = headers['x-hub-signature-256'] ?? headers['x-hub-signature'] ?? '';
  const sent = header.replace(/^sha256=/, '');
  if (!sent) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(sent, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse a payload we did not write. Anything that is not an object reads as absent. */
export function safeJson(raw: string): Record<string, any> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * A push or a published release, read from either host's delivery
 * (docs/features/46). `branch` is null for a release — a tag is always worth a
 * run, and has no branch to filter on. Null when the delivery is neither.
 *
 * GitHub: `X-GitHub-Event: push` / `release` (action `published`).
 * GitLab: `X-Gitlab-Event: Push Hook` / `Release Hook` (action `create`). A tag
 * push (`Tag Push Hook`) is not a release and starts nothing; GitLab's release
 * object is what says a version was published.
 */
export function readRepoPushDelivery(
  headers: Record<string, string>,
  payload: Record<string, any> | null,
): { branch: string | null; defaultBranch: string | null } | null {
  if (!payload) return null;
  const github = headers['x-github-event'];
  const gitlab = headers['x-gitlab-event'];
  const defaultBranch =
    typeof payload.repository?.default_branch === 'string'
      ? payload.repository.default_branch
      : typeof payload.project?.default_branch === 'string'
        ? payload.project.default_branch
        : null;

  if (github === 'push' || gitlab === 'Push Hook') {
    const ref: unknown = payload.ref;
    if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) return null;
    // A branch deletion is a push too, with nothing to read.
    if (payload.deleted === true || /^0+$/.test(String(payload.after ?? ''))) return null;
    return { branch: ref.slice('refs/heads/'.length), defaultBranch };
  }
  if ((github === 'release' && payload.action === 'published') || (gitlab === 'Release Hook' && payload.action === 'create')) {
    return { branch: null, defaultBranch };
  }
  return null;
}
