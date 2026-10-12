<script setup lang="ts">
/**
 * One action over the selected pages (docs/features/40). Appears above the
 * table the moment something is selected, and reads as the sweep it is: a
 * count, the verbs, and the way out.
 *
 * The verbs are the page's own (`VerificationBar`), bulk: **Verify** with a
 * review interval, **Request a check** and **Mark outdated** with a note the
 * owners will read, **Clear verification**, **Reassign** to a member or to
 * nobody, and — for an admin only, the way the route is — **Archive** and
 * **Unarchive**. Archive asks first: it is reversible, but it takes every
 * subtree with it and hides the pages from everyone.
 *
 * Nothing here calls the API. The bar hands a `HealthBulkRequest` up and the
 * page sends it with the ids, so the result handling (per-id errors, the
 * refetch, clearing the selection) lives next to the selection it clears.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, ArchiveRestore, BadgeCheck, ChevronDown, MoreHorizontal, X } from 'lucide-vue-next'
import type { VerificationFlag } from '@knowledge/contracts'
import { VERIFICATION_NOTE_MAX_CHARS } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import OwnerPicker from '@/components/verification/OwnerPicker.vue'
import { INTERVAL_CHOICES, intervalFromKey, intervalKey } from '@/components/verification/verification-ui'
import type { HealthBulkRequest } from './health-ui'

const props = defineProps<{
  count: number
  busy: boolean
  /** Archive and unarchive need `admin`, the way the route does. */
  canArchive: boolean
}>()
const emit = defineEmits<{
  run: [request: HealthBulkRequest]
  clear: []
}>()

const { t } = useI18n()

function verify(key: string) {
  emit('run', { action: 'verify', intervalDays: intervalFromKey(key) })
}

/** Request / outdated share one dialog: a note and a verb. */
const flagDialog = ref<VerificationFlag | null>(null)
const flagNote = ref('')
function openFlag(flag: VerificationFlag) {
  flagNote.value = ''
  flagDialog.value = flag
}
function submitFlag() {
  const flag = flagDialog.value
  if (!flag) return
  flagDialog.value = null
  const note = flagNote.value.trim()
  emit('run', { action: flag === 'outdated' ? 'outdated' : 'request', ...(note ? { note } : {}) })
}

const archiveOpen = ref(false)
function archive() {
  archiveOpen.value = false
  emit('run', { action: 'archive' })
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-sm"
    role="toolbar"
    :aria-label="t('health.bulk.toolbar')"
  >
    <span class="px-1 text-xs font-medium tabular-nums">{{ t('health.bulk.selected', { n: count }, count) }}</span>
    <span class="flex-1" aria-hidden="true" />

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="xs" :disabled="busy">
          <BadgeCheck class="size-3" />
          {{ t('health.bulk.verify') }}
          <ChevronDown class="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-60">
        <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">{{ t('verification.interval.title') }}</DropdownMenuLabel>
        <DropdownMenuRadioGroup :model-value="undefined" @update:model-value="(v) => typeof v === 'string' && verify(v)">
          <DropdownMenuRadioItem v-for="choice in INTERVAL_CHOICES" :key="intervalKey(choice)" :value="intervalKey(choice)">
            <template v-if="choice === null">{{ t('verification.interval.default') }}</template>
            <template v-else-if="choice === 0">{{ t('verification.interval.never') }}</template>
            <template v-else>{{ t('verification.interval.days', { n: choice }, choice) }}</template>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>

    <OwnerPicker
      :owner-id="null"
      can-edit
      always
      :disabled="busy"
      :label="t('health.bulk.reassign')"
      @change="(ownerId) => emit('run', { action: 'reassign', ownerId })"
    />

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="xs" :disabled="busy" :aria-label="t('health.bulk.more')">
          <MoreHorizontal class="size-3" />
          {{ t('health.bulk.more') }}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-56">
        <DropdownMenuItem @select="openFlag('requested')">{{ t('health.bulk.request') }}</DropdownMenuItem>
        <DropdownMenuItem @select="openFlag('outdated')">{{ t('health.bulk.outdated') }}</DropdownMenuItem>
        <DropdownMenuItem @select="emit('run', { action: 'clear' })">{{ t('health.bulk.clear') }}</DropdownMenuItem>
        <template v-if="props.canArchive">
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="archiveOpen = true">
            <Archive class="size-3.5" />
            {{ t('health.bulk.archive') }}
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('run', { action: 'unarchive' })">
            <ArchiveRestore class="size-3.5" />
            {{ t('health.bulk.unarchive') }}
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <Button variant="ghost" size="icon-xs" :disabled="busy" :aria-label="t('health.bulk.deselect')" :title="t('health.bulk.deselect')" @click="emit('clear')">
      <X class="size-3.5" />
    </Button>
  </div>

  <Dialog :open="flagDialog !== null" @update:open="(v: boolean) => !v && (flagDialog = null)">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>
          {{ flagDialog === 'outdated' ? t('verification.outdatedDialog.title') : t('verification.requestDialog.title') }}
        </DialogTitle>
        <DialogDescription>
          {{ flagDialog === 'outdated' ? t('verification.outdatedDialog.description') : t('verification.requestDialog.description') }}
        </DialogDescription>
      </DialogHeader>
      <Textarea
        v-model="flagNote"
        rows="3"
        :maxlength="VERIFICATION_NOTE_MAX_CHARS"
        :placeholder="flagDialog === 'outdated' ? t('verification.outdatedDialog.notePlaceholder') : t('verification.requestDialog.notePlaceholder')"
        :aria-label="t('verification.note')"
      />
      <DialogFooter>
        <Button variant="ghost" @click="flagDialog = null">{{ t('common.cancel') }}</Button>
        <Button :variant="flagDialog === 'outdated' ? 'destructive' : 'default'" @click="submitFlag">
          {{ flagDialog === 'outdated' ? t('verification.outdatedDialog.submit') : t('verification.requestDialog.submit') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="archiveOpen" @update:open="(v: boolean) => (archiveOpen = v)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('health.bulk.archiveDialog.title', { n: count }, count) }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t('health.bulk.archiveDialog.description') }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction @click="archive">{{ t('health.bulk.archiveDialog.confirm') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
