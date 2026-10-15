import { Prisma } from '@prisma/client';
import {
  accessRank,
  type AccessLevel,
  type AccessResourceType,
  type EffectiveAccessLevel,
  type WorkspaceRole,
} from '@knowledge/contracts';

/**
 * Who is asking, as far as page levels care (#76). Enough to rank one person's
 * grants on a chain of nodes — `levelOn` needs nothing else, which is what lets
 * "who can see this" run it for every member without a scope per member.
 */
export interface AccessIdentity {
  userId: string;
  /** The workspace role; null only for a platform admin or the dev principal outside the roster. */
  role: WorkspaceRole | null;
  /** Workspace admin, platform admin or AUTH_MODE=none: sees and manages everything. */
  bypass: boolean;
  guest: boolean;
  /** A read-only `kn_` key caps every level at `view`. */
  readOnly: boolean;
  groupIds: ReadonlySet<string>;
}

/**
 * One caller's visibility over one workspace, computed once per request
 * (`PermissionService.scopeFor`) and read by every list that returns pages.
 *
 * Two sets carry the whole predicate. `denied` is every restricted node the
 * caller holds no grant on: a page is hidden as soon as its `restricted_by`
 * names one. `granted` is every node the caller or their groups hold a grant
 * on: a guest reaches only pages with one of those on their chain.
 */
export interface AccessScope extends AccessIdentity {
  workspaceId: string;
  denied: ReadonlySet<string>;
  granted: ReadonlySet<string>;
}

/** The columns the predicate reads. */
export interface VisibilityRow {
  projectId: string;
  path: string;
  restrictedBy: string[];
}

/** A node on the way from the project down to a page, outermost first. */
export interface ChainNode {
  type: AccessResourceType;
  id: string;
  restricted: boolean;
}

export interface GrantRow {
  resourceId: string;
  subjectType: string;
  subjectId: string;
  level: string;
}

/**
 * Whether this scope keeps any page from its holder. False exactly when
 * `visibilityWhere` is `{}`: an admin, or a member nothing is restricted from.
 */
export function hidesAnything(scope: AccessScope): boolean {
  return !scope.bypass && (scope.guest || scope.denied.size > 0);
}

/**
 * A scope that sees the whole workspace, for a reader acting for no person —
 * today only the retrieval backtest, an operator's script. Agent, workflow and
 * chat runs act for their owner, clamped to their audience (`clampToAudience`).
 * A named function rather than a hand-built literal, so every such caller can
 * be found.
 */
export function systemScope(workspaceId: string): AccessScope {
  return {
    workspaceId,
    userId: '00000000-0000-0000-0000-000000000000',
    role: null,
    bypass: true,
    guest: false,
    readOnly: true,
    groupIds: new Set(),
    denied: new Set(),
    granted: new Set(),
  };
}

/**
 * Who will read what a run writes (#76). A reply in a thread on page P is read
 * by whoever can open P; an agent run's findings, a chat digest or a bot answer
 * in a group are read by the whole workspace (or by people it cannot vouch for
 * at all), so they get the narrowest audience: pages every member can open.
 */
export type Audience = { kind: 'workspace' } | { kind: 'document'; documentId: string };

export const WORKSPACE_AUDIENCE: Audience = { kind: 'workspace' };

/**
 * Pages every member of the workspace can open: nothing on their chain is
 * restricted. The audience clamp for an output that names pages to people
 * nobody can enumerate, with no one person's scope to start from.
 */
export const OPEN_TO_WORKSPACE: Prisma.DocumentWhereInput = { restrictedBy: { isEmpty: true } };

/**
 * The audience clamp (#76): `scope` narrowed so a page D survives only when
 * `D.restricted_by ⊆ audienceNodes` — the destination page's own
 * `restricted_by`, or nothing for a workspace-wide audience. Everyone who can
 * read the destination then satisfies every restricted node on D's chain, so
 * what the run cites cannot reach anyone through it who could not open D.
 *
 * Expressed as more `denied`, so every reader of a scope (`canSee`,
 * `visibilityWhere`, `visibilitySql`, `documentFilterFor`) applies it unchanged.
 * `restrictedNodes` is every restricted node in the workspace; the ones outside
 * the audience join `denied`. A clamped scope never bypasses: an admin's run
 * posting into a thread is clamped like anyone's, since the admin is not the
 * one reading it.
 *
 * Conservative by construction: D and P restricted to the same people through
 * different nodes still drops D. Not a grant check on the audience — `levelOn`
 * would refuse an admin owner the destination's own chain, so the readers of a
 * clamped scope are the set-based ones above.
 */
export function clampToAudience(
  scope: AccessScope,
  restrictedNodes: Iterable<string>,
  audienceNodes: ReadonlySet<string>,
): AccessScope {
  const outside = [...restrictedNodes].filter((id) => !audienceNodes.has(id));
  return {
    ...scope,
    bypass: false,
    denied: new Set(scope.bypass ? outside : [...scope.denied, ...outside]),
  };
}

/** The project, then every id in `path` (ancestors root-first, then self). */
export function chainIds(row: Pick<VisibilityRow, 'projectId' | 'path'>): string[] {
  return [row.projectId, ...row.path.split('/').filter(Boolean)];
}

