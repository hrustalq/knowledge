<script setup lang="ts">
/**
 * "Export…" (docs/features/45): a page, a page and its subpages, or a whole
 * project, as a ZIP of markdown, an offline HTML site or a PDF.
 *
 * Exporting is a reader's act, so the dialog is offered to every role. The job
 * runs in the background: the dialog queues it and points at the exports page,
 * where it can be downloaded once it is done (and where the inbox's "export
 * ready" notification leads).
 *
 * PDF is shown even where the deployment cannot make one, disabled with the
 * reason — a format that silently disappears reads as a bug, not a setting.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { EXPORT_FORMATS, type ExportCapabilitiesResponse, type ExportFormat } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

export type ExportTarget =
  | { kind: 'document'; documentId: string; title: string }
  | { kind: 'project'; projectId: string; title: string }

const props = defineProps<{
  target: ExportTarget
  /** Start with "Include subpages" ticked — the tree's menu, where a row stands for its branch. */
  subtree?: boolean
}>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const router = useRouter()

const format = ref<ExportFormat>('zip')
const includeSubtree = ref(false)
const branch = ref('')
const submitting = ref(false)

// Reset per opening, like MoveToDialog: last time's choice is not this one's.
// Immediate: a caller may mount this already open (TreeRowMenu, #279).
watch(open, (isOpen) => {
  if (!isOpen) return
  format.value = 'zip'
  includeSubtree.value = !!props.subtree
  branch.value = ''
}, { immediate: true })

const capsQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/exports/capabilities', { query: { workspaceId: getWorkspaceId() } }),
    enabled: open.value,
    staleTime: 5 * 60_000,
  })),
)
const caps = computed(() => capsQuery.data.value as ExportCapabilitiesResponse | undefined)
const available = (f: ExportFormat) => caps.value?.formats[f] ?? f !== 'pdf'

const title = computed(() =>
  props.target.kind === 'project'
    ? t('export.dialog.titleProject', { title: props.target.title })
    : t('export.dialog.title', { title: props.target.title }),
)

async function submit() {
  if (!available(format.value)) return
  submitting.value = true
  try {
    const body = { format: format.value, branch: branch.value.trim() || null }
    if (props.target.kind === 'document') {
      await api.post('/v1/documents/{id}/exports', {
        path: { id: props.target.documentId },
        body: { ...body, includeSubtree: includeSubtree.value },
      })
    } else {
      await api.post('/v1/projects/{id}/exports', { path: { id: props.target.projectId }, body })
    }
    open.value = false
    toast.success(t('export.queued'), {
      description: t('export.queuedHint'),
      action: { label: t('export.viewExports'), onClick: () => void router.push('/settings/exports') },
    })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="truncate">{{ title }}</DialogTitle>
        <DialogDescription>{{ t('export.dialog.description', { hours: caps?.ttlHours ?? 72 }) }}</DialogDescription>
      </DialogHeader>

      <form id="kn-export-form" class="space-y-4" @submit.prevent="submit">
        <fieldset class="space-y-2">
          <legend class="mb-1 text-sm font-medium">{{ t('export.dialog.format') }}</legend>
          <RadioGroup v-model="format" class="gap-2">
            <Label
              v-for="f in EXPORT_FORMATS"
              :key="f"
              :for="`kn-export-${f}`"
              class="has-[[data-state=checked]]:border-primary flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
            >
              <RadioGroupItem :id="`kn-export-${f}`" :value="f" :disabled="!available(f)" class="mt-0.5" />
              <span class="min-w-0">
                <span class="block text-sm font-medium">{{ t(`export.format.${f}`) }}</span>
                <span class="text-muted-foreground block text-xs">
                  {{ available(f) ? t(`export.formatHint.${f}`) : t('export.pdfUnavailable') }}
                </span>
              </span>
            </Label>
          </RadioGroup>
        </fieldset>

        <label v-if="target.kind === 'document'" class="flex items-center gap-2 text-sm">
          <Checkbox v-model="includeSubtree" />
          {{ t('export.dialog.includeSubtree') }}
        </label>

        <div class="space-y-1.5">
          <Label for="kn-export-branch">{{ t('export.dialog.branch') }}</Label>
          <Input id="kn-export-branch" v-model="branch" maxlength="100" :placeholder="t('export.dialog.branchPlaceholder')" />
          <p class="text-muted-foreground text-xs">{{ t('export.dialog.branchHint') }}</p>
        </div>
      </form>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="kn-export-form" :disabled="submitting || !available(format)">
          {{ submitting ? t('export.dialog.starting') : t('export.dialog.start') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
