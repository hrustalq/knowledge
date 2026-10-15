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
import { Download, FilePlus2, LayoutTemplate, Lock, LockOpen, MoreHorizontal, MoveRight } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { RouterLink } from 'vue-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDocumentsStore } from '@/stores/documents'
import { useTemplatesStore } from '@/stores/templates'
import PageAccessDialog from '@/components/access/PageAccessDialog.vue'
import MoveToDialog from './MoveToDialog.vue'
import ExportDialog from './ExportDialog.vue'

/**
 * Two roots (the menu and its dialog), so an inherited `class` has nowhere to
 * land and Vue drops it — which silently disabled the hover reveal. The class
 * belongs on the trigger anyway: that is the thing that appears and disappears.
 *
 * Whatever hides it, the trigger stays shown while its menu is open
 * (`data-state="open"`, set by reka-ui). The content is portaled, so opening it
 * moves focus out of the row; a reveal keyed on hover/focus-within would then
 * drop the trigger to `display:none`, and the menu, anchored to a box with no
 * position, would open in the window's top-left corner (#203).
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{
  documentId: string
  title: string
  disabled?: boolean
  /** The row draws a lock (#76); the menu's Access item matches it. */
  restricted?: boolean
}>()

const { t } = useI18n()
const dialogOpen = ref(false)
const exportOpen = ref(false)
const accessOpen = ref(false)
const templates = useTemplatesStore()
const documents = useDocumentsStore()
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
        class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-5 shrink-0 place-items-center rounded disabled:opacity-40 data-[state=open]:grid data-[state=open]:opacity-100"
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
      <!-- A row stands for its branch here, so subpages start ticked (docs/features/45). -->
      <DropdownMenuItem @select="exportOpen = true">
        <Download class="size-3.5" />
        {{ t('export.action') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem @select="accessOpen = true">
        <Lock v-if="restricted" class="size-3.5" />
        <LockOpen v-else class="size-3.5" />
        {{ t('access.manageAccess') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <MoveToDialog
    v-model:open="dialogOpen"
    :document-id="documentId"
    :title="title"
    @failed="(message: string) => toast.error(message)"
  />
  <ExportDialog v-model:open="exportOpen" :target="{ kind: 'document', documentId, title }" subtree />
  <!-- A saved restriction redraws the locks on this branch and every one below it. -->
  <PageAccessDialog
    v-model:open="accessOpen"
    resource-type="document"
    :resource-id="documentId"
    :title="title"
    @saved="documents.invalidate()"
  />
</template>
