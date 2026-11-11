import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { MEMO_TYPE_KEY_RE, type MemoType, type MemoTypesResponse } from '@knowledge/contracts'
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

/**
 * The key a new type is saved under. The name's Latin slug when it makes a
 * free key; otherwise the first free `type-N`, so a name in any other script
 * can be saved and a taken slug never overwrites the type that has it. The
 * key is never shown: a type is known by its name.
 */
export function newMemoTypeKey(name: string, taken: readonly string[]): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (MEMO_TYPE_KEY_RE.test(slug) && !taken.includes(slug)) return slug
  for (let n = 1; ; n++) if (!taken.includes(`type-${n}`)) return `type-${n}`
}
