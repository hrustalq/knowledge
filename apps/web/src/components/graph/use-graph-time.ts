/**
 * A graph surface's time state (#81): the point it shows, the graph at that
 * point, the compare overlay and the timeline the slider draws. The pages
 * landing and the maximized page graph both mount it, each with its own
 * fetch, so neither re-derives the rules.
 *
 * `?asOf=` is read once, as an opening instruction (the house rule for query
 * state, like `?tab=`); the slider never writes it back.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import type { GraphTimelineResponse, ResolvedAsOf } from '@knowledge/contracts'
import { fetchApi } from '@/api/queries'
import { diffSince, type GraphPair } from './graph-model'
import { asOfParam, timelineWindow, type TimePoint } from './graph-time'

/** Long enough that a drag across the track costs one request, not forty. */
const FETCH_DEBOUNCE_MS = 250

export function useGraphTime(opts: {
  /** The graph as it is now, from whatever already holds it. */
  now: () => GraphPair | null
  /** The graph at an `asOf`, echoing what it resolved to. */
  fetchAt: (asOf: string) => Promise<{ pair: GraphPair; resolvedAsOf?: ResolvedAsOf }>
  /** `{ workspaceId, projectId? }` for the tag and timeline reads. */
  scopeQuery: () => { workspaceId: string; projectId?: string }
  /** `?asOf=` as the page opened with it: a date, `tag:<name>` or `rev:<id>`. */
  initial?: string | null
}) {
  const queryClient = useQueryClient()
  const point = ref<TimePoint | null>(null)
  /** A deep-linked `tag:`/`rev:` waiting for the API to say which instant it is. */
  const pendingParam = ref<string | null>(opts.initial?.trim() || null)
  const past = shallowRef<GraphPair | null>(null)
  const compare = ref(false)
  const timeline = shallowRef<GraphTimelineResponse | null>(null)
  const span = ref<{ from: number; to: number } | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const param = computed(() => pendingParam.value ?? (point.value ? asOfParam(point.value) : null))

  /** What the canvas draws: now, the past, or the past with what changed since. */
  const display = computed<GraphPair | null>(() => {
    if (!param.value) return opts.now()
    if (!past.value) return null
    const now = opts.now()
    return compare.value && now ? diffSince(past.value, now) : past.value
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let token = 0
  async function load(asOf: string) {
    const mine = ++token
    loading.value = true
    error.value = null
    try {
      const { pair, resolvedAsOf } = await opts.fetchAt(asOf)
      if (mine !== token) return
      past.value = pair
      if (pendingParam.value && resolvedAsOf) {
        point.value = { at: Date.parse(resolvedAsOf.at), ...(resolvedAsOf.kind === 'tag' ? { tag: resolvedAsOf.ref.slice(4) } : {}) }
        pendingParam.value = null
      }
    } catch (e) {
      if (mine !== token) return
      error.value = e instanceof Error ? e.message : String(e)
      pendingParam.value = null
    } finally {
      if (mine === token) loading.value = false
    }
  }

  watch(
    param,
    (p) => {
      clearTimeout(timer)
      if (!p) {
        token++
        past.value = null
        loading.value = false
        compare.value = false
        return
      }
      timer = setTimeout(() => void load(p), FETCH_DEBOUNCE_MS)
    },
  )
  // A deep link reads on the client only: the canvas does not render on the server.
  onMounted(() => {
    if (param.value) void load(param.value)
  })

  async function loadTimeline() {
    try {
      const q = opts.scopeQuery()
      const { tags } = await fetchApi(queryClient, '/v1/release-tags', { query: q })
      const w = timelineWindow(tags, Date.now())
      span.value = w
      timeline.value = await fetchApi(queryClient, '/v1/graph/timeline', {
        query: { ...q, from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() },
      })
    } catch {
      // The slider still works without markers; the graph read reports errors.
      timeline.value = null
    }
  }

  /** Re-read the graph at the current point — after the scope or depth changed. */
  function refresh() {
    if (param.value) void load(param.value)
  }

  onBeforeUnmount(() => clearTimeout(timer))

  return {
    point,
    param,
    compare,
    timeline,
    span,
    display,
    loading,
    error,
    loadTimeline,
    refresh,
    set(next: TimePoint | null) {
      pendingParam.value = null
      point.value = next
    },
  }
}

export type GraphTime = ReturnType<typeof useGraphTime>
