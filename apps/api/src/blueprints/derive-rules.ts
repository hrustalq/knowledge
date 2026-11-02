import {
  BLUEPRINT_MAX_PAGES,
  BUILT_IN_TEMPLATE_REF_PREFIX,
  DOCUMENT_CATEGORIES,
  type BlueprintCollection,
  type BlueprintNode,
  type DocumentCategory,
  type Locale,
} from '@knowledge/contracts';

/**
 * The deterministic half of deriving a blueprint from a project (#716): pure,
 * so a spec pins it. Only titles and headings travel, never page text.
 */

/** A page of the source project as derive reads it. */
export interface SourcePage {
  title: string;
  /** Free text on `documents`; only a catalogue value carries over. */
  category: string;
  templateRef: string | null;
  /** `## Heading` lines, h2–h4, as `headingsOf` returns them. */
  headings: string[];
  children: SourcePage[];
}

const TITLE_MAX = 200;
const HEADINGS_MAX = 40;

/** A page's heading skeleton: h2–h4 lines outside code fences. The h1 is the title. */
export function headingsOf(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push(`${m[1]} ${m[2]}`);
    if (out.length === HEADINGS_MAX) break;
  }
  return out;
}

/** The language a title is written in. Two locales, so one script test decides it. */
export function titleLocale(title: string): Locale {
  return /[а-яё]/i.test(title) ? 'ru' : 'en';
}

const DATED = /^\d{4}-\d{2}-\d{2}(\s*[—–:-]?\s*)(?=\S)/;
const NUMBERED = /^(\D{0,16}?)(\d{1,6})(\s*[—–:.)-]\s*|\s+)(?=\S)/;

/**
 * A title's numbering, as a `nextChildTitle` pattern minus the width: `ADR 0007: Queue`
 * → `{ key: 'ADR \u0000: ', width: 4 }`. A digit run with a leading zero is padded to
 * its length; one without is not (`10 — …` sits beside `01 — …`).
 */
function numberingOf(title: string): { key: string; width: number } | null {
  const dated = DATED.exec(title);
  if (dated) return { key: `{{date}}${dated[1] || ' '}`, width: 0 };
  const m = NUMBERED.exec(title);
  if (!m) return null;
  return { key: `${m[1]}\u0000${m[3]}`, width: m[2]!.length > 1 && m[2]!.startsWith('0') ? m[2]!.length : 1 };
}

/** The largest group of `items` by `keyOf`, when it holds at least `min` of them and at least half. */
function majority<T>(items: T[], keyOf: (item: T) => string | null, min: number): { key: string; members: T[] } | null {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return best && best[1].length >= min && best[1].length * 2 >= items.length ? { key: best[0], members: best[1] } : null;
}

const builtInRef = (ref: string | null) => (ref?.startsWith(BUILT_IN_TEMPLATE_REF_PREFIX) ? ref : null);

/**
 * Which leaf children fold into a collection, and its rule. Numbered leaves
 * (two or more, at least half) first; else three or more sharing one heading
 * skeleton. A shared built-in template becomes the child template.
 */
function collectionOf(children: SourcePage[]): { rule: BlueprintCollection; folded: Set<SourcePage> } | null {
  const leaves = children.filter((c) => c.children.length === 0);
  const numbered = majority(leaves, (c) => numberingOf(c.title)?.key ?? null, 2);
  const shaped = numbered ? null : majority(leaves, (c) => (c.headings.length ? c.headings.join('\n') : null), 3);
  const group = numbered ?? shaped;
  if (!group) return null;
  const refs = new Set(group.members.map((c) => builtInRef(c.templateRef)));
  const childTemplateRef = refs.size === 1 ? [...refs][0] : null;
  const rule: BlueprintCollection = childTemplateRef ? { childTemplateRef } : {};
  if (numbered) {
    const width = Math.max(...group.members.map((c) => numberingOf(c.title)!.width));
    const pattern = width ? group.key.replace('\u0000', `{{n:${width}}}`) : group.key;
    rule.childTitlePattern = { [titleLocale(group.members[0]!.title)]: pattern };
  }
  // ponytail: a folded skeleton without a built-in template is dropped, carry it as a project template when asked.
  return { rule, folded: new Set(group.members) };
}

/**
 * The blueprint tree of `pages`: titles (in the language they are written in),
 * categories, a built-in template or the heading skeleton as the body, and
 * leaves folded into collections, never copied. Stops at BLUEPRINT_MAX_PAGES.
 */
export function deriveTree(pages: SourcePage[]): BlueprintNode[] {
  let budget = BLUEPRINT_MAX_PAGES;
  const walk = (level: SourcePage[]): BlueprintNode[] => {
    const nodes: BlueprintNode[] = [];
    for (const page of level) {
      if (budget-- <= 0) break;
      const lang = titleLocale(page.title);
      const templateRef = builtInRef(page.templateRef);
      const folding = collectionOf(page.children);
      const kept = page.children.filter((c) => !folding?.folded.has(c));
      const children = walk(kept);
      nodes.push({
        title: { [lang]: page.title.slice(0, TITLE_MAX) },
        ...(page.category !== 'other' && (DOCUMENT_CATEGORIES as readonly string[]).includes(page.category)
          ? { category: page.category as DocumentCategory }
          : {}),
        ...(templateRef ? { templateRef } : page.headings.length ? { body: { [lang]: page.headings.join('\n\n') } } : {}),
        ...(folding ? { collection: folding.rule } : {}),
        ...(children.length ? { children } : {}),
      });
    }
    return nodes;
  };
  return walk(pages);
}
