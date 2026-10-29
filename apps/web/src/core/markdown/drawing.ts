/**
 * Whiteboard scene model and its SVG renderer.
 *
 * One renderer, two consumers: the interactive canvas in the editor and the
 * static read view both build geometry from the helpers here, so a shape can
 * never draw one way while you are editing and another way once published.
 *
 * Colors are stored as *palette keys*, never as hex. The renderer emits
 * `var(--kn-draw-blue)` and the theme supplies the value, so a diagram drawn in
 * light mode stays legible in dark mode instead of turning into black ink on a
 * black page — the failure mode of every raster-and-hex whiteboard.
 */

export const DRAW_COLORS = ['ink', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];

export const DRAW_FILLS = ['none', ...DRAW_COLORS] as const;
export type DrawFill = (typeof DRAW_FILLS)[number];

export type DrawTool = 'select' | 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'draw' | 'text';
export type ShapeKind = Exclude<DrawTool, 'select'>;

export interface DrawStyle {
  /** Palette key resolved to a CSS variable at render time. */
  stroke: DrawColor;
  fill: DrawFill;
  /** Stroke width in scene units. */
  sw: number;
  /** 0 solid · 1 dashed · 2 dotted */
  dash: 0 | 1 | 2;
  /** Font size for text-bearing elements. */
  fs?: number;
}

export interface DrawElement {
  id: string;
  t: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Polyline/freedraw points, relative to (x, y). */
  pts?: [number, number][];
  text?: string;
  s: DrawStyle;
}

export interface DrawScene {
  v: 1;
  w: number;
  h: number;
  els: DrawElement[];
}

export const DEFAULT_STYLE: DrawStyle = { stroke: 'ink', fill: 'none', sw: 2, dash: 0, fs: 16 };

export function emptyScene(): DrawScene {
  return { v: 1, w: 720, h: 420, els: [] };
}

export function colorVar(key: DrawColor): string {
  return `var(--kn-draw-${key})`;
}

export function fillValue(key: DrawFill): string {
  if (key === 'none') return 'none';
  // Translucent so overlapping shapes and the text under them stay readable.
  return `color-mix(in oklch, var(--kn-draw-${key}) 16%, transparent)`;
}

export function dashArray(dash: 0 | 1 | 2, sw: number): string | undefined {
  if (dash === 1) return `${sw * 4} ${sw * 3}`;
  if (dash === 2) return `${sw * 0.5} ${sw * 3}`;
  return undefined;
}

/** Normalized bounds — shapes may be drawn right-to-left or bottom-to-top. */
export function bounds(el: DrawElement): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(el.x, el.x + el.w),
    y: Math.min(el.y, el.y + el.h),
    w: Math.abs(el.w),
    h: Math.abs(el.h),
  };
}

/**
 * Freedraw path: a quadratic curve through the midpoints of consecutive
 * samples. Sampling gives you a polyline with visible corners at pointer speed;
 * midpoint-quadratic is the cheapest smoothing that reads as a drawn line.
 */
