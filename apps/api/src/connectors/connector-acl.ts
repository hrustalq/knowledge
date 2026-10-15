import type { ConnectorAclMode } from '@knowledge/contracts';
import type { ExternalAcl } from './adapters/connector.types.js';
import { sha256 } from './connector-markdown.js';

/*
 * The decision half of connector ACL mirroring (#76, phase 6), pure so it can
 * be tested without a source: what one page's restriction should be, given
 * what upstream said and who those principals are here.
 *
 * A mirrored ACL is an ordinary restriction — `documents.restricted` plus
 * `access_grants` rows with `origin = 'connector'` — so `restricted_by`, the
 * re-stamp sweeper and every enforcement point apply to it unchanged. There is
 * one ACL engine, and this only decides what to write into it.
 */

/**
 * What staging read for one item, as stored on `connector_run_items.acl`.
 *
 * - `acl`: the adapter's answer.
 * - `error`: the adapter could not say. Fails closed.
 * - `audience`: the kind has no per-item ACLs; the connector's audience group applies.
 */
export type StoredAcl =
  | { kind: 'acl'; acl: ExternalAcl }
  | { kind: 'error'; message: string }
  | { kind: 'audience' };

export interface PlannedGrant {
  subjectType: 'user' | 'group';
  subjectId: string;
  level: 'view' | 'edit';
}

export interface AclPlan {
  restricted: boolean;
  grants: PlannedGrant[];
  /** Upstream principals with no person or group here, by upstream name (or id). */
  unmapped: string[];
}

export interface AclPlanInput {
  stored: StoredAcl;
  mode: Exclude<ConnectorAclMode, 'off'>;
  audienceGroupId: string | null;
  /** `connectors.created_by`. Null when the creator is gone. */
  ownerId: string | null;
  /** Upstream user id → our user id, for the ones that resolve. */
  users: ReadonlyMap<string, string>;
  /** Upstream group id → our mirrored group id. */
  groups: ReadonlyMap<string, string>;
}

export function planAcl(input: AclPlanInput): AclPlan {
  const ownerOnly = (): PlannedGrant[] =>
    input.ownerId ? [{ subjectType: 'user', subjectId: input.ownerId, level: 'view' }] : [];

  if (input.stored.kind === 'error') {
    // Not knowing who may read a page is not a reason to let everyone read it.
    return { restricted: true, grants: ownerOnly(), unmapped: [] };
  }
  if (input.stored.kind === 'audience') {
    return input.audienceGroupId
      ? { restricted: true, grants: [{ subjectType: 'group', subjectId: input.audienceGroupId, level: 'view' }], unmapped: [] }
      : { restricted: true, grants: ownerOnly(), unmapped: [] };
  }

  const { acl } = input.stored;
  if (acl.audience === 'source-wide') return { restricted: false, grants: [], unmapped: [] };

  const grants: PlannedGrant[] = [];
  const unmapped: string[] = [];
  for (const p of acl.principals) {
    const subjectId = p.type === 'user' ? input.users.get(p.externalId) : input.groups.get(p.externalId);
    if (subjectId) grants.push({ subjectType: p.type, subjectId, level: p.level });
    else unmapped.push(p.name || p.externalId);
  }
  if (input.mode === 'mirror_strict' && unmapped.length > 0) grants.push(...ownerOnly());
  return { restricted: true, grants: dedupeGrants(grants), unmapped };
}

/** One grant per subject, the strongest level kept, in a stable order. */
export function dedupeGrants(grants: PlannedGrant[]): PlannedGrant[] {
  const bySubject = new Map<string, PlannedGrant>();
  for (const g of grants) {
    const key = `${g.subjectType}:${g.subjectId}`;
    const prior = bySubject.get(key);
    bySubject.set(key, prior && prior.level === 'edit' ? prior : g);
  }
  return [...bySubject.values()].sort((a, b) =>
    `${a.subjectType}:${a.subjectId}`.localeCompare(`${b.subjectType}:${b.subjectId}`),
  );
}

/**
 * What `connector_links.acl_hash` stores: the restriction as it will be
 * written, after mapping. A changed mapping therefore changes the hash too, so
 * someone who signs up after the import is admitted on the next sync even
 * though nothing moved upstream.
 */
export function aclPlanHash(plan: AclPlan): string {
  return sha256(JSON.stringify({ r: plan.restricted, g: plan.grants }));
}

/** Due when never synced, or when the interval has passed since the last ACL sync. */
export function aclSyncDue(syncedAt: Date | null, intervalMinutes: number, now: number): boolean {
  return !syncedAt || syncedAt.getTime() + intervalMinutes * 60_000 <= now;
}
