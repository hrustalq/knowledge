<script setup lang="ts">
// What the assistant is doing, while it does it.
//
// A spinner says "wait"; this says what it is waiting on. The harness runs in
// legs — the model narrates, reaches for a tool, then narrates again — and
// each leg is shown as it closes, so the trail grows downward at the pace of
// the actual work rather than appearing all at once at the end.
//
// Closed legs collapse to their tool chips. The prose behind them is
// reasoning, not answer, so it stays available (expandable) without competing
// with the reply that is streaming in below.
import { computed, ref } from 'vue'
import { Check, ChevronRight, Square, X } from 'lucide-vue-next'
import type { LiveTurn } from '@/stores/assistant'
import { toolVocabulary } from './tool-vocabulary'

const props = defineProps<{ live: LiveTurn }>()

const expanded = ref(false)

/** The leg currently in flight, shown open below the closed ones. */
const current = computed(() => ({
  running: props.live.running,
  finished: props.live.finished,
  text: props.live.phase === 'responding' ? '' : props.live.text,
}))

const headline = computed(() => {
  const running = props.live.running.at(-1)
  if (running) return toolVocabulary(running).running
  return props.live.phase === 'responding' ? 'Writing the answer' : 'Thinking'
})

const hasTrail = computed(
  () => props.live.steps.length > 0 || current.value.finished.length > 0 || current.value.text.length > 0,
)
</script>

<template>
  <div class="space-y-2 text-[13px]">
    <!-- Status line: always present, always specific about the current step. -->
    <div class="flex items-center gap-2 text-muted-foreground">
      <template v-if="live.stopped">
        <Square class="size-3 fill-current" aria-hidden="true" />
        <span>Stopped</span>
      </template>
      <template v-else>
        <span class="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
        <span aria-live="polite">{{ headline }}…</span>
      </template>
      <button
        v-if="hasTrail"
        type="button"
        class="ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <ChevronRight class="size-3 transition-transform duration-200" :class="expanded ? 'rotate-90' : ''" />
        {{ expanded ? 'Hide steps' : 'Show steps' }}
      </button>
    </div>

    <!-- The trail itself: a rule down the left, one entry per leg. -->
    <ol v-if="hasTrail" class="ml-[3px] space-y-2 border-l border-border/70 pl-4">
      <li v-for="(step, i) in live.steps" :key="i" class="space-y-1.5">
        <p v-if="expanded && step.text" class="text-muted-foreground/90 italic">{{ step.text }}</p>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="(tc, j) in step.toolCalls"
            :key="j"
            class="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[11px]"
            :class="tc.ok ? 'text-muted-foreground' : 'border-destructive/40 text-destructive'"
          >
            <component :is="toolVocabulary(tc.tool).icon" class="size-3" />
            {{ toolVocabulary(tc.tool).done }}
            <Check v-if="tc.ok" class="size-3 text-emerald-500" />
            <X v-else class="size-3" />
          </span>
        </div>
      </li>

      <li v-if="current.finished.length || current.running.length || current.text" class="space-y-1.5">
        <p v-if="expanded && current.text" class="text-muted-foreground/90 italic">{{ current.text }}</p>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="(tc, j) in current.finished"
            :key="`done-${j}`"
            class="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[11px]"
            :class="tc.ok ? 'text-muted-foreground' : 'border-destructive/40 text-destructive'"
          >
            <component :is="toolVocabulary(tc.tool).icon" class="size-3" />
            {{ toolVocabulary(tc.tool).done }}
            <Check v-if="tc.ok" class="size-3 text-emerald-500" />
            <X v-else class="size-3" />
          </span>
          <span
            v-for="(tool, j) in current.running"
            :key="`run-${j}`"
            class="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-[11px] text-primary"
          >
            <component :is="toolVocabulary(tool).icon" class="size-3" />
            {{ toolVocabulary(tool).running }}
            <span class="tool-pulse" aria-hidden="true" />
          </span>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
/*
 * Three dots that lift in sequence. The wave is the point: a spinner turns at
 * a constant rate whatever is happening, while a staggered cycle reads as
 * something taking its turns.
 */
.thinking-dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}
.thinking-dots i {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: currentColor;
  animation: thinking-lift 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
.thinking-dots i:nth-child(2) {
  animation-delay: 0.14s;
}
.thinking-dots i:nth-child(3) {
  animation-delay: 0.28s;
}
@keyframes thinking-lift {
  0%,
  60%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2.5px);
  }
}

/* A running tool's own heartbeat, distinct from the global status dots. */
.tool-pulse {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  animation: tool-breathe 1.4s ease-in-out infinite;
}
@keyframes tool-breathe {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-dots i,
  .tool-pulse {
    animation-duration: 2.4s;
    animation-timing-function: linear;
  }
  .thinking-dots i {
    animation-name: thinking-fade;
  }
}
@keyframes thinking-fade {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
</style>
