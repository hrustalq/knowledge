import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { MemoType, MemoTypesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'

/**
 * The workspace's memo types (#879), and what to call one. A built-in the
 * workspace has not renamed is named in the reader's language; anything a
 * person named keeps their words.
 */
export function useMemoTypes(workspaceId: string) {
  const { t, te } = useI18n()
  const query = useQuery(apiQueryOptions('/v1/memos/types', { query: { workspaceId } }))
  const types = computed(() => (query.data.value as MemoTypesResponse | undefined)?.types ?? [])
  /** The ones a person can pick. */
  const offered = computed(() => types.value.filter((type) => !type.hidden))

  function nameOf(type: MemoType): string {
    const key = `memos.types.builtin.${type.key}`
    return type.builtIn && !type.overridden && te(key) ? t(key) : type.name
  }
  /** A memo's type by key; null for none, or for a type the workspace has since deleted. */
  function labelOf(key: string | null | undefined): string | null {
    const type = key ? types.value.find((x) => x.key === key) : undefined
    return type ? nameOf(type) : null
  }
  return { types, offered, nameOf, labelOf }
}
