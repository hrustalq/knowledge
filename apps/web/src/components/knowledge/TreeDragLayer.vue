<script setup lang="ts">
/**
 * Feature 32: what a tree drag looks like above the page.
 *
 * Two things live here because both are per-tree rather than per-row: the ghost
 * that follows the pointer, and the live region that narrates the keyboard
 * drag. Everything else a drag draws — the insertion line, the nest tint, the
 * dimmed source row — belongs to the row it marks and is drawn there.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CornerDownRight } from 'lucide-vue-next'
import { useTreeDnd } from '@/components/knowledge/tree-dnd'
import { useDocumentsStore } from '@/stores/documents'

const { t } = useI18n()
const dnd = useTreeDnd()
const store = useDocumentsStore()

/**
 * The ghost teleports to `body`, and a teleport rendered during SSR has no
 * matching node for hydration to claim — it detaches the app's own root and the
 * page comes up blank. There is nothing to render server-side anyway: a drag
 * cannot be in progress before the first frame.
 */
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

const drag = computed(() => dnd?.state.value ?? null)

function titleOf(id: string | null): string {
  if (!id) return ''
  return store.pathTo(id).at(-1)?.title ?? ''
}

/**
 * The sentence the keyboard drag is steered by, so it has to name the whole
 * destination — which run, and where in it. "Moved down" would be true and
 * useless: it says the key registered, not where the page would land.
 */
const announcement = computed(() => {
  const d = drag.value
  if (!d || d.mode !== 'keyboard') return ''
  if (d.invalid) return t('tree.dnd.invalid', { title: d.title })
  const target = d.target
  if (!target) return t('tree.dnd.grabbed', { title: d.title })
  const parent = target.parentId ? titleOf(target.parentId) : t('tree.dnd.topLevel')
  return target.beforeId
    ? t('tree.dnd.positionBefore', { title: d.title, sibling: titleOf(target.beforeId), parent })
    : t('tree.dnd.positionLast', { title: d.title, parent })
})
</script>

<template>
  <!-- Polite, not assertive: this narrates a gesture the person is driving, so
       it should queue behind whatever they just did rather than interrupt it. -->
  <span class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</span>

  <Teleport v-if="mounted" to="body">
    <!-- Follows the pointer rather than sitting under it: offset down-right so
         the row it is about to land on is never hidden by the thing landing. -->
    <div
      v-if="drag?.mode === 'pointer'"
      class="kn-tree-ghost bg-popover text-popover-foreground border-border pointer-events-none fixed z-[120] flex max-w-64 items-center gap-1.5 truncate rounded-md border px-2 py-1 text-sm shadow-[0_16px_48px_-12px_rgb(0_0_0/0.2)]"
      :class="drag.invalid ? 'opacity-60 saturate-0' : ''"
      :style="{ left: `${drag.x + 12}px`, top: `${drag.y + 12}px` }"
    >
      <CornerDownRight class="text-muted-foreground size-3.5 shrink-0" />
      <span class="truncate">{{ drag.title }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
/* The ghost is the pointer, so it keeps tracking under reduced motion; only
   its arrival is softened. */
.kn-tree-ghost {
  animation: kn-ghost-in 120ms ease-out;
}
@keyframes kn-ghost-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
@media (prefers-reduced-motion: reduce) {
  .kn-tree-ghost {
    animation-duration: 1ms;
  }
}
</style>
