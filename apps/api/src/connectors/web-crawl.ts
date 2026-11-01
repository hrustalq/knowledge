import { JSDOM } from 'jsdom';
import { isHtmlBody } from './source-recipe.js';
import type { SourceBody } from './source-recipe.js';

/**
 * A crawled `web` source (#674, phase 3), the pure half: which URLs belong to
 * the tree, how they fold to one page each, and where each page hangs. No
 * network — the adapter fetches, this decides.
 *
 * - **Scope** is the root's origin plus its path, segment-bounded: `/docs`
 *   holds `/docs` and `/docs/x`, never `/docs-old`.
 * - **Folding**: `?query` and `#fragment` are dropped, and `/x`, `/x/` and
 *   `/x/index.html` are one page.
 * - **Nesting** is by URL path: a page hangs under its nearest ancestor path
 *   the crawl found, else under the root.
 */

/** Path suffixes a page can have. Anything else (an image, a PDF, a stylesheet) is not followed. */
const PAGE_EXTENSION = /\.(html?|md|markdown|mdx|txt)$/i;
const ANY_EXTENSION = /\.[a-z0-9]{1,8}$/i;

export interface CrawlScope {
  origin: string;
  /** The root's folded path without its trailing slash; empty for the whole origin. */
  prefix: string;
}

/**
 * `href` resolved against `base` and folded, or null when it is not an http(s)
 * page. The one spelling every crawled URL is compared and stored in.
 */
export function foldUrl(href: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  let path = url.pathname.replace(/\/index\.html?$/i, '/').replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function crawlScope(root: string): CrawlScope {
  const folded = foldUrl(root);
  if (!folded) throw new Error(`not an http(s) URL: ${root}`);
  const url = new URL(folded);
  return { origin: url.origin, prefix: url.pathname === '/' ? '' : url.pathname };
}

/** In the tree, and plausibly a page rather than an asset. `url` must already be folded. */
export function inScope(url: string, scope: CrawlScope): boolean {
  const parsed = new URL(url);
  if (parsed.origin !== scope.origin) return false;
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  if (path !== scope.prefix && !path.startsWith(`${scope.prefix}/`)) return false;
  return !ANY_EXTENSION.test(path) || PAGE_EXTENSION.test(path);
}

/** Every link a page names, resolved and folded: `<a href>` anywhere in HTML (nav included), markdown links otherwise. */
export function pageLinks(source: SourceBody): string[] {
  const hrefs: string[] = [];
  if (isHtmlBody(source.contentType)) {
    // The URL option makes `<base href>` and relative links resolve the way a browser would.
    const { document } = new JSDOM(source.body, { url: source.url }).window;
    for (const a of document.querySelectorAll('a[href]')) hrefs.push((a as HTMLAnchorElement).href);
  } else {
    for (const m of source.body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) hrefs.push(m[1]!);
    for (const m of source.body.matchAll(/href="([^"]+)"/g)) hrefs.push(m[1]!);
  }
  return unique(hrefs.map((h) => foldUrl(h, source.url)));
}

/** The `<loc>` entries of a sitemap or sitemap index, entities decoded. */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
}

/**
 * Where each crawled page hangs: its nearest ancestor path among `urls`, else
 * the root; the root itself is a top (null). `root` is the connector's URL as
 * typed — the root page's link id — and `urls` are folded.
 */
export function pathParents(root: string, urls: string[]): Map<string, string | null> {
  const scope = crawlScope(root);
  const found = new Set(urls);
  const foldedRoot = foldUrl(root)!;
  const parents = new Map<string, string | null>();
  for (const url of urls) {
    if (url === root || url === foldedRoot) {
      parents.set(url, null);
      continue;
    }
    let parent: string = root;
    if (url.startsWith(scope.origin)) {
      let path = new URL(url).pathname;
      while (path.length > scope.prefix.length) {
        path = path.slice(0, path.lastIndexOf('/'));
        const candidate = `${scope.origin}${path}`;
        if (path.length > scope.prefix.length && found.has(candidate)) {
          parent = candidate;
          break;
        }
      }
    }
    parents.set(url, parent);
  }
  return parents;
}

function unique(urls: Array<string | null>): string[] {
  return [...new Set(urls.filter((u): u is string => u !== null))];
}
