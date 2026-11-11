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
import { useNow } from '@vueuse/core'
import { Check, Circle, FilePlus2, FilePen, GitPullRequestArrow, Loader2, Lock, RotateCcw } from 'lucide-vue-next'
import { MEMO_STEPS, memoClock, type MemoDetailResponse, type MemoProposal, type MemoSpeaker } from '@knowledge/contracts'
import { request } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { apiQueryOptions } from '@/shared/api/queries'
import { Button } from '@/shared/ui/button'
import { apiUrl } from '@/shared/api/api'
import { formatDateTime, formatDuration, formatRelative } from '@/shared/utils/format'
import { PageLayout, PageState } from '@/shared/layout'
import { UserAvatar, useMembers } from '@/entities/person'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import MemoActions from '@/modules/memos/components/MemoActions.vue'
import { MEMO_STATUS_CLASS, MEMO_STATUS_ICON, isMemoInFlight, segmentAt } from '@/modules/memos/model/memo-ui'

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

/**
 * Where the memo is on its way (#876): the steps behind it, the one it is in
 * and the ones ahead. A Plaud memo never uploads, and is transcribed here
 * only when its owner asked for that.
 */
const SLOW_MS = 5 * 60_000
const now = useNow({ interval: 30_000 })
const steps = computed(() => {
  const progress = data.value?.progress
  if (!progress || !memo.value) return []
  const plaud = memo.value.source === 'plaud'
  const shown = MEMO_STEPS.filter((s) => !plaud || (s !== 'upload' && (s !== 'transcribe' || progress.step === 'transcribe')))
  const at = shown.indexOf(progress.step)
  return shown.map((step, i) => ({ step, at: i < at ? ('done' as const) : i === at ? ('current' as const) : ('ahead' as const) }))
})
/** Nothing has picked the step up for a while: said plainly, since the page cannot fix it. */
const slow = computed(() => {
  const progress = data.value?.progress
  return Boolean(progress && progress.state === 'waiting' && now.value.getTime() - new Date(progress.since).getTime() > SLOW_MS)
})

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

/**
 * Who is speaking (#880). A match that holds replaces the label in the
 * transcript; a guess from the label is offered beside it and counts for
 * nothing until it is confirmed.
 */
const NOBODY = 'nobody'
const { members, memberOf, nameOf } = useMembers()
const speakers = computed(() => data.value?.speakers ?? [])
const speakerOf = computed(() => new Map(speakers.value.map((s) => [s.label, s])))
const speakerName = (label: string) => {
  const userId = speakerOf.value.get(label)?.userId
  return userId ? nameOf(userId) : label
}
const matchSpeaker = (speaker: MemoSpeaker, userId: string | null) =>
  act(() => request('put', '/v1/memos/{id}/speakers', { path: { id: id.value }, body: { label: speaker.label, userId } }))

const retry = () => act(() => request('post', '/v1/memos/{id}/retry', { path: { id: id.value } }))
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
      <MemoActions :memo-id="memo.memoId" :title="memo.title" @deleted="router.push('/memos')" />
    </template>
    <template #meta>
      <p class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
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
            <span class="leading-relaxed" :class="playing === s.i ? 'text-foreground' : ''">
              <span v-if="s.speaker" class="font-medium">{{ speakerName(s.speaker) }}: </span>{{ s.text }}
            </span>
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
            {{ memo.source === 'plaud' ? t('memos.detail.audioPlaud') : t('memos.detail.audioGone') }}
          </p>
          <p v-if="memo.language" class="text-muted-foreground text-xs">{{ t('memos.detail.language', { language: memo.language }) }}</p>
        </div>

        <section v-if="data.progress" role="status" :aria-label="t('memos.detail.progress.title')">
          <ol class="space-y-2 text-sm">
            <li v-for="s in steps" :key="s.step" class="flex items-start gap-2.5" :aria-current="s.at === 'current' ? 'step' : undefined">
              <Check v-if="s.at === 'done'" class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <Loader2 v-else-if="s.at === 'current' && data.progress.state === 'running'" class="text-primary mt-0.5 size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
              <Circle v-else class="mt-0.5 size-4 shrink-0" :class="s.at === 'current' ? 'text-primary' : 'text-muted-foreground/50'" aria-hidden="true" />
              <div class="min-w-0">
                <p :class="s.at === 'current' ? 'font-medium' : 'text-muted-foreground'">{{ t(`memos.detail.step.${s.step}`) }}</p>
                <template v-if="s.at === 'current'">
                  <p class="text-muted-foreground">{{ t(`memos.detail.progress.${s.step}.${data.progress.state}`) }}</p>
                  <p class="text-muted-foreground text-xs" :title="formatDateTime(data.progress.since)">
                    {{ t('memos.detail.progress.since', { when: formatRelative(data.progress.since) }) }}<template v-if="slow"> · {{ t('memos.detail.progress.slow') }}</template>
                  </p>
                </template>
              </div>
            </li>
          </ol>
        </section>
        <div v-else-if="memo.status === 'failed'" role="alert" class="border-destructive/40 rounded-md border px-3 py-2 text-sm">
          <p class="text-destructive font-medium">{{ t('memos.detail.failed', { stage: t(`memos.detail.stage.${memo.stage ?? 'transcribing'}`) }) }}</p>
          <p v-if="memo.error" class="text-muted-foreground mt-1">{{ memo.error }}</p>
        </div>

        <section v-if="speakers.length" class="space-y-2">
          <h2 class="font-display text-base font-semibold">{{ t('memos.detail.speakers.title') }}</h2>
          <ul class="space-y-2">
            <li v-for="s in speakers" :key="s.label" class="space-y-1">
              <div class="flex items-center gap-2">
                <UserAvatar
                  v-if="s.userId"
                  :user-id="s.userId"
                  :name="nameOf(s.userId)"
                  :src="memberOf(s.userId)?.avatarUrl"
                  size="sm"
                />
                <span class="min-w-0 flex-1 truncate text-sm" :title="s.label">{{ s.label }}</span>
                <Select :model-value="s.userId ?? NOBODY" :disabled="acting" @update:model-value="matchSpeaker(s, $event === NOBODY ? null : String($event))">
                  <SelectTrigger size="sm" class="w-44" :aria-label="t('memos.detail.speakers.who', { label: s.label })">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="NOBODY">{{ t('memos.detail.speakers.nobody') }}</SelectItem>
                    <SelectItem v-for="m in members" :key="m.userId" :value="m.userId">{{ m.displayName }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p v-if="s.source === 'remembered'" class="text-muted-foreground text-xs">{{ t('memos.detail.speakers.remembered') }}</p>
              <p v-else-if="s.suggestedUserId" class="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                {{ t('memos.detail.speakers.suggested', { name: nameOf(s.suggestedUserId) }) }}
                <Button size="xs" variant="outline" :disabled="acting" @click="matchSpeaker(s, s.suggestedUserId)">
                  {{ t('memos.detail.speakers.confirm') }}
                </Button>
              </p>
            </li>
          </ul>
          <p class="text-muted-foreground text-xs">{{ t('memos.detail.speakers.hint') }}</p>
        </section>

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
