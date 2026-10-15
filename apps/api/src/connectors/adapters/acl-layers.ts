import type { ExternalAcl, ExternalGroupMember, ExternalPrincipal } from './connector.types.js';

/** Upstream names are source text: this long and no longer, wherever they are kept. */
export const MAX_PRINCIPAL_NAME = 200;

/**
 * Fold an item's restriction layers into one ACL (#76, phase 6).
 *
 * A source with inherited restrictions (Confluence: every restricted ancestor,
 * then the page itself) admits only who passes **every** layer — the same
 * intersective rule as `restricted_by`. When the page's ancestors were
 * imported as its ancestors here, the platform would do that intersection
 * itself; but a flat import puts them side by side, so the adapter folds the
 * layers before anything is written and a page reads correctly either way.
 *
 * - No layer: `source-wide`.
 * - One layer: that layer as it is, groups kept as groups.
 * - Several: groups are expanded to their people and the person sets are
 *   intersected. A group whose members cannot be read contributes nobody,
 *   which narrows the result — the direction to be wrong in.
 */
export async function combineLayers(
  layers: ExternalPrincipal[][],
  membersOf: ((group: ExternalPrincipal) => Promise<ExternalGroupMember[]>) | undefined,
): Promise<ExternalAcl> {
  const present = layers.filter((layer) => layer.length > 0);
  if (present.length === 0) return { audience: 'source-wide', principals: [] };
  if (present.length === 1) return { audience: 'restricted', principals: normalizePrincipals(present[0]) };

  const expanded = new Map<string, ExternalGroupMember[]>();
  const peopleOf = async (layer: ExternalPrincipal[]): Promise<Map<string, ExternalPrincipal>> => {
    const people = new Map<string, ExternalPrincipal>();
    for (const p of layer) {
      if (p.type === 'user') {
        people.set(p.externalId, p);
        continue;
      }
      if (!expanded.has(p.externalId)) {
        expanded.set(p.externalId, membersOf ? await membersOf(p).catch(() => []) : []);
      }
      for (const m of expanded.get(p.externalId)!) {
        if (!people.has(m.externalId)) people.set(m.externalId, { type: 'user', level: p.level, ...m });
      }
    }
    return people;
  };

  let result = await peopleOf(present[0]);
  for (const layer of present.slice(1)) {
    const next = await peopleOf(layer);
    const kept = new Map<string, ExternalPrincipal>();
    for (const [id, p] of result) {
      const other = next.get(id);
      // Both layers must admit them; the weaker of the two levels holds.
      if (other) kept.set(id, { ...p, level: p.level === 'edit' && other.level === 'edit' ? 'edit' : 'view' });
    }
    result = kept;
  }
  return { audience: 'restricted', principals: normalizePrincipals([...result.values()]) };
}

/**
 * One entry per principal (the strongest level wins), names and emails
 * trimmed to size, in a stable order — so the same upstream ACL always hashes
 * the same.
 */
export function normalizePrincipals(principals: ExternalPrincipal[]): ExternalPrincipal[] {
  const byKey = new Map<string, ExternalPrincipal>();
  for (const p of principals) {
    const externalId = String(p.externalId).slice(0, MAX_PRINCIPAL_NAME);
    if (!externalId) continue;
    const key = `${p.type}:${externalId}`;
    const prior = byKey.get(key);
    const level = prior?.level === 'edit' || p.level === 'edit' ? 'edit' : 'view';
    byKey.set(key, {
      type: p.type,
      externalId,
      level,
      ...(p.name ? { name: String(p.name).slice(0, MAX_PRINCIPAL_NAME) } : prior?.name ? { name: prior.name } : {}),
      ...(p.email ? { email: String(p.email).slice(0, MAX_PRINCIPAL_NAME).toLowerCase() } : prior?.email ? { email: prior.email } : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => `${a.type}:${a.externalId}`.localeCompare(`${b.type}:${b.externalId}`));
}
