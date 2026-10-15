<script setup lang="ts">
/**
 * One row of a page tree, drawn the same wherever a tree is: the app's rail
 * (SidebarTreeNode) and a published site's nav (SiteTreeNode, issue #204).
 *
 * Store-free on purpose — no router, no Pinia, no auth — because the public
 * reader has none of them. The row only draws and reports: whoever owns the
 * tree decides what `open` and `loading` mean, fetches the children, and
 * renders them in a TreeBranch beside this row.
 *
 * The root element is the row itself, so a wrapper's attributes (DnD's ref,
 * pointer handlers, classes) land on it unchanged.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Loader2 } from 'lucide-vue-next'

const props = defineProps<{
  title: string
  href: string
  hasChildren: boolean
  open: boolean
  loading?: boolean
  active?: boolean
}>()
defineEmits<{ toggle: [] }>()

const { t } = useI18n()

const linkClass = 'min-w-0 flex-1 truncate py-1.5'
const current = computed(() => (props.active ? ('page' as const) : undefined))
</script>

<template>
  <div
    data-tree-row
    class="group relative flex items-center gap-1 rounded-md pr-1 text-sm transition-[background-color,color,opacity]"
    :class="
      active
        ? 'bg-primary/10 font-medium text-primary'
        : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'
    "
  >
    <button
      v-if="hasChildren"
      type="button"
      data-no-drag
      class="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent"
      :aria-label="open ? t('tree.collapse') : t('tree.expand')"
      :aria-expanded="open"
      :aria-busy="loading || undefined"
      @click.prevent="$emit('toggle')"
    >
      <Loader2 v-if="loading" class="size-3.5 animate-spin" aria-hidden="true" />
      <ChevronRight v-else class="size-3.5 transition-transform" :class="open ? 'rotate-90' : ''" aria-hidden="true" />
    </button>
    <!-- A leaf keeps the disclosure's slot, so every title starts on the same x. -->
    <span v-else class="grid size-5 shrink-0 place-items-center"><slot name="leaf" /></span>
    <slot name="link" :cls="linkClass" :current="current">
      <a :href="href" :class="linkClass" :title="title" :aria-current="current">{{ title }}</a>
    </slot>
    <slot />
  </div>
</template>
