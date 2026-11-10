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
import { Button } from '@/shared/ui/button'
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
  <!-- DESIGN.md: a control is a round-rectangle, never a pill, and the accent is not spent on decoration:
       the played part is ink, the rest is muted. -->
  <div class="flex items-center gap-2">
    <Button
      variant="outline"
      size="icon-xs"
      class="shrink-0"
      :aria-label="t(playing ? 'memos.player.pause' : 'memos.player.play', { title })"
      :aria-pressed="playing"
      @click="player.toggle(memoId)"
    >
      <Pause v-if="playing" aria-hidden="true" />
      <Play v-else aria-hidden="true" />
    </Button>
    <!-- A slider once this memo is the one loaded; before that, a picture of one that starts it. -->
    <div
      class="focus-visible:ring-ring flex h-4 w-32 cursor-pointer items-center gap-0.5 rounded-sm outline-none focus-visible:ring-2"
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
        class="min-w-px flex-1 rounded-full"
        :class="(i + 0.5) / bars.length <= played ? 'bg-foreground' : 'bg-muted-foreground/40'"
        :style="{ height: `${Math.round(h * 100)}%` }"
      />
    </div>
    <span v-if="mine && at" class="text-muted-foreground font-mono text-xs tabular-nums">{{ memoClock(at) }}</span>
  </div>
</template>
