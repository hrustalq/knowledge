import type { BuiltInTemplateKey, Locale } from '@knowledge/contracts';

/** One language of a built-in: what the gallery shows, and the source it renders. */
export interface BuiltInTemplateText {
  name: string;
  description: string;
  /** Markdown with frontmatter; the `template:` key carries TemplateMeta. */
  source: string;
}

/**
 * A template shipped in code (issue #69). TS modules rather than `.md` files so
 * nothing has to be copied into `dist`.
 *
 * `version` is bumped whenever a release changes a source. Only the current one
 * is kept: older built-in versions are not resolvable, which is fine because a
 * page records its provenance rather than depending on it.
 */
export interface BuiltInTemplate {
  key: BuiltInTemplateKey;
  version: number;
  icon: string;
  text: Record<Locale, BuiltInTemplateText>;
}
