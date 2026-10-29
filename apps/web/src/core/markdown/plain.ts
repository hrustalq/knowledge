/**
 * Markdown → plain text, for the places that can only show plain text: a
 * `title` attribute, a one-line preview of a collapsed thread, the excerpt of
 * the comment a reply answers.
 *
 * This is deliberately a stripper, not a parser. Rendering the markdown and
 * reading `textContent` would be more correct and needs a DOM, which two of
 * the three callers do not have (SSR, and a `title=` built before mount) — and
 * for a single line of preview text, dropping the markers is indistinguishable
 * from the real thing.
 */
export function plainText(markdown: string): string {
  return (markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One line of it, cut at a word boundary. An excerpt that stops mid-word reads
 * as a rendering bug rather than as a deliberate truncation.
 */
export function excerpt(markdown: string, max = 120): string {
  const text = plainText(markdown);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
