<script setup lang="ts">
/**
 * /memos/:id (#551, docs/features/68): one recording, what it was heard to
 * say, and what that changes.
 *
 * The transcript is the reading surface; the rail beside it carries the
 * player, the summary and the proposals. The page's one move is the link
 * between them: a proposal's timestamp seeks the player and brings the lines
 * it rests on into view, marked, so a reviewer judges a change against the
 * moment that justifies it rather than against the model's word. Playing marks
 * the current line as it goes.
 *
 * Below `lg` the rail comes first — a two-hour transcript above the player
 * would put the controls an hour's scroll away. `?t=` (the link every merge
 * request carries back) is an opening instruction: seek there once, then let
 * the reader drive.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ArrowLeft, FilePlus2, FilePen, GitPullRequestArrow, Lock, RotateCcw, Trash2 } from 'lucide-vue-next'
import { memoClock, type MemoDetailResponse, type MemoProposal } from '@knowledge/contracts'
import { request } from '@/api/client'
import { errorMessage } from '@/api/errors'
import { apiQueryOptions } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { apiUrl } from '@/lib/api'
import { formatDateTime, formatDuration } from '@/lib/format'
import { PageLayout, PageState } from '@/components/layout/page'
import { MEMO_STATUS_CLASS, MEMO_STATUS_ICON, isMemoInFlight, segmentAt } from '@/components/memos/memo-ui'

const { t } = useI18n()
const route = useRoute()
const id = computed(() => String(route.params.id))

const memoQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/memos/{id}', { path: { id: id.value } }),
    refetchInterval: (q: { state: { data: unknown } }) => {
      const memo = (q.state.data as MemoDetailResponse | undefined)?.memo
      return memo && isMemoInFlight(memo.status) ? 3000 : false
    },
  })),
)
const data = computed(() => memoQuery.data.value as MemoDetailResponse | undefined)
const memo = computed(() => data.value?.memo)
const transcript = computed(() => data.value?.transcript ?? [])

const player = ref<HTMLAudioElement | null>(null)
const lines = ref<HTMLElement | null>(null)
/** The line under the playhead, and the lines a proposal pointed at. */
const playing = ref<number | null>(null)
const cited = ref<ReadonlySet<number>>(new Set())

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function reveal(i: number) {
  lines.value
    ?.querySelector(`[data-segment="${i}"]`)
    ?.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
}

function seek(seconds: number, play = true) {
  const audio = player.value
  if (!audio) return
  audio.currentTime = seconds
  if (play) void audio.play().catch(() => undefined)
}

function showCited(proposal: MemoProposal, segment: number) {
  cited.value = new Set(proposal.segments)
  const at = transcript.value.find((s) => s.i === segment)
  if (!at) return
  seek(at.start)
  void nextTick(() => reveal(segment))
}

function onTime() {
  const now = player.value?.currentTime ?? 0
  playing.value = segmentAt(transcript.value, now)
}

// `?t=` once, when the audio can take it.
const opened = ref(false)
function onReady() {
  if (opened.value) return
  opened.value = true
  const at = Number(route.query.t)
  if (!Number.isFinite(at) || at < 0) return
  seek(at, false)
  const i = segmentAt(transcript.value, at)
  if (i !== null) {
    cited.value = new Set([i])
    void nextTick(() => reveal(i))
  }
}
watch(id, () => {
  opened.value = false
  cited.value = new Set()
  playing.value = null
})

const segmentStart = (i: number) => transcript.value.find((s) => s.i === i)?.start ?? 0

const router = useRouter()
const queryClient = useQueryClient()
const acting = ref(false)

