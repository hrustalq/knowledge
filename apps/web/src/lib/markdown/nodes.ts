/**
 * The rich-block vocabulary, shared by the editor, the serializer and the read
 * view so all three agree on one encoding.
 *
 * Design rule: **markdown stays canonical and text stays visible.** Every block
 * below round-trips to markdown that still exposes its prose as prose, because
 * the ingestion worker chunks and embeds the markdown — anything hidden inside
 * an opaque fence would silently drop out of search and out of the graph. That
 * is why panels are GitHub alert blockquotes rather than a ```panel fence, and
 * why expands are real <details> rather than a custom macro.
 *
 * Only genuinely non-textual payloads (a mermaid source, a whiteboard scene)
 * live in fences, and only because there is no prose in them to lose.
 */

/** data-* attribute names. One place, so a rename cannot desync the two directions. */
export const KN = {
  mermaid: 'data-kn-mermaid',
  drawing: 'data-kn-drawing',
  panel: 'data-kn-panel',
  layout: 'data-kn-layout',
  column: 'data-kn-col',
  file: 'data-kn-file',
  status: 'data-kn-status',
  toc: 'data-kn-toc',
  mention: 'data-kn-mention',
  user: 'data-kn-user',
} as const;

/**
 * Panel kinds are GitHub's five alert keywords, not invented ones: the stored
 * markdown then renders as a real callout on GitHub, GitLab and Obsidian too,
 * instead of degrading to an anonymous blockquote.
 */
export const PANEL_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

/** `label` is an i18n message key — resolve it with `t()` at the render site. */
export const PANEL_META: Record<PanelType, { label: string; icon: string; hue: string }> = {
  note: { label: 'panel.note', icon: 'info', hue: 'var(--kn-panel-note)' },
  tip: { label: 'panel.tip', icon: 'check', hue: 'var(--kn-panel-tip)' },
  important: { label: 'panel.important', icon: 'bookmark', hue: 'var(--kn-panel-important)' },
  warning: { label: 'panel.warning', icon: 'alert', hue: 'var(--kn-panel-warning)' },
  caution: { label: 'panel.caution', icon: 'x', hue: 'var(--kn-panel-caution)' },
};

export function isPanelType(value: string): value is PanelType {
  return (PANEL_TYPES as readonly string[]).includes(value);
}

/** Inline status lozenge colors (Confluence's inline status macro). */
export const STATUS_COLORS = ['neutral', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];

export function isStatusColor(value: string): value is StatusColor {
  return (STATUS_COLORS as readonly string[]).includes(value);
}

/** Column counts a layout section supports. */
export const LAYOUT_COLUMNS = [2, 3] as const;
export type LayoutColumns = (typeof LAYOUT_COLUMNS)[number];

/** Attachment kinds the read view renders differently. */
export function attachmentKind(mime: string): 'image' | 'pdf' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Escape for interpolation into an HTML attribute or text node. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
