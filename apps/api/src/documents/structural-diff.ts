import matter from 'gray-matter';
import { load as parseYaml } from 'js-yaml';
import type { StructuralChange, StructuralDiff } from '@knowledge/contracts';

/**
 * Path-level structural diffing (plan.md §8): JSON/YAML bodies are diffed as
 * parsed values, markdown is diffed on its frontmatter metadata — never as raw
 * lines (that's the text diff's job).
 */

export function parseStructured(
  contentType: string,
  text: string,
): { source: 'content' | 'frontmatter'; data: unknown } | null {
  const t = contentType.toLowerCase();
  try {
    if (t.includes('json')) return { source: 'content', data: JSON.parse(text) };
    if (t.includes('yaml') || t.includes('yml')) return { source: 'content', data: parseYaml(text) };
    if (t.includes('markdown') || t.includes('md')) return { source: 'frontmatter', data: matter(text).data };
  } catch {
    // Unparseable content → no structural view; the text diff still applies.
    return null;
  }
  return null;
}

export function structuralDiff(
  source: 'content' | 'frontmatter',
  before: unknown,
  after: unknown,
): StructuralDiff {
  const changes: StructuralChange[] = [];
  walk('', before, after, changes);
  const summary = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) summary[c.kind] += 1;
  return { source, changes, summary };
}

function walk(path: string, before: unknown, after: unknown, out: StructuralChange[]): void {
  if (deepEqual(before, after)) return;

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in before)) out.push({ path: childPath, kind: 'added', after: after[key] });
      else if (!(key in after)) out.push({ path: childPath, kind: 'removed', before: before[key] });
      else walk(childPath, before[key], after[key], out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= before.length) out.push({ path: childPath, kind: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: childPath, kind: 'removed', before: before[i] });
      else walk(childPath, before[i], after[i], out);
    }
    return;
  }

  out.push({ path, kind: 'changed', before, after });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}
