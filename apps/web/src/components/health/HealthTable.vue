<script setup lang="ts">
/**
 * The rows of the knowledge-health page (docs/features/40): one page per
 * row, most neglected first, with what the dashboard exists to show — the
 * derived state, who answers for the page, when it was last verified and
 * last touched — and a checkbox for the sweep.
 *
 * A row is selected by its checkbox or by a click on its background, with
 * shift and cmd/ctrl read the way a file manager reads them (the rules live
 * in `health-selection.ts`). The title is a link to the page and the eye
 * opens a preview beside the table, so neither steals the row click.
 *
 * The state pill is `VerificationBadge`, the same pill the search sheet and
 * the page draw: the word for a state means one thing everywhere.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Archive, Eye, FileText } from 'lucide-vue-next'
import type { KnowledgeHealthRow } from '@knowledge/contracts'
import { relativeTime } from '@/lib/api'
import { formatDate, formatDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageState } from '@/components/layout/page'
import UserChip from '@/components/people/UserChip.vue'
import VerificationBadge from '@/components/verification/VerificationBadge.vue'
import { useMembers } from '@/components/merge-requests/use-members'
import { headerState, type HealthSelection, type SelectModifiers } from './health-selection'

const props = defineProps<{
  rows: readonly KnowledgeHealthRow[]
  selection: HealthSelection
  loading: boolean
  /** Some narrowing is applied, so an empty list means "nothing matches", not "nothing yet". */
  narrowed: boolean
  /** Editors select; a viewer's dashboard is read-only and draws no checkboxes. */
  canSelect: boolean
}>()
const emit = defineEmits<{
  select: [id: string, modifiers: SelectModifiers]
  toggleAll: []
  preview: [row: KnowledgeHealthRow]
  clear: []
}>()

const { t } = useI18n()
const { nameOf } = useMembers()

const order = computed(() => props.rows.map((r) => r.documentId))
const header = computed(() => headerState(props.selection, order.value))

function modifiersOf(event: MouseEvent | KeyboardEvent): SelectModifiers {
  return { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey }
}

/** A click on the row body selects; a click that landed on a control inside it does not. */
function onRowClick(row: KnowledgeHealthRow, event: MouseEvent) {
  if (!props.canSelect) return
  const target = event.target as HTMLElement | null
  if (target?.closest('a, button, [role="checkbox"]')) return
  // A shift-click would otherwise also select text across the rows it spans.
  if (event.shiftKey) window.getSelection()?.removeAllRanges()
  emit('select', row.documentId, modifiersOf(event))
}

/** The checkbox's own click: reka stops the native event, so modifiers are read on pointerdown. */
const pending = new Map<string, SelectModifiers>()
function onBoxPointerDown(row: KnowledgeHealthRow, event: PointerEvent) {
  pending.set(row.documentId, modifiersOf(event))
}
function onBoxChange(row: KnowledgeHealthRow) {
  const modifiers = pending.get(row.documentId) ?? {}
  pending.delete(row.documentId)
  emit('select', row.documentId, modifiers)
}

function verifiedLine(row: KnowledgeHealthRow): string {
  if (!row.verifiedAt) return '—'
  return t('health.verifiedBy', { who: nameOf(row.verifiedBy), when: relativeTime(row.verifiedAt) })
}
function expiryLine(row: KnowledgeHealthRow): string | null {
  if (!row.verifiedAt || row.status !== 'verified') return null
  return row.expiresAt ? t('health.expires', { when: formatDate(row.expiresAt) }) : t('health.neverExpires')
}
</script>