export function freehandPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length < 3) {
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p[0])} ${round(p[1])}`).join(' ');
  }
  let d = `M${round(pts[0][0])} ${round(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [cx, cy] = pts[i];
    const mx = (cx + pts[i + 1][0]) / 2;
    const my = (cy + pts[i + 1][1]) / 2;
    d += ` Q${round(cx)} ${round(cy)} ${round(mx)} ${round(my)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${round(last[0])} ${round(last[1])}`;
}

export function diamondPath(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `M${round(cx)} ${round(y)} L${round(x + w)} ${round(cy)} L${round(cx)} ${round(y + h)} L${round(x)} ${round(cy)} Z`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Wrap element text to the shape width so labels do not overflow their box. */
export function wrapText(text: string, width: number, fontSize: number): string[] {
  const max = Math.max(1, Math.floor(width / (fontSize * 0.55)));
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= max) {
      out.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= max) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function parseScene(raw: string): DrawScene {
  try {
    const parsed = JSON.parse(raw) as Partial<DrawScene>;
    if (!parsed || !Array.isArray(parsed.els)) return emptyScene();
    return {
      v: 1,
      w: Number(parsed.w) || 720,
      h: Number(parsed.h) || 420,
      els: parsed.els.filter((e): e is DrawElement => !!e && typeof e.id === 'string'),
    };
  } catch {
    return emptyScene();
  }
}

export function serializeScene(scene: DrawScene): string {
  return JSON.stringify(scene);
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function styleAttrs(s: DrawStyle, filled: boolean): string {
  const dash = dashArray(s.dash, s.sw);
  return [
    `stroke="${colorVar(s.stroke)}"`,
    `stroke-width="${s.sw}"`,
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
    `fill="${filled ? fillValue(s.fill) : 'none'}"`,
    dash ? `stroke-dasharray="${dash}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Text centered inside a shape (or left-aligned for a bare text element). */
function textMarkup(el: DrawElement, anchor: 'middle' | 'start'): string {
  if (!el.text) return '';
  const b = bounds(el);
  const fs = el.s.fs ?? 16;
  const lines = wrapText(el.text, Math.max(b.w - 12, 24), fs);
  const totalH = lines.length * fs * 1.3;
  const startY =
    anchor === 'middle' ? b.y + b.h / 2 - totalH / 2 + fs : b.y + fs;
  const x = anchor === 'middle' ? b.x + b.w / 2 : b.x;
  return lines
    .map(
      (line, i) =>
        `<text x="${round(x)}" y="${round(startY + i * fs * 1.3)}" fill="${colorVar(el.s.stroke)}" font-size="${fs}" text-anchor="${anchor}" font-family="var(--kn-draw-font)">${esc(line)}</text>`,
    )
    .join('');
}

/** Markup for one element; used by both the static renderer and the live canvas. */
export function elementMarkup(el: DrawElement): string {
  const b = bounds(el);
  const s = el.s;
  switch (el.t) {
    case 'rect':
      return `<rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="6" ${styleAttrs(s, true)} />${textMarkup(el, 'middle')}`;
    case 'ellipse':
      return `<ellipse cx="${round(b.x + b.w / 2)}" cy="${round(b.y + b.h / 2)}" rx="${round(b.w / 2)}" ry="${round(b.h / 2)}" ${styleAttrs(s, true)} />${textMarkup(el, 'middle')}`;
    case 'diamond':
      return `<path d="${diamondPath(b.x, b.y, b.w, b.h)}" ${styleAttrs(s, true)} />${textMarkup(el, 'middle')}`;
    case 'line':
    case 'arrow': {
      const pts = (el.pts ?? []).map(([px, py]) => `${round(el.x + px)},${round(el.y + py)}`).join(' ');
      const marker = el.t === 'arrow' ? ` marker-end="url(#kn-arrow-${el.s.stroke})"` : '';
      return `<polyline points="${pts}" ${styleAttrs(s, false)}${marker} />`;
    }
    case 'draw': {
      const pts = (el.pts ?? []).map(([px, py]) => [el.x + px, el.y + py] as [number, number]);
      return `<path d="${freehandPath(pts)}" ${styleAttrs(s, false)} />`;
    }
    case 'text':
      return textMarkup(el, 'start');
    default:
      return '';
  }
}

/** Arrowhead markers, one per palette color (markers cannot inherit stroke). */
export function arrowDefs(): string {
  return `<defs>${DRAW_COLORS.map(
    (c) =>
      `<marker id="kn-arrow-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${colorVar(c)}" /></marker>`,
  ).join('')}</defs>`;
}

/**
 * Static SVG for a scene. Returned as a string so the read view can drop it
 * straight into the DOM without mounting a component — inline SVG inherits the
 * page's CSS variables, which is exactly how the palette re-themes itself.
 */
export function renderSceneToSvg(scene: DrawScene): string {
  const body = scene.els.map((el) => elementMarkup(el)).join('');
  return `<svg class="kn-drawing-svg" viewBox="0 0 ${scene.w} ${scene.h}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Diagram">${arrowDefs()}${body}</svg>`;
}
