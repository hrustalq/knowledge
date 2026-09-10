import { AGENT_MENTION_ATTR, USER_MENTION_ATTR } from '@knowledge/contracts';

/**
 * Reading agent mentions back out of a comment body.
 *
 * The editor writes a mention as `<span data-kn-agent="reviewer">@reviewer</span>`
 * and that markup travels into the comment verbatim, so this is a string scan
 * and not a parse: the attribute is machine-written, always quoted, and the key
 * vocabulary is narrow. A markdown parser here would buy nothing and would have
 * to be kept agreeing with the serializer that produced the text.
 *
 * The attribute name comes from contracts rather than being spelled here, so
 * the editor node, the turndown rule and this scanner cannot drift apart.
 */

/** Agent keys are slugs: lowercase, digits, dashes, underscores. */
const MENTION_RE = new RegExp(`${AGENT_MENTION_ATTR}="([a-z0-9][a-z0-9_-]{0,63})"`, 'gi');

/**
 * Every agent mentioned in `body`, deduped, in the order they first appear.
 *
 * Deduped because mentioning the same agent twice in one comment is a way of
 * writing, not a request for two answers — and because the claim that stops a
 * double reply is per (thread, agent), so a second one would simply fail.
 */
export function parseAgentMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    const key = match[1]?.toLowerCase();
    if (key) seen.add(key);
  }
  return [...seen];
}

/** Person mentions are uuids; agent keys are slugs, hence two patterns. */
const USER_MENTION_RE = new RegExp(
  `${USER_MENTION_ATTR}="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"`,
  'gi',
);

/**
 * Every person mentioned in `body`, deduped, in the order they first appear.
 *
 * Deduped for the reason agent mentions are: naming somebody twice in one
 * comment is a way of writing, not a request for two notifications — and the
 * inbox would coalesce them anyway.
 *
 * A uuid here is only a claim. The caller resolves it against
 * `workspace_members` before anything is written, because the attribute is
 * machine-written but the body is user-supplied: a hand-typed id from another
 * tenant must notify nobody.
 */
export function parseUserMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(USER_MENTION_RE)) {
    const id = match[1]?.toLowerCase();
    if (id) seen.add(id);
  }
  return [...seen];
}
