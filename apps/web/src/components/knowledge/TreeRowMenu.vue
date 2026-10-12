<script setup lang="ts">
/**
 * Feature 32: the row's ⋯ menu, which exists so that moving a page is not only
 * a drag. It is also where a child page starts (issue #69): with a parent
 * already chosen, rather than picked afterwards in the editor's settings.
 *
 * It appears on hover and on focus-within, and it takes the status dot's slot
 * rather than a slot of its own — on a 256px rail, a second permanent
 * affordance is paid for out of the title, and a truncated title costs more
 * than a hidden control.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FilePlus2, LayoutTemplate, MoreHorizontal, MoveRight } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { RouterLink } from 'vue-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTemplatesStore } from '@/stores/templates'
import MoveToDialog from './MoveToDialog.vue'

/**
 * Two roots (the menu and its dialog), so an inherited `class` has nowhere to
 * land and Vue drops it — which silently disabled the hover reveal. The class
 * belongs on the trigger anyway: that is the thing that appears and disappears.
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{ documentId: string; title: string; disabled?: boolean }>()

const { t } = useI18n()
const dialogOpen = ref(false)
const templates = useTemplatesStore()
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      as-child
      :disabled="disabled"
      data-no-drag
      @pointerdown.stop
    >
      <button
        v-bind="$attrs"
        type="button"
        class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-5 shrink-0 place-items-center rounded disabled:opacity-40"
        :aria-label="t('tree.dnd.rowMenu', { title })"
      >
        <MoreHorizontal class="size-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-56">
      <DropdownMenuItem as-child>
        <RouterLink :to="{ path: '/create', query: { parent: documentId } }">
          <FilePlus2 class="size-3.5" />
          {{ t('tree.newChild') }}
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuItem @select="templates.openGallery({ parentId: props.documentId })">
        <LayoutTemplate class="size-3.5" />
        {{ t('tree.newChildFromTemplate') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem @select="dialogOpen = true">
        <MoveRight class="size-3.5" />
        {{ t('tree.dnd.moveTo') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <MoveToDialog
    v-model:open="dialogOpen"
    :document-id="documentId"
    :title="title"
    @failed="(message: string) => toast.error(message)"
  />
</template>
