/**
 * Editing a blueprint's page tree (#716), as pure functions over plain data:
 * the wizard's machine stores the tree, and every edit returns a new one.
 *
 * A node is addressed by its path, the child index at each level
 * (`[2, 0]` = the first child of the third root). Paths rather than ids,
 * because a blueprint node is a strict schema with no id field and the tree is
 * at most `BLUEPRINT_MAX_PAGES` nodes, so cloning it per edit costs nothing.
 */
import {
  blueprintText,
  nextChildTitle,
  type BlueprintNode,
  type BlueprintText,
  type Locale,
} from '@knowledge/contracts'

export type NodePath = number[]

/** Blueprints are JSON; this also unwraps the reactive proxies a Vue ref hands out, which `structuredClone` refuses. */
export const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const clone = (tree: BlueprintNode[]): BlueprintNode[] => cloneJson(tree)

/** The list a node at `path` sits in, and its index there, inside `tree` (mutable). */
function slot(tree: BlueprintNode[], path: NodePath): { list: BlueprintNode[]; index: number } {
  let list = tree
  for (const i of path.slice(0, -1)) list = (list[i]!.children ??= [])
  return { list, index: path[path.length - 1]! }
}

export function nodeAt(tree: BlueprintNode[], path: NodePath): BlueprintNode | undefined {
  let list: BlueprintNode[] | undefined = tree
  let node: BlueprintNode | undefined
  for (const i of path) {
    node = list?.[i]
    list = node?.children
  }
  return node
}

export function updateNode(tree: BlueprintNode[], path: NodePath, patch: (node: BlueprintNode) => void): BlueprintNode[] {
  const next = clone(tree)
  const node = nodeAt(next, path)
  if (node) patch(node)
  return next
}

/** Insert under `parent` (null = the roots) at `index` (default: last). Returns the tree and the new node's path. */
export function insertNode(
  tree: BlueprintNode[],
  parent: NodePath | null,
  node: BlueprintNode,
  index?: number,
): { tree: BlueprintNode[]; path: NodePath } {
  const next = clone(tree)
  const list = parent ? (nodeAt(next, parent)!.children ??= []) : next
  const at = index ?? list.length
  list.splice(at, 0, node)
  return { tree: next, path: [...(parent ?? []), at] }
}

export function removeNode(tree: BlueprintNode[], path: NodePath): BlueprintNode[] {
  const next = clone(tree)
  const { list, index } = slot(next, path)
  list.splice(index, 1)
  return next
}

const startsWith = (path: NodePath, prefix: NodePath) => prefix.length <= path.length && prefix.every((v, i) => path[i] === v)

/**
 * Move the node at `from` to `index` among `parent`'s children, both read as
 * in the tree *before* the move. Refuses (returns null) a move into its own
 * subtree. Returns the tree and the node's new path.
 */
export function moveNode(
  tree: BlueprintNode[],
  from: NodePath,
  parent: NodePath | null,
  index: number,
): { tree: BlueprintNode[]; path: NodePath } | null {
  const target = [...(parent ?? [])]
  if (startsWith(target, from)) return null
  const node = nodeAt(tree, from)
  if (!node) return null
  // Taking the node out shifts every later sibling, and anything addressed
  // through one of them, up by one.
  const depth = from.length - 1
  const sameLine = startsWith(target, from.slice(0, -1))
  let at = index
  if (sameLine && target.length === depth && from[depth]! < index) at -= 1
  else if (sameLine && target.length > depth && from[depth]! < target[depth]!) target[depth]! -= 1
  return insertNode(removeNode(tree, from), target.length ? target : null, node, at)
}

/** Keyboard moves, in the outline's terms. Null when the move is not possible. */
export function shiftNode(tree: BlueprintNode[], path: NodePath, dir: 'up' | 'down' | 'in' | 'out') {
  const parent = path.slice(0, -1)
  const i = path[path.length - 1]!
  const siblings = parent.length ? (nodeAt(tree, parent)?.children ?? []) : tree
  const p = parent.length ? parent : null
  if (dir === 'up') return i > 0 ? moveNode(tree, path, p, i - 1) : null
  if (dir === 'down') return i < siblings.length - 1 ? moveNode(tree, path, p, i + 2) : null
  // Indent: become the last child of the sibling above.
  if (dir === 'in') return i > 0 ? moveNode(tree, path, [...parent, i - 1], siblings[i - 1]!.children?.length ?? 0) : null
  // Outdent: become the parent's next sibling.
  if (!parent.length) return null
  const grand = parent.slice(0, -1)
  return moveNode(tree, path, grand.length ? grand : null, parent[parent.length - 1]! + 1)
}

export function countPages(tree: BlueprintNode[]): number {
  return tree.reduce((n, node) => n + 1 + countPages(node.children ?? []), 0)
}

export function treeDepth(tree: BlueprintNode[]): number {
  return tree.reduce((d, node) => Math.max(d, 1 + treeDepth(node.children ?? [])), 0)
}

/** True when some node has no title in any language (the schema refuses it). */
export function hasUntitled(tree: BlueprintNode[]): boolean {
  return tree.some((n) => !blueprintText(n.title, 'en').trim() || hasUntitled(n.children ?? []))
}

/**
 * Text as the person typed it. An edit replaces every language with the one it
 * was typed in: keeping a stale translation beside it would scaffold the old
 * title whenever the other language is picked at Create.
 */
export function typedText(locale: Locale, value: string): BlueprintText {
  return { [locale]: value }
}

/**
 * The titles a collection's initial items will get, as the scaffold writes
 * them (`ProjectScaffoldService.writeTree`): numbered in order by its pattern.
 */
export function itemTitles(collection: BlueprintNode, locale: Locale): string[] {
  const pattern = blueprintText(collection.collection?.childTitlePattern, locale)
  const titles: string[] = []
  for (const child of collection.children ?? []) {
    const name = blueprintText(child.title, locale).trim()
    titles.push(pattern ? nextChildTitle(pattern, titles, name) : name)
  }
  return titles
}
