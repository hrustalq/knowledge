import { describe, expect, it } from 'vitest'
import type { BlueprintNode } from '@knowledge/contracts'
import { countPages, hasUntitled, insertNode, itemTitles, moveNode, removeNode, shiftNode, treeDepth } from './blueprint-tree'

const n = (en: string, children?: BlueprintNode[]): BlueprintNode => ({ title: { en }, ...(children ? { children } : {}) })
const names = (tree: BlueprintNode[]): unknown => tree.map((x) => (x.children?.length ? [x.title.en, names(x.children)] : x.title.en))

describe('blueprint tree edits', () => {
  const tree = () => [n('A', [n('A1'), n('A2')]), n('B'), n('C')]

  it('moves among siblings, either way', () => {
    expect(names(shiftNode(tree(), [0], 'down')!.tree)).toEqual(['B', ['A', ['A1', 'A2']], 'C'])
    expect(names(shiftNode(tree(), [2], 'up')!.tree)).toEqual([['A', ['A1', 'A2']], 'C', 'B'])
    expect(shiftNode(tree(), [0], 'up')).toBeNull()
    expect(shiftNode(tree(), [2], 'down')).toBeNull()
  })

  it('indents under the sibling above and outdents to after the parent', () => {
    const indented = shiftNode(tree(), [1], 'in')!
    expect(names(indented.tree)).toEqual([['A', ['A1', 'A2', 'B']], 'C'])
    expect(indented.path).toEqual([0, 2])
    const out = shiftNode(tree(), [0, 0], 'out')!
    expect(names(out.tree)).toEqual([['A', ['A2']], 'A1', 'B', 'C'])
    expect(out.path).toEqual([1])
  })

  it('reads a drop target as it was before the move, and refuses a move into itself', () => {
    // Drag A onto C's slot: removing A first must not land it one place too far.
    expect(names(moveNode(tree(), [0], null, 2)!.tree)).toEqual(['B', ['A', ['A1', 'A2']], 'C'])
    // Into a later sibling's children: that sibling's index shifts once A leaves.
    expect(names(moveNode(tree(), [0], [2], 0)!.tree)).toEqual(['B', ['C', [['A', ['A1', 'A2']]]]])
    expect(moveNode(tree(), [0], [0, 1], 0)).toBeNull()
  })

  it('inserts, removes and counts', () => {
    const { tree: t, path } = insertNode(tree(), [1], n('B1'))
    expect(path).toEqual([1, 0])
    expect(countPages(t)).toBe(6)
    expect(treeDepth(t)).toBe(2)
    expect(names(removeNode(t, [0]))).toEqual([['B', ['B1']], 'C'])
    expect(hasUntitled([n('X', [{ title: { en: ' ' } }])])).toBe(true)
  })

  it('titles a collection’s items as the scaffold will', () => {
    const decisions: BlueprintNode = {
      title: { en: 'Decisions' },
      collection: { childTitlePattern: { en: 'ADR {{n:4}}: ' } },
      children: [n('Use Postgres'), n('Use Redis')],
    }
    expect(itemTitles(decisions, 'en')).toEqual(['ADR 0001: Use Postgres', 'ADR 0002: Use Redis'])
  })
})
