/**
 * The template gallery's pure half (issue #69): which templates a project is
 * offered, how they group and filter, and what a filled-in skeleton looks like
 * before anything is sent.
 *
 * The preview renders with the contracts functions the API renders with, so
 * what the gallery shows and the page the editor opens on cannot disagree —
 * the server render is still what the editor starts from, because only the
 * server can resolve a user or page id into a label inside the workspace.
 */
import {
  missingRequiredPlaceholders,
  renderTemplate,
  renderTemplateTitle,
  type TemplateDetail,
  type TemplateRenderContext,
  type TemplateScope,
  type TemplateSourceFields,
  type TemplateSummary,
  type TemplateValues,
  type WorkspaceRole,
} from '@knowledge/contracts'

/** Narrowest first: the gallery lists what is most specific to where you are writing at the top. */
export const TEMPLATE_GROUP_ORDER: readonly TemplateScope[] = ['project', 'workspace', 'built-in']

export interface TemplateGroup {
  scope: TemplateScope
  templates: TemplateSummary[]
}

/**
 * What the gallery can offer. An archived template still resolves for the
 * pages pinned to it, and a hidden built-in still exists, but neither is
 * something to start a new page from.
 */
export function offeredTemplates(templates: readonly TemplateSummary[]): TemplateSummary[] {
  return templates.filter((t) => t.enabled && !t.archivedAt)
}

/** Typed text against name, description, category and the built-in key (`adr` finds ADR in any language). */
export function matchesTemplate(template: TemplateSummary, query: string, categoryLabel?: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  const haystack = [template.name, template.description ?? '', template.category, categoryLabel ?? '', template.builtInKey ?? '']
    .join(' ')
    .toLocaleLowerCase()
  return needle.split(/\s+/).every((word) => haystack.includes(word))
}

/** The gallery's sections, in `TEMPLATE_GROUP_ORDER`, empty ones left out. */
export function groupTemplates(templates: readonly TemplateSummary[]): TemplateGroup[] {
  return TEMPLATE_GROUP_ORDER.map((scope) => ({
    scope,
    templates: templates.filter((t) => t.scope === scope),
  })).filter((g) => g.templates.length > 0)
}

export interface TemplatePreview {
  title: string
  body: string
  /** Required placeholders still blank, in declaration order. */
  missing: string[]
}

/**
 * The skeleton as it would open in the editor, rendered in the browser. Labels
 * for `user`/`page` values are what the pickers show; the server resolves its
 * own when the page is actually created.
 */
export function previewTemplate(
  detail: Pick<TemplateDetail, 'body' | 'meta'>,
  values: TemplateValues,
  ctx: TemplateRenderContext,
): TemplatePreview {
  return {
    title: renderTemplateTitle(detail.meta, values, ctx),
    body: renderTemplate(detail.body, detail.meta, values, ctx),
    missing: missingRequiredPlaceholders(detail.meta, values),
  }
}

/**
 * Whether a role may change a template of this scope — the API's rule, so a
 * control is hidden where the request would 403. A project template is an
 * editor's; a workspace-wide one or a built-in changes what every project is
 * offered, which is an admin's, as with a workflow definition.
 */
export function canWriteTemplate(scope: TemplateScope, role: WorkspaceRole | null | undefined): boolean {
  if (role === 'admin') return true
  return scope === 'project' && role === 'editor'
}

/**
 * Undo the rich editor's markdown escaping inside `{{…}}`.
 *
 * Turndown escapes `_` to `\_` in text, which is right for prose and wrong
 * here: `{{due\_date}}` is no longer a placeholder the renderer can match, so
 * a template body written in the rich editor would silently stop filling in.
 * An escaped placeholder (`\{{x}}`, written to keep one literal) comes back
 * from turndown as `\\{{x}}`, which renders to the same `{{x}}` — left alone.
 */
export function unescapePlaceholders(markdown: string): string {
  return markdown.replace(/\{\{\s*[A-Za-z][A-Za-z0-9_\\-]*\s*\}\}/g, (match) => match.replace(/\\_/g, '_'))
}

/** A template detail as the fields an editor holds — the inverse of `composeTemplateSource`. */
export function templateSourceFields(detail: Pick<TemplateDetail, 'meta' | 'tags' | 'relations' | 'frontmatter' | 'body'>): TemplateSourceFields {
  return {
    meta: { ...detail.meta, placeholders: detail.meta.placeholders.map((p) => ({ ...p })) },
    tags: [...detail.tags],
    relations: detail.relations.map((r) => ({ ...r })),
    other: { ...(detail.frontmatter ?? {}) },
    body: detail.body,
  }
}

