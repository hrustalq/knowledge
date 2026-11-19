<script setup lang="ts">
// One home widget's frame (#1243): a heading, an optional way on, and in
// customize mode the three controls that edit the layout. The body is the
// widget's own; hidden in customize mode it collapses to the heading.
import { nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-vue-next'
import { Button } from '@knowledge/ui/button'

const props = defineProps<{
  title: string
  /** Where the full list lives. */
  to?: string
  toLabel?: string
  /** Visually hidden heading: the strip and the actions speak for themselves. */
  quiet?: boolean
  customizing?: boolean
  shown?: boolean
  first?: boolean
  last?: boolean
}>()
const emit = defineEmits<{ move: [step: -1 | 1]; toggle: [] }>()

const { t } = useI18n()
const headingId = useId()
const up = ref<InstanceType<typeof Button> | null>(null)
const down = ref<InstanceType<typeof Button> | null>(null)
const toggler = ref<InstanceType<typeof Button> | null>(null)

/**
 * Moving re-inserts this section, which blurs the pressed button. So the
 * arrows stay focusable at an end (`aria-disabled`, a no-op) and focus goes
 * back to the one pressed once the zone has re-rendered.
 */
async function move(step: -1 | 1) {
  if (step === -1 ? props.first : props.last) return
  emit('move', step)
  await nextTick()
  ;((step === -1 ? up : down).value?.$el as HTMLElement | undefined)?.focus()
}
async function toggle() {
  emit('toggle')
  await nextTick()
  ;(toggler.value?.$el as HTMLElement | undefined)?.focus()
}
</script>

<template>
  <section :aria-labelledby="headingId" class="min-w-0" :class="customizing ? 'rounded-xl border border-dashed p-3' : ''">
    <div
      class="flex min-h-8 items-center gap-2"
      :class="[quiet && !customizing ? 'sr-only' : 'mb-2', customizing && !shown ? 'text-muted-foreground' : '']"
    >
      <h2 :id="headingId" class="font-display min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
        {{ props.title }}
        <span v-if="customizing && !shown" class="ml-1 text-xs font-normal">{{ t('home.customize.hidden') }}</span>
      </h2>
      <RouterLink
        v-if="to && !customizing"
        :to="to"
        class="-my-1 shrink-0 rounded-sm px-1 py-1 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring"
      >
        {{ toLabel }}
      </RouterLink>
      <div v-if="customizing" class="flex shrink-0 items-center gap-1">
        <template v-if="shown">
          <Button
            ref="up"
            variant="ghost"
            size="icon-sm"
            :aria-disabled="first || undefined"
            :class="first ? 'opacity-50' : ''"
            :aria-label="t('home.customize.moveUp', { name: title })"
            @click="move(-1)"
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            ref="down"
            variant="ghost"
            size="icon-sm"
            :aria-disabled="last || undefined"
            :class="last ? 'opacity-50' : ''"
            :aria-label="t('home.customize.moveDown', { name: title })"
            @click="move(1)"
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </template>
        <Button
          ref="toggler"
          variant="outline"
          size="sm"
          :aria-label="t(shown ? 'home.customize.hideNamed' : 'home.customize.showNamed', { name: title })"
          @click="toggle"
        >
          <component :is="shown ? EyeOff : Eye" aria-hidden="true" />
          {{ shown ? t('home.customize.hide') : t('home.customize.show') }}
        </Button>
      </div>
    </div>
    <slot v-if="!customizing || shown" />
  </section>
</template>
