<script setup lang="ts">
/**
 * Listening to a memo from its row (#884): play, a strip that shows how far
 * it is and takes a click or the arrow keys to seek, and the length. The
 * audio itself is the list's one element (`useMemoListPlayer`).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pause, Play } from 'lucide-vue-next'
import { memoClock } from '@knowledge/contracts'
import { memoBars, type MemoListPlayer } from '../model/memo-player'

const props = defineProps<{ memoId: string; title: string; durationSeconds: number | null; player: MemoListPlayer }>()

const { t } = useI18n()
const bars = computed(() => memoBars(props.memoId))
const mine = computed(() => props.player.current.value === props.memoId)
const playing = computed(() => mine.value && props.player.playing.value)
const length = computed(() => (mine.value && props.player.duration.value) || props.durationSeconds || 0)
const at = computed(() => (mine.value ? props.player.time.value : 0))
const played = computed(() => (length.value ? Math.min(1, at.value / length.value) : 0))

function seekTo(event: MouseEvent) {
  if (!mine.value) return props.player.toggle(props.memoId)
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  props.player.seek(props.memoId, ((event.clientX - box.left) / box.width) * length.value)
}
const nudge = (seconds: number) => props.player.seek(props.memoId, Math.min(length.value, at.value + seconds))
</script>

<template>
  <div class="flex shrink-0 items-center gap-2.5">
    <button
      type="button"
      class="bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-ring focus-visible:ring-offset-background grid size-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      :aria-label="t(playing ? 'memos.player.pause' : 'memos.player.play', { title })"
      :aria-pressed="playing"
      @click="player.toggle(memoId)"
    >
      <Pause v-if="playing" class="size-3.5" aria-hidden="true" />
      <Play v-else class="ml-0.5 size-3.5" aria-hidden="true" />
    </button>
    <!-- A slider once this memo is the one loaded; before that, a picture of one that starts it. -->
    <div
      class="focus-visible:ring-ring hidden h-8 w-40 cursor-pointer items-center gap-[3px] rounded-sm outline-none focus-visible:ring-2 sm:flex"
      :role="mine ? 'slider' : undefined"
      :tabindex="mine ? 0 : undefined"
      :aria-hidden="mine ? undefined : true"
      :aria-label="mine ? t('memos.player.position', { title }) : undefined"
      :aria-valuemin="mine ? 0 : undefined"
      :aria-valuemax="mine ? Math.round(length) : undefined"
      :aria-valuenow="mine ? Math.round(at) : undefined"
      :aria-valuetext="mine ? memoClock(at) : undefined"
      @click="seekTo"
      @keydown.left.prevent="nudge(-5)"
      @keydown.right.prevent="nudge(5)"
    >
      <span
        v-for="(h, i) in bars"
        :key="i"
        class="w-[2px] flex-1 rounded-full"
        :class="(i + 0.5) / bars.length <= played ? 'bg-foreground' : 'bg-muted-foreground/35'"
        :style="{ height: `${Math.round(h * 100)}%` }"
      />
    </div>
    <span v-if="length" class="text-muted-foreground w-11 text-right font-mono text-xs tabular-nums">{{ memoClock(mine && at ? at : length) }}</span>
  </div>
</template>
