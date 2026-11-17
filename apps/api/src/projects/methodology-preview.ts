import { blueprintText, type BlueprintCollection, type BlueprintNode, type Locale, type MethodologyPreviewSection } from '@knowledge/contracts';

/** A page the project already has, at the top level or one down. */
export interface ExistingPage {
  id: string;
  title: string;
  parentId: string | null;
}

export interface MissingSection extends MethodologyPreviewSection {
  node: BlueprintNode;
  /** The existing page it goes under; null = top level. */
  parentId: string | null;
  /** The collection rule of the methodology node it sits in, for its title. */
  rule?: BlueprintCollection;
}

const fold = (title: string) => title.trim().toLowerCase();
const count = (node: BlueprintNode): number => 1 + (node.children ?? []).reduce((n, c) => n + count(c), 0);

/**
 * The sections of a methodology's tree a project lacks (#1125), matched by
 * title in `locale`: a top-level node no root page is titled like, with its
 * whole subtree; under a root that is there, a child node none of its children
 * is titled like. Never deeper, and never a collection's initial items — those
 * are titled by the collection's rule, not by their own name.
 */
export function missingSections(pages: readonly ExistingPage[], tree: readonly BlueprintNode[], locale: Locale): MissingSection[] {
  const roots = new Map(pages.filter((p) => !p.parentId).map((p) => [fold(p.title), p]));
  const out: MissingSection[] = [];
  tree.forEach((node, i) => {
    const title = blueprintText(node.title, locale).trim();
    const root = roots.get(fold(title));
    if (!root) {
      out.push({ id: String(i), title, parentTitle: null, pages: count(node), node, parentId: null });
      return;
    }
    if (node.collection) return;
    const children = new Set(pages.filter((p) => p.parentId === root.id).map((p) => fold(p.title)));
    (node.children ?? []).forEach((child, j) => {
      const childTitle = blueprintText(child.title, locale).trim();
      if (!children.has(fold(childTitle))) {
        out.push({ id: `${i}.${j}`, title: childTitle, parentTitle: root.title, pages: count(child), node: child, parentId: root.id });
      }
    });
  });
  return out;
}
