import { CITE_MARKER_RE } from '../../assistant/citations.js';
import type { ChatAnswerView, ChatOutMessage } from './chat-adapter.types.js';

/*
 * What the chat adapters share (#825): answer markdown, citation numbering,
 * link resolution, plain-word commands, payload parsing. An adapter imports
 * from here, never from another adapter.
 */

/** Commands as a whole message: a Mattermost client takes a leading `/` as its own slash command. */
const COMMAND_RE = /^\/?(start|help|new|unlink|bind|unbind|capture|remember|запомни)$/i;
/** Asking the bot to remember a thread is `capture` (#82), in either language. */
const CAPTURE_WORDS = new Set(['capture', 'remember', 'запомни']);

/** `[text](url)`, the URL allowed one level of parentheses (Wikipedia's are common). */
export const MD_LINK_RE = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

/** `S3` → `3`: the reader sees a footnote number, not the model's label. */
export const citeNumber = (label: string): string => label.replace(/^S/i, '');

/**
 * Where a link in an answer may point. Page links arrive relative
 * (`/documents/:id`, the PAGE_LINK_RULE shape), which mean nothing in a chat
 * client; anything that is not http(s) after resolving is dropped to its text.
 */
export function resolveUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base.endsWith('/') ? base : `${base}/`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * `@name` → `@​name`. Answers quote pages and titles are typed by people,
 * and on Mattermost `@channel`, `@all` or a colleague's handle in either would ping
 * them. A zero-width space after the `@` keeps the text and drops the mention.
 * An `@` inside a URL (after `/`, `:` or a word character) is left alone.
 */
export function defuseMentions(text: string): string {
  return text.replace(/(^|[^\w/:.@])@(?=[\w])/g, '$1@​');
}

/**
 * A command said as a whole message in plain words (`help`, `capture`…): a
 * Mattermost client, like Slack's, takes every leading `/` for its own slash
 * commands and never posts it. `remember` and `запомни` are `capture`.
 */
export function plainCommand(text: string): { name: string; args: string } | null {
  const match = COMMAND_RE.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: CAPTURE_WORDS.has(name) ? 'capture' : name, args: '' };
}

export function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * Cut an answer to `budget` characters at the last paragraph or sentence that
 * fits. Markdown is never shorter than the text Telegram counts after parsing
 * (link targets and `S` prefixes vanish), so a cut that fits here fits there.
 */
export function cutAnswer(md: string, budget: number): { text: string; cut: boolean } {
  if (md.length <= budget) return { text: md, cut: false };
  const window = md.slice(0, budget);
  const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
  // An open code fence would swallow the rest of the message — close it.
  let text = (at > budget / 2 ? window.slice(0, at + 1) : window).trimEnd();
  if ((text.match(/```/g)?.length ?? 0) % 2 === 1) text += '\n```';
  return { text: `${text}\n…`, cut: true };
}

/**
 * An answer's markdown as Mattermost renders it. It speaks markdown already, so
 * this only does what a chat client cannot: resolve relative page links, turn
 * `[S#]` into numbered links to the source, drop links that are not http(s),
 * and defuse mentions. Code fences pass through untouched.
 */
export function markdownForMattermost(md: string, cite: (label: string) => string | null, base: string): string {
  const parts = md.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let s = part.replace(MD_LINK_RE, (_, text: string, href: string) => {
        const url = resolveUrl(href, base);
        return url ? `[${text}](${url})` : text;
      });
      s = s.replace(new RegExp(CITE_MARKER_RE.source, 'gi'), (_, labels: string) =>
        labels
          .split(/\s*[,;]\s*/)
          .map((label) => {
            const url = cite(label.toUpperCase());
            const n = citeNumber(label);
            // The brackets escaped, so the link reads "[2]" rather than "2".
            return url ? `[\\[${n}\\]](${url})` : `[${n}]`;
          })
          .join(''),
      );
      return defuseMentions(s);
    })
    .join('')
    .trim();
}

/** An answer's sources numbered as the reader sees them: `[S3]` is 3, an uncited source its position. */
export function numberedSources(view: ChatAnswerView): Array<ChatAnswerView['sources'][number] & { n: string }> {
  return view.sources.map((s, i) => ({ ...s, n: s.cite ? citeNumber(s.cite) : String(i + 1) }));
}

/** The URL an `[S#]` label points at, or null for a label the answer was not handed. */
export function citeUrls(view: ChatAnswerView): (label: string) => string | null {
  const urls = new Map(view.sources.filter((s) => s.cite).map((s) => [s.cite!.toUpperCase(), s.url]));
  return (label) => urls.get(label) ?? null;
}

/** "Full answer" when the body was cut, then the answer's own actions. */
export function answerButtons(view: ChatAnswerView, cut: boolean): ChatOutMessage['buttons'] {
  return [...(cut && view.full ? [[view.full]] : []), ...view.actions];
}

/**
 * An answer for a platform that speaks markdown: the body cut to `budget`
 * less the sources block, rendered by `render` with its citations resolved,
 * then the sources block.
 */
export function renderMarkdownAnswer(
  view: ChatAnswerView,
  budget: number,
  sourcesBlock: (sources: ReturnType<typeof numberedSources>) => string,
  render: (md: string, cite: (label: string) => string | null, base: string) => string,
): ChatOutMessage {
  const sources = view.sources.length ? sourcesBlock(numberedSources(view)) : '';
  const { text, cut } = cutAnswer(view.answer, budget - sources.length);
  const body = render(text, citeUrls(view), view.webBaseUrl) + sources;
  return { text: body, plain: body, buttons: answerButtons(view, cut) };
}
