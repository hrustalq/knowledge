import type { InjectionKey } from 'vue'
import type { SchemaNode } from '@/lib/api-spec'

/** What ApiSchema shares with every level of its ApiSchemaTree: open rows by path, and children (a recursion's once loaded). */
export interface SchemaTreeState {
  /** Unique per schema on the page, so row ids never collide between two bodies. */
  uid: string
  isOpen: (path: string) => boolean
  toggle: (path: string, node: SchemaNode) => void
  childrenOf: (path: string, node: SchemaNode) => SchemaNode[]
}

export const SCHEMA_TREE: InjectionKey<SchemaTreeState> = Symbol('kn-schema-tree')