<template>
  <PageState v-if="loading" state="loading" :rows="8" row-class="h-11" />

  <PageState
    v-else-if="rows.length === 0"
    state="empty"
    :icon="FileText"
    :title="narrowed ? t('health.noRowsNarrowed') : t('health.noRows')"
    :description="narrowed ? undefined : t('health.noRowsHint')"
  >
    <Button v-if="narrowed" variant="outline" size="sm" @click="emit('clear')">{{ t('health.clearNarrowing') }}</Button>
  </PageState>

  <div v-else class="overflow-x-auto rounded-md border">
    <Table class="min-w-[44rem]">
      <TableHeader>
        <TableRow>
          <TableHead v-if="canSelect" class="w-9 pr-0">
            <Checkbox
              :model-value="header === 'all' ? true : header === 'some' ? 'indeterminate' : false"
              :aria-label="t('health.selectAll')"
              @update:model-value="emit('toggleAll')"
            />
          </TableHead>
          <TableHead>{{ t('health.column.title') }}</TableHead>
          <TableHead>{{ t('health.column.status') }}</TableHead>
          <TableHead>{{ t('health.column.owner') }}</TableHead>
          <TableHead>{{ t('health.column.verified') }}</TableHead>
          <TableHead>{{ t('health.column.activity') }}</TableHead>
          <TableHead class="w-10"><span class="sr-only">{{ t('health.preview') }}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="row in rows"
          :key="row.documentId"
          :data-state="selection.ids.has(row.documentId) ? 'selected' : undefined"
          :aria-selected="canSelect ? selection.ids.has(row.documentId) : undefined"
          :class="[
            canSelect ? 'cursor-default select-none' : '',
            row.archivedAt ? 'text-muted-foreground' : '',
          ]"
          @click="onRowClick(row, $event)"
        >
          <TableCell v-if="canSelect" class="pr-0 align-top">
            <Checkbox
              :model-value="selection.ids.has(row.documentId)"
              :aria-label="t('health.selectRow', { title: row.title })"
              @pointerdown="onBoxPointerDown(row, $event)"
              @update:model-value="onBoxChange(row)"
            />
          </TableCell>

          <TableCell class="max-w-[22rem] align-top">
            <RouterLink
              :to="`/documents/${row.documentId}`"
              class="block truncate text-sm font-medium hover:underline"
              :class="row.archivedAt ? 'line-through decoration-muted-foreground/40' : ''"
            >
              {{ row.title }}
            </RouterLink>
            <p v-if="row.breadcrumb" class="truncate text-xs text-muted-foreground" :title="row.breadcrumb">{{ row.breadcrumb }}</p>
            <p v-if="row.childCount > 0" class="text-xs text-muted-foreground">
              {{ t('health.children', { n: row.childCount }, row.childCount) }}
            </p>
          </TableCell>

          <TableCell class="align-top">
            <div class="flex flex-wrap items-center gap-1">
              <Badge v-if="row.archivedAt" variant="outline" class="gap-1 text-muted-foreground" :title="formatDateTime(row.archivedAt)">
                <Archive class="size-3" aria-hidden="true" />
                {{ t('verification.archived.badge') }}
              </Badge>
              <VerificationBadge v-else :state="row.status" size="xs" />
              <Badge v-if="row.inactive && !row.archivedAt" variant="outline" class="text-muted-foreground" :title="t('verification.inactiveHint')">
                {{ t('verification.inactive') }}
              </Badge>
              <Badge v-if="row.empty" variant="outline" class="text-muted-foreground" :title="t('health.emptyHint')">
                {{ t('health.emptyChip') }}
              </Badge>
            </div>
            <!-- The note is user or agent text: rendered as text, never as markup. -->
            <q v-if="row.verificationNote" class="mt-1 line-clamp-2 block text-xs text-muted-foreground italic" :title="row.verificationNote">
              {{ row.verificationNote }}
            </q>
          </TableCell>

          <TableCell class="align-top">
            <UserChip v-if="row.ownerId" :user-id="row.ownerId" size="sm" />
            <span v-else class="text-xs text-muted-foreground">{{ t('verification.unowned') }}</span>
          </TableCell>

          <TableCell class="align-top text-xs">
            <span :title="row.verifiedAt ? formatDateTime(row.verifiedAt) : undefined">{{ verifiedLine(row) }}</span>
            <p v-if="expiryLine(row)" class="text-muted-foreground">{{ expiryLine(row) }}</p>
          </TableCell>

          <TableCell class="align-top text-xs whitespace-nowrap" :title="formatDateTime(row.lastActivityAt)">
            {{ relativeTime(row.lastActivityAt) }}
          </TableCell>

          <TableCell class="align-top">
            <Button variant="ghost" size="icon-xs" :aria-label="t('health.preview')" :title="t('health.preview')" @click="emit('preview', row)">
              <Eye class="size-3.5" />
            </Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
