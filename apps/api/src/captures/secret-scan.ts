/**
 * The shapes of credentials an agent might paste into a capture (issue #73).
 * A capture becomes a page every member reads, so one that carries a key is
 * refused whole — before a row exists, so nothing stores it. Enforced here
 * rather than in the skill: an instruction the agent can ignore is not a rule.
 *
 * Shapes, not entropy: a false positive costs the agent one rewrite, a missed
 * key costs a rotation. Each pattern is a prefix a vendor documents.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ['knowledge-api-key', /\bk[ns]_[A-Za-z0-9_-]{20,}/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ['provider-api-key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** The first credential shape found in any of `texts`, by name — never the value. */
export function findSecret(texts: readonly string[]): string | null {
  for (const text of texts) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(text)) return name;
    }
  }
  return null;
}
