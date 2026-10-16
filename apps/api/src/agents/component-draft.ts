import type { AgentRunComponent, AssistantWebSource } from '@knowledge/contracts';
import { parseMarkdown } from '../common/frontmatter.js';
import type { RepoSnapshot } from '../connectors/code-research/repo-snapshot.service.js';
import { MIN_DRAFT_CHARS, readCodeSources } from './archaeology.js';

/**
 * The deterministic half of "Document this component" (#236, phase 5).
 *
 * The archaeologist reads the declared files and fills the `component`
 * template's sections; everything around that judgement is decided here,
 * without a model. The frontmatter in particular is computed, never written by
 * the model: the `component:` block is what ties the page to the code, and a
 * model that could edit it could tie the page to other code than it read.
 */

/** Characters of one declared file shown up front; the model reads the rest through the tools. */
export const MAX_COMPONENT_PREVIEW_CHARS = 12_000;
/** Characters of all declared files shown together, so ten files cannot fill the context on their own. */
export const MAX_COMPONENT_PREVIEW_TOTAL = 36_000;
/** The archaeologist's own cap on a draft. */
const MAX_DRAFT_CHARS = 40_000;

export const COMPONENT_DRAFT_CONTRACT =
  'You are documenting one component of a repository from its source. You are given the page skeleton: a ' +
  'markdown body whose "## " headings are the sections to fill. Respond ONLY with a json object of the shape ' +
  '{"markdown": string, "sources": [{"path": string, "startLine": number, "endLine": number, "note": string}]}. ' +
  '"markdown" is the skeleton with every section filled in: keep every heading, unchanged and in order, keep the ' +
  'lines above the first section as given, replace the placeholder rows and bullets, and write no frontmatter ' +
  'and no preamble. Describe only what the code shows. Under the public surface, list what the component ' +
  'exports or accepts (props, parameters, events, exports) exactly as declared. State an invariant only if the ' +
  'code enforces it, and write "Not determined from the code." in a section the code does not answer rather ' +
  'than guessing. Read what the files import with the code tools when a section needs it. No code fences longer ' +
  'than ten lines. "sources" cite only paths you actually read in this run, with the line range each claim ' +
  'rests on.';

/** The `## ` headings of a markdown body: the sections a draft must keep. */
export function sectionHeadings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^##\s+\S/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim());
}

/** The declared files, each cut to its share of the preview, for the prompt. */
export function componentPreviews(snapshot: RepoSnapshot, paths: readonly string[]): Array<{ path: string; text: string; lines: number }> {
  const share = Math.min(MAX_COMPONENT_PREVIEW_CHARS, Math.floor(MAX_COMPONENT_PREVIEW_TOTAL / Math.max(1, paths.length)));
  return paths.map((path) => {
    const text = Buffer.from(snapshot.files.get(path) ?? new Uint8Array()).toString('utf8');
    return { path, text: text.slice(0, share), lines: text.split('\n').length };
  });
}

export interface ComponentDraftBody {
  /** The filled body, without frontmatter. */
  markdown: string;
  sources: AssistantWebSource[];
}

/**
 * The model's page, validated rather than trusted. A body that drops a
 * section of the skeleton, or is too short to be a page, is refused: the
 * template's sections are the contract. Frontmatter the model wrote anyway is
 * dropped. Sources follow the archaeologist's rule (`readCodeSources`), and a
 * draft that cites nothing cites the declared files, which the run was shown.
 */
export function readComponentDraft(
  value: unknown,
  skeleton: string,
  snapshot: RepoSnapshot,
  readPaths: ReadonlySet<string>,
  declared: readonly string[],
): ComponentDraftBody | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.markdown !== 'string') return null;
  const markdown = parseMarkdown(raw.markdown.trim()).body.trim();
  if (markdown.length < MIN_DRAFT_CHARS) return null;
  const kept = new Set(sectionHeadings(markdown).map((h) => h.toLowerCase()));
  if (sectionHeadings(skeleton).some((h) => !kept.has(h.toLowerCase()))) return null;

  const cited = readCodeSources(raw.sources, snapshot, readPaths);
  const sources = cited.length > 0 ? cited : readCodeSources(declared.map((path) => ({ path })), snapshot, new Set(declared));
  return { markdown: markdown.slice(0, MAX_DRAFT_CHARS), sources };
}

/**
 * The page's frontmatter: the template's, with the declaration the run was
 * asked for in place of the template's one-path block — every file, the
 * repository the run read, and the symbols when some were given — and where
 * the draft came from, the keys `createPage` writes.
 */
export function componentFrontmatter(
  template: Record<string, unknown>,
  input: { repository: string; component: AgentRunComponent; source: string; generatedBy: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let block: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (key.trim().toLowerCase() !== 'component') out[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) block = value as Record<string, unknown>;
  }
  const { symbols: _templateSymbols, ...rest } = block;
  out.component = {
    ...rest,
    repository: input.repository,
    paths: [...input.component.paths],
    ...(input.component.symbols?.length ? { symbols: [...input.component.symbols] } : {}),
  };
  out.source = input.source;
  out.generatedBy = input.generatedBy;
  return out;
}
