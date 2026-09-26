import type {
  GithubAccessPurpose,
  GithubEventRow,
  GithubGrantLevel,
  GithubGrantStatus,
  GithubPermissionRow,
} from '@knowledge/contracts';

/**
 * What this product needs from the GitHub App, and where a connector stands
 * against it (docs/features/36).
 *
 * Pure and Nest-free so the comparison — granted against requested against
 * needed — can be tested without GitHub. The catalogue below is the one place
 * a feature's GitHub needs are written down; every row the access card shows
 * is computed from it, so a feature that starts needing a permission adds a
 * line here and the card starts asking for it.
 */

interface PermissionRequirement {
  name: string;
  level: GithubGrantLevel;
  purpose: GithubAccessPurpose;
}

interface EventRequirement {
  name: string;
  purpose: GithubAccessPurpose;
}

export const GITHUB_PERMISSION_REQUIREMENTS: readonly PermissionRequirement[] = [
  // Every App gets metadata; listed so the card shows the full picture.
  { name: 'metadata', level: 'read', purpose: 'sync' },
  // The archive download, and the code research tools (features 27, 31).
  { name: 'contents', level: 'read', purpose: 'sync' },
  // markdown-git publishing a page back to the repository (feature 19).
  { name: 'contents', level: 'write', purpose: 'push' },
  // Listing, opening and commenting on issues (feature 32).
  { name: 'issues', level: 'write', purpose: 'work-items' },
  // The diff and the one comment on the pull request (feature 35).
  { name: 'pull_requests', level: 'write', purpose: 'drift-check' },
  // Board membership on the work items tab — decoration, never required.
  { name: 'organization_projects', level: 'read', purpose: 'boards' },
];

export const GITHUB_EVENT_REQUIREMENTS: readonly EventRequirement[] = [
  { name: 'pull_request', purpose: 'drift-check' },
  { name: 'pull_request', purpose: 'work-items' },
  { name: 'issues', purpose: 'work-items' },
  { name: 'issue_comment', purpose: 'work-items' },
  { name: 'push', purpose: 'repo-events' },
  { name: 'release', purpose: 'repo-events' },
];

const RANK: Record<GithubGrantLevel, number> = { read: 1, write: 2, admin: 3 };

/** GitHub's values are strings; anything that is not a level reads as absent. */
export function asLevel(value: unknown): GithubGrantLevel | null {
  return value === 'read' || value === 'write' || value === 'admin' ? value : null;
}

function atLeast(have: GithubGrantLevel | null, need: GithubGrantLevel): boolean {
  return have !== null && RANK[have] >= RANK[need];
}

function strongest(levels: GithubGrantLevel[]): GithubGrantLevel | null {
  return levels.reduce<GithubGrantLevel | null>((a, b) => (a === null || RANK[b] > RANK[a] ? b : a), null);
}

/** Problems first — the rows a person came to this card to fix — then by name. */
const ORDER: Record<GithubGrantStatus, number> = { missing: 0, pending: 1, granted: 2, extra: 3 };
function byStatus<T extends { status: GithubGrantStatus; active: boolean; name: string }>(a: T, b: T): number {
  const problem = (r: T) => (r.active && (r.status === 'missing' || r.status === 'pending') ? 0 : 1);
  return problem(a) - problem(b) || ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name);
}

/**
 * One row per permission anybody has an opinion about: granted to the
 * installation, requested by the App, or needed here.
 *
 * `needed` is the strongest level any **active** purpose asks for, falling back
 * to the strongest of all of them for a row nothing active uses — so an
 * inactive row still says what it would take, without being called a problem.
 */
export function permissionRows(
  granted: Record<string, unknown>,
  requested: Record<string, unknown>,
  active: ReadonlySet<GithubAccessPurpose>,
): GithubPermissionRow[] {
  const names = new Set([
    ...Object.keys(granted),
    ...Object.keys(requested),
    ...GITHUB_PERMISSION_REQUIREMENTS.map((r) => r.name),
  ]);
  const rows: GithubPermissionRow[] = [];
  for (const name of names) {
    const reqs = GITHUB_PERMISSION_REQUIREMENTS.filter((r) => r.name === name);
    const live = reqs.filter((r) => active.has(r.purpose));
    const needed = strongest((live.length ? live : reqs).map((r) => r.level));
    const have = asLevel(granted[name]);
    const asked = asLevel(requested[name]);
    if (!have && !asked && !needed) continue;

    let status: GithubGrantStatus;
    if (!needed) status = 'extra';
    else if (atLeast(have, needed)) status = 'granted';
    else if (atLeast(asked, needed)) status = 'pending';
    else status = 'missing';

    rows.push({
      name,
      granted: have,
      requested: asked,
      needed,
      purposes: [...new Set(reqs.map((r) => r.purpose))],
      active: live.length > 0,
      status,
    });
  }
  return rows.sort(byStatus);
}

/** The webhook events, the same comparison with a boolean for a level. */
export function eventRows(
  subscribed: readonly string[],
  requested: readonly string[],
  active: ReadonlySet<GithubAccessPurpose>,
): GithubEventRow[] {
  const has = new Set(subscribed);
  const asked = new Set(requested);
  const names = new Set([...subscribed, ...requested, ...GITHUB_EVENT_REQUIREMENTS.map((r) => r.name)]);
  const rows: GithubEventRow[] = [];
  for (const name of names) {
    const reqs = GITHUB_EVENT_REQUIREMENTS.filter((r) => r.name === name);
    let status: GithubGrantStatus;
    if (reqs.length === 0) status = 'extra';
    else if (has.has(name)) status = 'granted';
    else if (asked.has(name)) status = 'pending';
    else status = 'missing';
    rows.push({
      name,
      subscribed: has.has(name),
      requested: asked.has(name),
      purposes: [...new Set(reqs.map((r) => r.purpose))],
      active: reqs.some((r) => active.has(r.purpose)),
      status,
    });
  }
  return rows.sort(byStatus);
}

/**
 * Which purposes a connector actually uses. Boards and repo events are never
 * active: both are optional — a board name is decoration, and a repo event only
 * matters to a workflow somebody may or may not have written — so a gap in
 * either is shown and never flagged.
 */
export function activePurposes(connector: {
  kind: string;
  direction: string;
  driftCheck: string;
}): Set<GithubAccessPurpose> {
  const active = new Set<GithubAccessPurpose>(['sync', 'work-items']);
  if (connector.kind === 'markdown-git' && connector.direction !== 'pull') active.add('push');
  if (connector.driftCheck !== 'off') active.add('drift-check');
  return active;
}
