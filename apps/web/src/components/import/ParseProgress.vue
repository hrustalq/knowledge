<script setup lang="ts">
/**
 * One ring, two honest behaviours — and the handoff between them is this
 * surface's authored moment.
 *
 * While the browser is uploading, progress is *known* — real bytes over real
 * bytes — and the ring fills. The moment the worker takes over it is *not*
 * known: the client has a status row and no idea how much of a 300-page PDF is
 * left. So the ring stops claiming a number and sweeps instead. Inventing a
 * percentage for the second half is the cheap version of this component and the
 * reason progress bars stop being believed.
 *
 * The handoff is animated rather than swapped: the filled arc contracts into
 * the sweeping one, which is why both states are drawn with a two-part
 * `stroke-dasharray` (a one-part value cannot interpolate into a two-part one).
 * Watching the arc you filled become the arc that spins is the whole idea —
 * your work finished, someone else's began, and it is the same wait.
 *
 * The label underneath is the worker's own account of what it is doing, read
 * from the job row rather than guessed at in the browser.
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 0..1 when measurable, null while the worker is parsing. */
  progress: number | null
  stage: string
  filename: string
}>()

const SIZE = 120
const STROKE = 6
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** How much of the ring the indeterminate sweep occupies. */
const SWEEP = 0.26

const determinate = computed(() => props.progress !== null)
const fraction = computed(() => Math.min(1, Math.max(0, props.progress ?? 0)))
const percent = computed(() => Math.round(fraction.value * 100))

/**
 * Both states are `dash gap`, so the browser can tween one into the other:
 * filling draws `fraction` of the circle, sweeping draws a fixed short arc.
 */
const dashArray = computed(() =>
  determinate.value
    ? `${CIRCUMFERENCE * fraction.value} ${CIRCUMFERENCE}`
    : `${CIRCUMFERENCE * SWEEP} ${CIRCUMFERENCE}`,
)
</script>

<template>
  <div class="flex flex-col items-center gap-6 text-center">
    <div class="relative" :style="{ width: `${SIZE}px`, height: `${SIZE}px` }">
      <svg
        :width="SIZE"
        :height="SIZE"
        :viewBox="`0 0 ${SIZE} ${SIZE}`"
        class="-rotate-90"
        role="progressbar"
        :aria-valuenow="determinate ? percent : undefined"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="stage"
      >
        <circle :cx="SIZE / 2" :cy="SIZE / 2" :r="RADIUS" fill="none" :stroke-width="STROKE" class="stroke-border" />
        <circle
          :cx="SIZE / 2"
          :cy="SIZE / 2"
          :r="RADIUS"
          fill="none"
          :stroke-width="STROKE"
          stroke-linecap="round"
          class="kn-ring-arc stroke-primary"
          :class="determinate ? 'kn-ring-fill' : 'kn-ring-sweep'"
          :stroke-dasharray="dashArray"
        />
      </svg>

      <!-- The number belongs to the half that has one; the dot stands in for it
           while the worker is the one working. -->
      <span class="absolute inset-0 flex items-center justify-center">
        <Transition name="kn-ring-swap" mode="out-in">
          <span v-if="determinate" key="pct" class="text-xl font-medium tabular-nums">
            {{ percent }}<span class="text-sm text-muted-foreground">%</span>
          </span>
          <span v-else key="dot" class="kn-ring-pulse size-2.5 rounded-full bg-primary/70" aria-hidden="true" />
        </Transition>
      </span>
    </div>

    <div class="space-y-1">
      <!-- Polite, not assertive: the stage changes several times a parse and
           should not interrupt whatever the reader is doing. -->
      <p class="font-medium" aria-live="polite">{{ stage }}</p>
      <p class="text-sm text-muted-foreground">{{ filename }}</p>
    </div>
  </div>
</template>

<style scoped>
.kn-ring-arc {
  /* The arc's length is what changes in both states, so it is the one thing
     that transitions — the handoff is this line. */
  transition: stroke-dasharray 420ms cubic-bezier(0.16, 1, 0.3, 1);
}

.kn-ring-fill {
  transform-origin: 50% 50%;
}

/* Once the number is gone, the same arc becomes a sweep. */
.kn-ring-sweep {
  transform-origin: 50% 50%;
  animation: kn-ring-spin 1.15s cubic-bezier(0.5, 0.05, 0.5, 0.95) infinite;
}

.kn-ring-pulse {
  animation: kn-ring-breathe 1.6s ease-in-out infinite;
}

.kn-ring-swap-enter-active,
.kn-ring-swap-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.kn-ring-swap-enter-from,
.kn-ring-swap-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

@keyframes kn-ring-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes kn-ring-breathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

/*
 * Reduced motion: the sweep is the only thing that says "still working" when
 * there is no number, so it stays — slowed to a drift rather than removed,
 * which would leave a static ring indistinguishable from a stalled one.
 */
@media (prefers-reduced-motion: reduce) {
  .kn-ring-sweep {
    animation-duration: 3.2s;
    animation-timing-function: linear;
  }
  .kn-ring-pulse {
    animation-duration: 3.2s;
  }
  .kn-ring-arc {
    transition-duration: 200ms;
  }
  .kn-ring-swap-enter-from,
  .kn-ring-swap-leave-to {
    transform: none;
  }
}
</style>
