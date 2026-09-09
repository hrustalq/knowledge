<script setup lang="ts">
// "On this page" rail (GitBook/Hugo-docs style) with scroll-spy.
import { useI18n } from 'vue-i18n'
import { onBeforeUnmount, ref, watch } from 'vue'

const { t } = useI18n()

interface Heading { id: string; text: string; level: number }
const props = defineProps<{ headings: Heading[] }>()

const active = ref<string | null>(null)
let observer: IntersectionObserver | null = null

function observe() {
  observer?.disconnect()
  if (import.meta.env.SSR || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          active.value = entry.target.id
          break
        }
      }
    },
    { rootMargin: '-104px 0px -70% 0px', threshold: 0 },
  )
  for (const h of props.headings) {
    const el = document.getElementById(h.id)
    if (el) observer.observe(el)
  }
}

watch(() => props.headings, observe, { immediate: true })
onBeforeUnmount(() => observer?.disconnect())

function go(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  active.value = id
}
</script>

<template>
  <nav :aria-label="t('tree.onThisPage')" class="text-sm">
    <p class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">On this page</p>
    <ul class="space-y-0.5 border-l">
      <li v-for="h in headings" :key="h.id">
        <button
          class="-ml-px block w-full truncate border-l-2 py-1 text-left transition-colors"
          :class="[
            h.level >= 3 ? 'pl-6' : 'pl-3',
            active === h.id
              ? 'border-primary font-medium text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          ]"
          @click="go(h.id)"
        >
          {{ h.text }}
        </button>
      </li>
    </ul>
  </nav>
</template>
