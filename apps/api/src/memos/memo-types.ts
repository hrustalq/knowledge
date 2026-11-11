import { BUILT_IN_MEMO_TYPE_KEYS, type BuiltInMemoTypeKey, type MemoType } from '@knowledge/contracts';

/**
 * Memo types (#879): what kind of recording a memo is. Built-in types are
 * code; a workspace's `memo_types` rows override one's name or guidance, hide
 * one, or add its own. Pure, so the API's catalogue and the worker's
 * secretary read the same answer.
 *
 * Guidance is trusted text: it joins the secretary's instructions, which is
 * why only a workspace admin writes it. It steers what a memo's proposals
 * look like and nothing else. Which pages a memo may update is still decided
 * by `readMemoProposals`, whatever a type says.
 */
const BUILT_IN: Record<BuiltInMemoTypeKey, { name: string; guidance: string }> = {
  daily: {
    name: 'Daily',
    guidance:
      'This is a daily stand-up. Most of it is status and is not for the knowledge base. Keep only what was decided, ' +
      'changed or newly blocked. Prefer updating the page that tracks the work in question over creating a page; ' +
      'propose nothing when the stand-up settled nothing.',
  },
  retro: {
    name: 'Retrospective',
    guidance:
      'This is a retrospective. Propose one page for it: what went well, what did not, and the actions agreed, each ' +
      'action with what is to be done. Update an existing process or guideline page only where the team agreed to ' +
      'change how it works.',
  },
  'sprint-planning': {
    name: 'Sprint planning',
    guidance:
      'This is a sprint planning. Record the sprint goal, what was committed to and what was deliberately left out, ' +
      'on the page that plans this sprint if one exists, otherwise as a new page. Estimates and who takes what are ' +
      'worth keeping; the discussion that led there is not.',
  },
  'task-planning': {
    name: 'Task planning',
    guidance:
      'This is a session that breaks a piece of work into tasks. Record the approach chosen, the tasks with their ' +
      'order and dependencies, and the open questions, on the page that describes this piece of work if one exists, ' +
      'otherwise as a new page.',
  },
};

/** A built-in's text as shipped, so a form that sends it back unchanged stores nothing. */
export function shippedMemoType(key: string): { name: string; guidance: string } | undefined {
  return (BUILT_IN as Record<string, { name: string; guidance: string }>)[key];
}

export interface MemoTypeRow {
  key: string;
  name: string | null;
  guidance: string | null;
  hidden: boolean;
  projectId?: string | null;
  auto?: boolean;
}

/** The workspace's catalogue: built-ins as its rows left them, then its own types by name. Hidden ones included. */
export function effectiveMemoTypes(rows: readonly MemoTypeRow[]): MemoType[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const builtIn = BUILT_IN_MEMO_TYPE_KEYS.map((key): MemoType => {
    const row = byKey.get(key);
    return {
      key,
      name: row?.name?.trim() || BUILT_IN[key].name,
      guidance: row?.guidance?.trim() || BUILT_IN[key].guidance,
      builtIn: true,
      overridden: Boolean(row && (row.name?.trim() || row.guidance?.trim())),
      hidden: row?.hidden ?? false,
      projectId: row?.projectId ?? null,
      auto: row?.auto ?? false,
    };
  });
  const own = rows
    .filter((r) => !(BUILT_IN_MEMO_TYPE_KEYS as readonly string[]).includes(r.key))
    .map((r): MemoType => ({ key: r.key, name: r.name?.trim() || r.key, guidance: r.guidance?.trim() ?? '', builtIn: false, overridden: false, hidden: r.hidden, projectId: r.projectId ?? null, auto: r.auto ?? false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...builtIn, ...own];
}

/** What the secretary is told about this memo's kind; empty for no type, an unknown one, or one with no guidance. */
export function memoTypeBrief(types: readonly MemoType[], key: string | null | undefined): string {
  const type = key ? types.find((t) => t.key === key) : undefined;
  if (!type?.guidance) return '';
  return `\n\nThe uploader's workspace classes this recording as ${JSON.stringify(type.name)}. ${type.guidance}`;
}