async function act(run: () => Promise<unknown>) {
  if (acting.value) return
  acting.value = true
  try {
    await run()
    await queryClient.invalidateQueries({ queryKey: ['/v1/memos'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    acting.value = false
  }
}

const retry = () => act(() => request('post', '/v1/memos/{id}/retry', { path: { id: id.value } }))

async function remove() {
  const ok = await confirm({
    title: t('memos.detail.deleteTitle'),
    description: t('memos.detail.deleteBody'),
    action: t('memos.detail.delete'),
    destructive: true,
  })
  if (!ok) return
  await act(async () => {
    await request('delete', '/v1/memos/{id}', { path: { id: id.value } })
    await router.push('/memos')
  })
}
</script>

<template>
  <PageState v-if="memoQuery.isPending.value" state="loading" :rows="6" row-class="h-6" />
  <PageState v-else-if="memoQuery.isError.value" state="error" :error="memoQuery.error.value" />

  <PageLayout v-else-if="memo && data" variant="detail" :title="memo.title">
    <template #status>
      <span class="inline-flex items-center gap-1.5 text-sm" :class="MEMO_STATUS_CLASS[memo.status]">
        <component
          :is="MEMO_STATUS_ICON[memo.status]"
          class="size-4"
          :class="memo.status === 'transcribing' ? 'motion-safe:animate-spin' : ''"
          aria-hidden="true"
        />
        {{ t(`memos.status.${memo.status}`) }}
      </span>
    </template>
    <template #actions>
      <Button v-if="memo.status === 'failed'" size="sm" :disabled="acting" @click="retry">
        <RotateCcw class="size-4" aria-hidden="true" />{{ t('memos.detail.retry') }}
      </Button>
      <Button size="sm" variant="ghost" :disabled="acting" @click="remove">
        <Trash2 class="size-4" aria-hidden="true" />{{ t('memos.detail.delete') }}
      </Button>
    </template>
    <template #meta>
      <p class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <RouterLink to="/memos" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ArrowLeft class="size-3.5" aria-hidden="true" />{{ t('memos.detail.back') }}
      </RouterLink>
      <span class="text-muted-foreground">{{ formatDateTime(memo.createdAt) }}</span>
      <span v-if="memo.durationSeconds" class="text-muted-foreground tabular-nums">{{ formatDuration(memo.durationSeconds * 1000) }}</span>
      <span class="text-muted-foreground inline-flex items-center gap-1"><Lock class="size-3" aria-hidden="true" />{{ t('memos.detail.private') }}</span>
      </p>
    </template>

    <!-- The transcript: the reading surface. -->
    <section :aria-label="t('memos.detail.transcript')">
      <h2 class="font-display mb-3 text-base font-semibold">{{ t('memos.detail.transcript') }}</h2>
      <p v-if="!transcript.length" class="text-muted-foreground text-sm">{{ t('memos.detail.noTranscript') }}</p>
      <ol v-else ref="lines" class="-mx-2 space-y-0.5">
        <li v-for="s in transcript" :key="s.i">
          <button
            type="button"
            :data-segment="s.i"
            class="group focus-visible:ring-ring grid w-full grid-cols-[3.75rem_minmax(0,1fr)] gap-3 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2"
            :class="[
              cited.has(s.i) ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
              memo.audioAvailable ? '' : 'cursor-default',
            ]"
            :aria-current="playing === s.i ? 'true' : undefined"
            :aria-label="memo.audioAvailable ? t('memos.detail.seek', { time: memoClock(s.start) }) + ': ' + s.text : undefined"
            :disabled="!memo.audioAvailable"
            @click="seek(s.start)"
          >
            <span
              class="pt-0.5 font-mono text-xs tabular-nums"
              :class="playing === s.i ? 'text-primary font-semibold' : 'text-muted-foreground group-hover:text-foreground'"
            >{{ memoClock(s.start) }}</span>
            <span class="kn-measure text-[0.95rem] leading-relaxed" :class="playing === s.i ? 'text-foreground' : ''">{{ s.text }}</span>
          </button>
        </li>
      </ol>
    </section>

    <template #rail>
      <!-- Sticky, and scrolling on its own once taller than the viewport, so
           the dropped list is reachable without reaching the transcript's end. -->
      <aside class="order-first space-y-5 lg:sticky lg:top-6 lg:order-none lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:pr-1">
        <div class="space-y-2">
          <audio
            v-if="memo.audioAvailable"
            ref="player"
            class="w-full"
            controls
            preload="metadata"
            :src="apiUrl(`/v1/memos/${memo.memoId}/audio`)"
            @loadedmetadata="onReady"
            @timeupdate="onTime"
          />
          <p v-else-if="memo.status !== 'pending'" class="text-muted-foreground rounded-md border px-3 py-2 text-sm">
            {{ t('memos.detail.audioGone') }}
          </p>
          <p v-if="memo.language" class="text-muted-foreground text-xs">{{ t('memos.detail.language', { language: memo.language }) }}</p>
        </div>

        <p v-if="isMemoInFlight(memo.status)" role="status" class="text-muted-foreground text-sm">
          {{ t(`memos.detail.inFlight.${memo.status}`) }}
        </p>
        <div v-else-if="memo.status === 'failed'" role="alert" class="border-destructive/40 rounded-md border px-3 py-2 text-sm">
          <p class="text-destructive font-medium">{{ t('memos.detail.failed', { stage: t(`memos.detail.stage.${memo.stage ?? 'transcribing'}`) }) }}</p>
          <p v-if="memo.error" class="text-muted-foreground mt-1">{{ memo.error }}</p>
        </div>

        <section v-if="data.summary" class="space-y-1.5">
          <h2 class="font-display text-base font-semibold">{{ t('memos.detail.summary') }}</h2>
          <p class="text-sm leading-relaxed">{{ data.summary }}</p>
        </section>

        <section v-if="memo.status === 'done' || data.proposals.length" class="space-y-2">
          <h2 class="font-display text-base font-semibold">
            {{ t('memos.detail.proposals') }}
            <span class="text-muted-foreground font-sans text-sm font-normal tabular-nums">{{ data.proposals.length }}</span>
          </h2>
          <p v-if="!data.proposals.length" class="text-muted-foreground text-sm">{{ t('memos.detail.noProposals') }}</p>
          <ul v-else class="divide-y rounded-lg border bg-card">
            <li v-for="(p, index) in data.proposals" :key="index" class="space-y-2 px-3 py-3">
              <div class="flex items-start gap-2">
                <component
                  :is="p.action === 'create' ? FilePlus2 : FilePen"
                  class="text-muted-foreground mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <p class="text-muted-foreground text-xs">{{ t(`memos.detail.${p.action}`) }}</p>
                  <RouterLink
                    v-if="p.action === 'update' && p.documentId"
                    :to="`/documents/${p.documentId}`"
                    class="font-medium hover:underline"
                  >{{ p.documentTitle ?? p.title }}</RouterLink>
                  <p v-else class="font-medium">{{ p.title }}</p>
                  <p class="text-muted-foreground mt-0.5 text-sm">{{ p.detail }}</p>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-1.5 pl-6">
                <span class="text-muted-foreground text-xs">{{ t('memos.detail.cites') }}</span>
                <button
                  v-for="s in p.segments"
                  :key="s"
                  type="button"
                  class="hover:bg-accent focus-visible:ring-ring rounded-full border px-2 py-0.5 font-mono text-xs tabular-nums outline-none focus-visible:ring-2"
                  :aria-label="t('memos.detail.seek', { time: memoClock(segmentStart(s)) })"
                  @click="showCited(p, s)"
                >{{ memoClock(segmentStart(s)) }}</button>
              </div>
              <div class="pl-6">
                <RouterLink
                  v-if="p.mergeRequestId"
                  :to="`/merge-requests/${p.mergeRequestId}`"
                  class="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  <GitPullRequestArrow class="size-3.5" aria-hidden="true" />{{ t('memos.detail.openMr') }}
                </RouterLink>
                <span v-else class="text-muted-foreground text-xs">{{ t('memos.detail.notOpened') }}</span>
              </div>
            </li>
          </ul>
        </section>

        <section v-if="data.dropped.length" class="space-y-2">
          <h2 class="font-display text-base font-semibold">
            {{ t('memos.detail.dropped') }}
            <span class="text-muted-foreground font-sans text-sm font-normal tabular-nums">{{ data.dropped.length }}</span>
          </h2>
          <ul class="text-muted-foreground space-y-1 text-sm">
            <li v-for="(d, index) in data.dropped" :key="index">
              <span class="text-foreground">{{ d.title }}</span> — {{ t(`memos.detail.dropReason.${d.reason}`) }}
            </li>
          </ul>
        </section>
      </aside>
    </template>
  </PageLayout>
</template>
