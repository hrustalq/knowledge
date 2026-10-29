/**
 * The embeddable Ask widget of a published site (docs/features/44, issue #77
 * phase 3): `<script src="https://<site>/widget.js" async></script>` on any
 * page draws a button that opens the site's Ask in a frame.
 *
 * The script is the same bytes for every site. It finds its frame from its
 * own `src` — `widget.js` beside it becomes `_widget` — so it needs no site
 * id and nothing here asks the API. The frame (src/entry-public.ts) is a page
 * of the site itself, same-origin with the site's API, so no CORS is needed;
 * its `frame-ancestors` decides who may show it, which is the whole of the
 * embed check. Until the frame says `ready` — Ask is on and the frame was
 * allowed to load — the button stays hidden, so a page embedding a site
 * without Ask, or from an origin the site never listed, shows nothing.
 *
 * Served on a site's own host at `/widget.js`, and under `/pub/<slug>/` in
 * path mode, before the reader claims either path as a page.
 */

/** Kept in step with MESSAGE_SOURCE in src/modules/reader/pages/SiteWidget.vue. */
export const WIDGET_MESSAGE_SOURCE = 'kn-site-ask'

const PATH_MODE = /^\/pub\/[a-z0-9-]+\/widget\.js$/

/**
 * Plain ES2017 for any embedding page, inside a closed shadow root so neither
 * side's CSS reaches the other. It reads only `currentScript` and posts only
 * to the frame's own origin; it accepts messages from that frame alone.
 */
export const WIDGET_SCRIPT = `(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.src || window.__knSiteAsk) return;
  window.__knSiteAsk = true;
  var SOURCE = ${JSON.stringify(WIDGET_MESSAGE_SOURCE)};
  var src = new URL(script.src, location.href);
  var frameUrl = new URL(src.pathname.replace(/widget\\.js$/, '_widget'), src.origin);
  var left = script.getAttribute('data-position') === 'left';

  var host = document.createElement('div');
  host.setAttribute('data-kn-site-ask', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
  var side = left ? 'left' : 'right';
  var style = document.createElement('style');
  style.textContent =
    ':host{all:initial}' +
    '.b{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483646;display:inline-flex;align-items:center;gap:8px;' +
    'padding:10px 16px;border:0;border-radius:999px;background:#18181b;color:#fff;font:600 14px/1.2 system-ui,-apple-system,sans-serif;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer}' +
    '.b:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
    '.b[hidden],.p[hidden]{display:none}' +
    '.p{position:fixed;bottom:76px;' + side + ':20px;z-index:2147483647;width:min(400px,calc(100vw - 40px));' +
    'height:min(600px,calc(100vh - 100px));border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
    '.p iframe{width:100%;height:100%;border:0;display:block}' +
    '@media (max-width:480px){.p{inset:0;width:100%;height:100%;border-radius:0}}';
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'b';
  button.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  button.textContent = '?';
  var panel = document.createElement('div');
  panel.className = 'p';
  panel.hidden = true;
  var frame = document.createElement('iframe');
  frame.src = frameUrl.href;
  frame.title = 'Ask';
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  panel.appendChild(frame);
  root.appendChild(style);
  root.appendChild(panel);
  root.appendChild(button);

  function toggle(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && frame.contentWindow) frame.contentWindow.postMessage({ source: SOURCE, type: 'focus' }, frameUrl.origin);
    if (!open) button.focus();
  }
  button.addEventListener('click', function () { toggle(panel.hidden); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) toggle(false); });
  window.addEventListener('message', function (e) {
    if (e.origin !== frameUrl.origin || e.source !== frame.contentWindow) return;
    var data = e.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'ready') {
      if (typeof data.label === 'string') button.textContent = data.label.slice(0, 40);
      if (typeof data.title === 'string') frame.title = data.title.slice(0, 120);
      if (typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)) button.style.background = data.color;
      button.hidden = false;
    } else if (data.type === 'close') {
      toggle(false);
    }
  });

  function mount() { document.body.appendChild(host); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
`

/** Is this request the widget script? On a site's host at `/widget.js`, or under `/pub/<slug>/`. */
export function isWidgetScript(req, siteHost) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  return siteHost ? req.path === '/widget.js' : PATH_MODE.test(req.path)
}

/**
 * The script route. Cached for an hour by anyone: it carries nothing of any
 * site, and an embedding page loads it on every view. Cross-origin by design.
 */
export function siteWidgetRoute() {
  return (req, res, next) => {
    if (!isWidgetScript(req, res.locals.siteHost)) return next()
    res
      .status(200)
      .set({
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      .send(req.method === 'HEAD' ? '' : WIDGET_SCRIPT)
  }
}
