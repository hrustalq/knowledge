/**
 * Pure builders for `llms.txt` / `llms-full.txt` (issue #68, phase 2), in the
 * llmstxt.org shape: an H1, a blockquote, `##` sections of `- [title](url)`
 * links. No Nest, no I/O — golden strings live in `test/llms-txt.spec.ts`.
 */

/** A readable page as the index needs it: PG columns only, never the body. */
export interface IndexPage {
  id: string;
  title: string;
  category: string;
  parentId: string | null;
  position: number;
  projectId: string;
  headRevisionId: string;
  s3Key: string;
}

export interface OrderedPage extends IndexPage {
  depth: number;
}

const bySibling = (a: IndexPage, b: IndexPage) => a.position - b.position || a.title.localeCompare(b.title);

/**
 * Tree order: depth-first, siblings by `position, title` (the same order the
 * tree view draws). A page whose parent is not exported — a draft-only parent,
 * another project, a legacy dangling `parentId` — surfaces as a root, as the
 * tree does. Anything a corrupt cycle kept out of the walk is appended as a
 * root rather than dropped: an index that silently loses pages is worse.
 */
export function orderPages(pages: IndexPage[]): OrderedPage[] {
  const ids = new Set(pages.map((p) => p.id));
  const children = new Map<string | null, IndexPage[]>();
  for (const p of pages) {
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    const list = children.get(key) ?? [];
    list.push(p);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort(bySibling);

  const out: OrderedPage[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const p of children.get(parent) ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ ...p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const p of [...pages].sort(bySibling)) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ ...p, depth: 0 });
    walk(p.id, 1);
  }
  return out;
}

/** Link text must not close the `[...]` early. */
function linkText(s: string): string {
  return s.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\s+/g, ' ');
}

export interface IndexLink {
  id: string;
  title: string;
  category: string;
  depth: number;
  url: string;
}

export function renderLlmsIndex(input: {
  title: string;
  blurb: string;
  fullUrl: string;
  sections: { heading: string; pages: IndexLink[] }[];
}): string {
  const lines = [`# ${input.title}`, '', `> ${input.blurb}`, '', `Full text: ${input.fullUrl}`, ''];
  for (const s of input.sections) {
    if (s.pages.length === 0) continue;
    lines.push(`## ${s.heading}`, '');
    for (const p of s.pages) {
      lines.push(`${'  '.repeat(p.depth)}- [${linkText(p.title)}](${p.url}): ${p.category}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const LEADING_H1 = /^#[ \t]+\S[^\n]*\n?/;

/** One page inside `llms-full.txt`: its heading, a `Source:` line, the body. */
export function renderFullPage(input: { title: string; body: string; url: string }): string {
  const body = input.body.replace(/^\s*\n/, '');
  const h1 = LEADING_H1.exec(body);
  const heading = h1 ? h1[0].trimEnd() : `# ${input.title}`;
  const rest = (h1 ? body.slice(h1[0].length) : body).replace(/^\s*\n/, '');
  return `${heading}\n\nSource: ${input.url}\n\n${rest}`;
}

export function renderFullHeader(input: { title: string; indexUrl: string }): string {
  return `# ${input.title}: full text\n\n> Every readable page, concatenated in tree order. Index: ${input.indexUrl}\n\n`;
}

export function truncatedMarker(remaining: number, see: string[]): string {
  const noun = remaining === 1 ? 'page' : 'pages';
  const hint = see.length > 0 ? `; see ${see.join(' ')}` : '';
  return `\n<!-- truncated: ${remaining} more ${noun}${hint} -->\n`;
}

export function unavailableMarker(documentId: string): string {
  return `<!-- unavailable: ${documentId} -->\n\n`;
}

export interface HubWorkspace {
  workspaceId: string;
  name: string;
  projects: { projectId: string; name: string }[];
}

/** `/v1/llms.txt`: what the caller can reach, one section per workspace. */
export function renderHub(apiBase: string, workspaces: HubWorkspace[]): string {
  const lines = [
    '# Knowledge',
    '',
    '> Plain-text indexes of the knowledge base this key can read. Each links to pages as markdown.',
    '',
  ];
  for (const w of workspaces) {
    lines.push(`## ${w.name}`, '');
    lines.push(`- [${linkText(w.name)}: all projects](${apiBase}/v1/workspaces/${w.workspaceId}/llms.txt)`);
    lines.push(`- [${linkText(w.name)}: full text](${apiBase}/v1/workspaces/${w.workspaceId}/llms-full.txt)`);
    for (const p of w.projects) lines.push(`- [${linkText(p.name)}](${apiBase}/v1/projects/${p.projectId}/llms.txt)`);
    lines.push('');
  }
  return lines.join('\n');
}
