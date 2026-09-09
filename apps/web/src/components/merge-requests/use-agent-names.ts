import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { ListAiAgentChoicesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'

/**
 * Agent key → display name, for the surfaces that render an agent's words
 * (docs/features/21).
 *
 * The twin of `useMembers()`, and cached the same way: a discussion may hold
 * several replies from the same agent, and every ThreadCard on a page asking
 * separately would be one request per card. The endpoint is the viewer-safe
 * choices list — keys, names and descriptions, never prompts.
 */
export function useAgentNames() {
  const query = useQuery(
    apiQueryOptions('/v1/ai/agents/choices', { query: { workspaceId: getWorkspaceId() } }),
  )
  const agentNames = computed(
    () =>
      new Map(
        ((query.data.value as ListAiAgentChoicesResponse | undefined)?.agents ?? []).map((a) => [
          a.key,
          a.name,
        ]),
      ),
  )
  return { agentNames }
}
