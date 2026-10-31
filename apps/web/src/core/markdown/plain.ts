import { plainText } from '@knowledge/contracts/content';

export { plainText };

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
