// ---------------------------------------------------------------------------
// The spec diff's vocabulary (#78, phase 6).
//
// A leaf with no imports: `CompareResponse` (documents) carries an `api` diff,
// and documents is reached from graph, which `api/index.ts` imports at
// runtime — so the diff types living there would close a runtime cycle.
// ---------------------------------------------------------------------------

export const API_CHANGE_SEVERITIES = ['breaking', 'non-breaking', 'info'] as const;
export type ApiChangeSeverity = (typeof API_CHANGE_SEVERITIES)[number];

/**
 * The closed catalogue of what a spec diff can report, each with its fixed
 * severity. Closed because the classifier, the merge gate, the UI's one label
 * per rule and the MCP tool's description must name the same set — and every
 * id here is one the classifier emits.
 *
 * "Breaking" means a client written against the old spec can fail against the
 * new one: something it calls or reads is gone, or something it never sent is
 * now required. Request-side removals are not breaking — a server ignores what
 * it no longer reads — and response-side additions are only info.
 */
export const API_CHANGE_RULES = {
  'operation-removed': 'breaking',
  'operation-added': 'non-breaking',
  'operation-deprecated': 'info',
  'required-param-added': 'breaking',
  'optional-param-added': 'non-breaking',
  'param-removed': 'non-breaking',
  'param-became-required': 'breaking',
  'param-type-changed': 'breaking',
  'request-body-required': 'breaking',
  'request-property-required-added': 'breaking',
  'property-type-changed': 'breaking',
  'enum-value-removed': 'breaking',
  'enum-value-added': 'info',
  'response-status-removed': 'breaking',
  'response-status-added': 'non-breaking',
  'response-property-removed': 'breaking',
  'response-property-added': 'info',
  'security-requirement-added': 'breaking',
  'security-requirement-removed': 'non-breaking',
  'channel-removed': 'breaking',
  'channel-added': 'non-breaking',
  'message-payload-field-removed': 'breaking',
  'message-payload-field-added': 'info',
} as const satisfies Record<string, ApiChangeSeverity>;
export type ApiChangeRule = keyof typeof API_CHANGE_RULES;
export const API_CHANGE_RULE_IDS = Object.keys(API_CHANGE_RULES) as ApiChangeRule[];

/** One classified change. `subject` names what changed inside the operation. */
export interface ApiSpecChange {
  rule: ApiChangeRule;
  severity: ApiChangeSeverity;
  /** The operation or channel the change is on. */
  entityKey: string;
  protocol: 'http' | 'async';
  method: string | null;
  /** As the side that still has it spells it: the new side, or the old one for a removal. */
  path: string;
  /** JSON pointer to the operation on that side. */
  pointer: string;
  /** `query.limit`, `body.customer.email`, `200`, `200 body.items[].id`, `bearerAuth`… null for the operation itself. */
  subject: string | null;
  before: string | null;
  after: string | null;
}

export interface ApiSpecDiffSummary {
  breaking: number;
  nonBreaking: number;
  info: number;
}

/** GET /v1/api-specs/:documentId/diff, `compare.api`, and the MR panel. */
export interface ApiSpecDiff {
  documentId: string;
  /** Null when there is nothing before: every operation is added. */
  fromRevisionId: string | null;
  toRevisionId: string;
  summary: ApiSpecDiffSummary;
  /** Breaking first, then non-breaking, then info; in spec order within each. */
  changes: ApiSpecChange[];
}
