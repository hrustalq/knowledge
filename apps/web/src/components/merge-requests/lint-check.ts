// The style lint of a merge request (#74): its checks, the policy of its page,
// and how one check reads. Shared by the merge widget's checklist row and the
// AI pane, which ask for the same query — vue-query fetches it once.
//
// The checks are refreshed by the live cache: the publisher emits
// `merge-request.updated` once a check settles.
import { computed, type ComputedRef, type Component } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { AlertCircle, AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, ScanText } from 'lucide-vue-next'
import type { ListMergeRequestChecksResponse, MergeRequestCheckInfo } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'

export function useLintChecks(mergeRequestId: ComputedRef<string>) {
  const query = useQuery(
    computed(() => apiQueryOptions('/v1/merge-requests/{id}/checks', { path: { id: mergeRequestId.value } })),
  )
  const data = computed(() => (query.data.value as ListMergeRequestChecksResponse | undefined) ?? null)
  /** The check of the source branch's current head, if it has one yet. */
  const current = computed(() => data.value?.checks.find((c) => c.current && c.kind === 'lint') ?? null)
  const policy = computed(() => data.value?.policy ?? null)
  /** Whether the row is worth showing: lint is on here, or this head was checked anyway. */
  const shown = computed(() => !!data.value && (data.value.policy.effective !== 'off' || !!current.value))

  const relint = useApiMutation('post', '/v1/merge-requests/{id}/checks/lint', {
    invalidates: () => [['/v1/merge-requests/{id}/checks', { id: mergeRequestId.value }]],
  })
  return { query, data, current, policy, shown, relint }
}

export interface LintCheckView {
  icon: Component
  tone: string
  /** A message key and its arguments, resolved with t() at the render site. */
  label: string
  args?: Record<string, unknown>
  /** Plural count for the label, when it has one. */
  count?: number
  /** A violation count still open — only on a check that found some. */
  unresolved: number
}

/** One check as the checklist reads it. `null` check: this head is not checked yet. */
export function lintCheckView(check: MergeRequestCheckInfo | null): LintCheckView {
  if (!check) return { icon: CircleDashed, tone: 'text-muted-foreground/60', label: 'mr.lint.notYet', unresolved: 0 }
  switch (check.status) {
    case 'pending':
      return { icon: CircleDashed, tone: 'text-muted-foreground', label: 'mr.lint.pending', unresolved: 0 }
    case 'running':
      return { icon: ScanText, tone: 'text-sky-500 animate-pulse', label: 'mr.lint.running', unresolved: 0 }
    case 'passed':
      return { icon: CheckCircle2, tone: 'text-emerald-500', label: 'mr.lint.passed', unresolved: 0 }
    case 'failed': {
      const c = check.counts ?? { error: 0, warning: 0, suggestion: 0 }
      const n = c.error + c.warning + c.suggestion
      return {
        icon: c.error > 0 ? AlertCircle : AlertTriangle,
        tone: c.error > 0 ? 'text-red-500' : 'text-amber-500',
        label: 'mr.lint.failed',
        args: { n },
        count: n,
        unresolved: check.unresolved,
      }
    }
    case 'error':
      return { icon: AlertTriangle, tone: 'text-amber-500', label: `mr.lint.reason.${check.reason ?? 'run-failed'}`, unresolved: 0 }
    case 'skipped':
      return { icon: CircleSlash, tone: 'text-muted-foreground/60', label: `mr.lint.reason.${check.reason ?? 'superseded'}`, unresolved: 0 }
  }
}
