/**
 * Template limits (issue #69). Code constants rather than env: named so they can
 * be promoted to env later without a call site changing.
 */

/** Below `MAX_INLINE_TEXT_CHARS`, so a rendered template always fits an inline create. */
export const TEMPLATE_MAX_SOURCE_CHARS = 200_000;

export const TEMPLATE_MAX_PLACEHOLDERS = 30;

/** Rows per workspace, archived included — overrides of built-ins count too. */
export const TEMPLATES_MAX_PER_WORKSPACE = 500;

/** One placeholder value. A value is a field, not a page body. */
export const TEMPLATE_MAX_VALUE_CHARS = 2_000;
