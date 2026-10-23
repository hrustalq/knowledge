import { createHash } from 'node:crypto';
import type { ApiTestCaseSpec } from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';
import type { ResolvedAgent } from './agent-registry.service.js';

/**
 * The tester (#468): one API operation's QA suite. The cases are the
 * catalogue's (`testCasesFor`), never the model's — it is shown the list and
 * fills realistic values and words for it. Pure helpers, like `scribe.ts`.
 */

/** How much of the operation's spec excerpt the model is shown. */
const MAX_SPEC_CHARS = 30_000;

export const TESTER_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape {"baseline": {"path": object, "query": object, "headers": ' +
  'object, "body": any}, "cases": {"<case id>": {"name": string, "description": string, "expectation": string, ' +
  '"value"?: string, "path"?: object, "query"?: object}}}. "baseline" is ONE realistic, valid request every ' +
  'case starts from: a value for every required parameter and a body that satisfies the schema, written the ' +
  'way a real client of this API would (plausible ids, names, amounts), never placeholders like "string". ' +
  'Leave credentials out. "cases" has an entry for every case id you were given, copied exactly: "name" is a ' +
  'short title a QA engineer would give the test, "description" says in one sentence what it checks, ' +
  '"expectation" what a tester should verify in the response beyond its status. Give "value" only for a case ' +
  'whose id starts with "pattern:match:" — a realistic value that matches that field\'s pattern. Give "path" or ' +
  '"query" only for a "documented-error:" case, with the values that provoke that status (an id that does not ' +
  'exist for a 404). Do not invent cases; the list is complete.';

/**
 * The user turn. The case list is ours and trusted; the spec excerpt is the
 * spec author's text and reaches the model only wrapped untrusted.
 */
export function testerPrompt(op: { method: string; path: string }, cases: ApiTestCaseSpec[], fingerprint: string): string {
  const list = cases
    .map((c) => `- ${c.id} — ${c.kind}, ${c.rule}${c.target ? ` on ${c.target}` : ''}, expects ${c.expectedStatus}`)
    .join('\n');
  return (
    `Write the QA test suite for ${op.method.toUpperCase()} ${op.path}.\n\n` +
    `The cases, by id:\n${list}\n\n` +
    "The operation's part of the spec (the operation, every schema it reaches, servers and security):\n" +
    wrapUntrusted(fingerprint.slice(0, MAX_SPEC_CHARS), 'api_spec', 'spec')
  );
}

/**
 * The agent half of the cache key: what an admin can change about the tester
 * — its instructions, its skills, the model it runs on. An override of any of
 * them is a new key, so the next Generate asks the model again.
 */
export function testerConfigHash(agent: Pick<ResolvedAgent, 'instructions' | 'skillIds' | 'config'>): string {
  const model = agent.config.enabled ? [agent.config.providerId, agent.config.model] : [null, null];
  return createHash('sha256')
    .update(JSON.stringify([agent.instructions, [...agent.skillIds].sort(), ...model]))
    .digest('hex');
}