/**
 * The visibility predicate, in memory. `visibilityWhere` is the same rule as a
 * Prisma filter, and the two are pinned against each other in
 * test/permissions.spec.ts — a second spelling of an ACL is only safe while
 * something proves it says the same thing.
 */
export function canSee(scope: AccessScope, row: VisibilityRow): boolean {
  if (scope.bypass) return true;
  if (row.restrictedBy.some((id) => scope.denied.has(id))) return false;
  if (scope.guest) return chainIds(row).some((id) => scope.granted.has(id));
  return true;
}

/**
 * The visibility predicate as a `documents` filter. `{}` for a caller who sees
 * everything, so a workspace with no restrictions runs the queries it ran
 * before this existed.
 *
 * The overlap test (`restricted_by && denied`) is served by the GIN index. A
 * guest's reach is a path match per granted node, so it grows with their
 * grants — a guest holds a handful by definition.
 */
export function visibilityWhere(scope: AccessScope): Prisma.DocumentWhereInput {
  if (scope.bypass) return {};
  const parts: Prisma.DocumentWhereInput[] = [];
  if (scope.denied.size > 0) parts.push({ NOT: { restrictedBy: { hasSome: [...scope.denied] } } });
  if (scope.guest) {
    const granted = [...scope.granted];
    parts.push(
      granted.length === 0
        ? { id: { in: [] } }
        : { OR: [{ projectId: { in: granted } }, ...granted.map((id) => ({ path: { contains: `/${id}/` } }))] },
    );
  }
  return parts.length === 0 ? {} : { AND: parts };
}

/**
 * The same predicate for raw SQL over `documents <alias>`. `TRUE` for a caller
 * who sees everything. `alias` is a fixed identifier from the call site, never
 * input.
 */
export function visibilitySql(scope: AccessScope, alias: string): Prisma.Sql {
  if (scope.bypass) return Prisma.sql`TRUE`;
  const d = Prisma.raw(alias);
  const parts: Prisma.Sql[] = [];
  if (scope.denied.size > 0) parts.push(Prisma.sql`NOT (${d}.restricted_by && ${[...scope.denied]}::uuid[])`);
  if (scope.guest) {
    const granted = [...scope.granted];
    parts.push(
      granted.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`(${d}.project_id = ANY(${granted}::uuid[])
            OR string_to_array(trim(both '/' from ${d}.path), '/') && ${granted}::text[])`,
    );
  }
  return parts.length === 0 ? Prisma.sql`TRUE` : Prisma.join(parts, ' AND ');
}

function maxLevel(levels: string[]): EffectiveAccessLevel {
  let best: EffectiveAccessLevel = 'none';
  for (const level of levels) {
    if (accessRank(level as AccessLevel) > accessRank(best)) best = level as AccessLevel;
  }
  return best;
}

/**
 * What one person may do with the last node of `chain` (#76).
 *
 * - Every restricted node on the chain must hold a grant for them, or they see
 *   nothing (intersective: a child narrows, never re-opens).
 * - A guest additionally needs a grant somewhere on the chain, and their level
 *   is what those grants say, capped at `edit`.
 * - Otherwise the workspace role is the ceiling: viewer reads, editor edits.
 * - Edit is decided by the nearest restricted node carrying any edit/manage
 *   grant: when one exists, only its edit/manage grantees edit below it.
 * - Manage (change restrictions) belongs to whoever edits, unless the nearest
 *   restricted node carrying a manage grant says otherwise — then only holders
 *   of a manage grant on the chain do. That is Confluence's rule: an editor may
 *   restrict an open page, and the page's managers keep it once they exist.
 * - Workspace admins manage everything; a read-only key caps all of it at view.
 */
export function levelOn(who: AccessIdentity, chain: ChainNode[], grants: GrantRow[]): EffectiveAccessLevel {
  if (who.bypass) return who.readOnly ? 'view' : 'manage';

  const mine = (nodeId: string): EffectiveAccessLevel =>
    maxLevel(
      grants
        .filter(
          (g) =>
            g.resourceId === nodeId &&
            ((g.subjectType === 'user' && g.subjectId === who.userId) ||
              (g.subjectType === 'group' && who.groupIds.has(g.subjectId))),
        )
        .map((g) => g.level),
    );

  const restricted = chain.filter((n) => n.restricted);
  if (restricted.some((n) => mine(n.id) === 'none')) return 'none';

  let level: EffectiveAccessLevel;
  if (who.guest) {
    level = maxLevel(chain.map((n) => mine(n.id)).filter((l) => l !== 'none'));
    if (level === 'none') return 'none';
    if (level === 'manage') level = 'edit';
  } else {
    level = who.role === 'editor' ? 'edit' : 'view';
  }

  // Nearest first: the deepest restricted node whose grants say anything about `atLeast`.
  const gate = (atLeast: AccessLevel) =>
    [...restricted]
      .reverse()
      .find((n) => grants.some((g) => g.resourceId === n.id && accessRank(g.level as AccessLevel) >= accessRank(atLeast)));

  if (level === 'edit') {
    const editGate = gate('edit');
    if (editGate && accessRank(mine(editGate.id)) < accessRank('edit')) level = 'view';
  }
  if (level === 'edit' && !who.guest) {
    const holdsManage = chain.some((n) => mine(n.id) === 'manage');
    if (holdsManage || !gate('manage')) level = 'manage';
  }
  if (who.readOnly && accessRank(level) > accessRank('view')) level = 'view';
  return level;
}
