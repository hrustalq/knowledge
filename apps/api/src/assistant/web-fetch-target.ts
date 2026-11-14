/**
 * What `web_fetch` may request for a URL the model asked for (#1105).
 *
 * The source policy judges the host only, so in `open` mode a steered model
 * could compose `https://anywhere/?d=<what the asker can read>` and the fetch
 * itself would carry it out. A URL the person typed into this thread, or one
 * this turn's `web_search` / `web_fetch` handed back, is fetched as it is: the
 * model did not write it. Any other URL loses its query and fragment, and is
 * refused when its path alone is still long enough to carry text. Every URL
 * is held to a hard length cap.
 *
 * What is left is a short path to a host the policy allows, which narrows the
 * channel to a few hundred characters per call rather than closing it; the
 * policy (`allowlist` mode) is what closes it.
 */
export const WEB_FETCH_URL_MAX_CHARS = 2048;
export const WEB_FETCH_UNSEEN_MAX_CHARS = 300;

export type WebFetchTarget = { ok: true; url: string; trimmed: boolean } | { ok: false; error: string };

export function webFetchTarget(url: string, seen: (url: string) => boolean): WebFetchTarget {
  if (url.length > WEB_FETCH_URL_MAX_CHARS) return { ok: false, error: `URL is longer than ${WEB_FETCH_URL_MAX_CHARS} characters` };
  if (seen(url)) return { ok: true, url, trimmed: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all: the policy check refuses it with its own reason.
    return { ok: true, url, trimmed: false };
  }
  const trimmed = parsed.search !== '' || parsed.hash !== '';
  parsed.search = '';
  parsed.hash = '';
  const bare = parsed.href;
  if (bare.length > WEB_FETCH_UNSEEN_MAX_CHARS) {
    return {
      ok: false,
      error:
        `A URL nobody handed out may be at most ${WEB_FETCH_UNSEEN_MAX_CHARS} characters. ` +
        'Fetch a URL from web_search results or one the user pasted.',
    };
  }
  return { ok: true, url: bare, trimmed };
}

/** True when `url` appears verbatim in one of `texts` (the person's messages, this turn's result URLs). */
export function seenIn(texts: readonly string[]): (url: string) => boolean {
  return (url) => texts.some((text) => text.includes(url));
}
