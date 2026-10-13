import { wrapUntrusted } from '../common/untrusted.js';

/** What the clause needs to know about a template: the resolved name and its parsed meta. */
export interface TemplateClauseInput {
  ref: string;
  version: number;
  name: string;
  description?: string;
  aiInstructions?: string;
}

/** Ceiling on the template notes carried into a turn — guidance, not a second page. */
const MAX_NOTES_CHARS = 4_000;

/**
 * Appended after the draft clause when the editor's draft started from a
 * template (issue #69). The rule is code-owned and trusted: the draft is a
 * skeleton, fill it section by section with `edit_draft`, keep its headings,
 * say `TODO:` where the material runs out.
 *
 * Everything the workspace wrote about the template — its name, description
 * and `aiInstructions` — goes inside the untrusted wrapper. Those are typed by
 * any member who may edit templates, which is not the same as being allowed
 * to instruct the model, so they read as hints about the sections and never
 * as system text (CLAUDE.md trust boundary). The cost is that a template's
 * notes steer the fill less firmly than they would as instructions; that is
 * the deliberate trade.
 */
export function templateClause(template: TemplateClauseInput): string {
  const notes = [
    `Template: ${template.name} (${template.ref}, version ${template.version})`,
    template.description?.trim() ? `Description: ${template.description.trim()}` : '',
    template.aiInstructions?.trim() ? `Notes for whoever fills it in:\n${template.aiInstructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_NOTES_CHARS);

  return (
    '\n\nThis draft was started from a page template: its headings are the structure the page should keep. ' +
    'When the user asks you to fill it in or draft it, fill each section from what they describe and from ' +
    'pages you can read — one edit_draft replace per section, anchored on that section\'s placeholder text. ' +
    'Keep the headings and their order. Where the material does not say, write "TODO:" and what is missing ' +
    'rather than inventing it. Leave sections the user did not ask about alone once they hold real text.\n\n' +
    wrapUntrusted(notes, 'template', 'template')
  );
}
