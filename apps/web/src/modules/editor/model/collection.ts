import type { QueryClient } from '@tanstack/vue-query'
import { nextChildTitle } from '@knowledge/contracts'
import { fetchApi } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

/** A collection's rule as a page carries it (#716): null on an ordinary page. */
export interface CollectionRule {
  childTemplateRef: string | null
  childTitlePattern: string | null
}

/**
 * Every child's title, archived ones too: a number an archived page still
 * holds is not handed out again (`nextChildTitle` keeps gaps, never refills).
 */
export async function childTitles(queryClient: QueryClient, parentId: string): Promise<string[]> {
  const { roots } = await fetchApi(
    queryClient,
    '/v1/documents/tree',
    { query: { workspaceId: getWorkspaceId(), parentId, depth: '1', includeArchived: '1' } },
    { fresh: true },
  )
  return roots.map((n) => n.title)
}

/** What "New page" under `parentId` starts as, or null when the parent is no collection. */
export async function nextInCollection(
  queryClient: QueryClient,
  parentId: string,
): Promise<{ title: string; templateRef: string | null } | null> {
  const { document } = await fetchApi(queryClient, '/v1/documents/{id}', { path: { id: parentId } })
  const pattern = document.childTitlePattern ?? null
  const templateRef = document.childTemplateRef ?? null
  if (!pattern && !templateRef) return null
  return { title: pattern ? nextChildTitle(pattern, await childTitles(queryClient, parentId)) : '', templateRef }
}
