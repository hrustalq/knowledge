<script setup lang="ts">
/**
 * One row of the staged tree, plus the branch under it (docs/features/26).
 *
 * Recursive, and it closes over itself by name — a component may reference
 * itself inside its own template, which is what keeps a three-level Confluence
 * space from needing a flattening pass that would then have to re-derive depth
 * for indentation.
 *
 * Indentation comes from padding on the button rather than from nested
 * containers, so the hover and selection background still span the full width
 * of the panel at every depth. The hairline guides are decoration for the eye
 * only and are hidden from assistive tech — the DOM nesting already says what
 * they say, to anything that reads structure rather than pixels.
 *
 * The whole tree arrives in one response, so a twisty is a pure display toggle
 * and never fetches. `hasChildren` with no rows under it means something else
 * entirely: the adapter said this branch continues and the walk has not reached
 * it yet. That reads as a *discovery* hint, not as a collapsed branch, or a
 * reviewer would click a twisty that opens onto nothing.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Loader2, Sparkles } from 'lucide-vue-next'
import { allowedItemEvents, type ConnectorItemEventType } from '@knowledge/contracts'
import { Collapse } from '@/components/ui/collapse'
import {
  ACTION_CLASS,
  ACTION_ICON,
  ACTION_LABEL,
  ITEM_EVENT_LABEL,
  ITEM_STATUS_CLASS,
  ITEM_STATUS_ICON,
  ITEM_STATUS_LABEL,
  SUBTREE_EVENT_LABEL,
  isBusyItem,
  wantsReview,
  type ItemNode,
} from './connector-ui'

const props = defineProps<{
  node: ItemNode
  depth: number
  selectedId: string | null
  /** Ids with an event in flight, so a row can show it is acting. */
  busyIds: Set<string>
  canManage: boolean
}>()

const emit = defineEmits<{
  select: [string]
  event: [{ itemId: string; type: ConnectorItemEventType; subtree: boolean }]
}>()

const { t } = useI18n()

/**
 * Open by default. A review whose tree arrives closed asks the reviewer to
 * expand every branch before they can see what the run proposes, which is the
 * one thing this page exists to show.
 */
const open = ref(true)

const item = computed(() => props.node.item)
const children = computed(() => props.node.children)
const busy = computed(() => props.busyIds.has(item.value.id))

/** A branch the walk has not reached yet — not a collapsed one. */
const pendingBranch = computed(() => item.value.hasChildren && children.value.length === 0)

const events = computed(() => (props.canManage ? allowedItemEvents(item.value) : []))

/**
 * Subtree actions belong only on a row that *has* a subtree, and only for the
 * two verbs where "and everything under it" is a thing someone means. Retrying
 * or reverting a whole branch is a different, riskier gesture and is left to
 * the rows themselves.
 */
const subtreeEvents = computed(() =>
  children.value.length
    ? events.value.filter((e): e is 'APPROVE' | 'SKIP' => e === 'APPROVE' || e === 'SKIP')
    : [],
)

const indent = computed(() => `${0.5 + props.depth * 0.85}rem`)
</script>

<template>
  <li>
    <div
      class="group/row relative flex items-start gap-1.5 rounded-md pr-1.5 transition-colors"
      :class="selectedId === item.id ? 'bg-primary/8' : 'hover:bg-muted/50'"
      :style="{ paddingLeft: indent }"
    >
      <!-- Depth guides: decoration, so the tree reads as a tree at a glance. -->
      <span
        v-for="level in depth"
        :key="level"
        aria-hidden="true"
        class="bg-border/70 absolute top-0 bottom-0 w-px"
        :style="{ left: `${0.72 + (level - 1) * 0.85}rem` }"
      />

      <!-- The twisty occupies its slot even when there is nothing to fold, so
           titles down a branch share a left edge instead of stepping around. -->
      <button
        v-if="children.length"
        type="button"
        class="relative mt-1.5 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        :aria-expanded="open"
        :aria-label="open ? t('connectors.collapseBranch') : t('connectors.expandBranch')"
        @click="open = !open"
      >
        <ChevronRight class="size-3.5 transition-transform duration-150" :class="open && 'rotate-90'" />
      </button>
      <span v-else class="relative mt-1.5 size-4 shrink-0" aria-hidden="true" />

      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-2 py-1.5 text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:rounded focus-visible:outline-none"
        @click="emit('select', item.id)"
      >
        <component
          :is="busy ? Loader2 : ITEM_STATUS_ICON[item.status]"
          class="mt-0.5 size-3.5 shrink-0"
          :class="[
            busy ? 'text-primary animate-spin' : ITEM_STATUS_CLASS[item.status],
            !busy && isBusyItem(item.status) ? 'animate-spin' : '',
          ]"
          :aria-label="t(ITEM_STATUS_LABEL[item.status])"
        />

        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="min-w-0 truncate text-[13px] leading-snug" :class="wantsReview(item) ? 'font-medium' : ''">
              {{ item.title }}
            </span>
            <!-- A page a model rewrote must never look like one the external
                 system sent. -->
            <Sparkles
              v-if="item.aiOp"
              class="size-3 shrink-0 text-violet-600 dark:text-violet-400"
              :aria-label="t('connectors.aiWrote')"
            />
          </span>

          <span class="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-[11px]">
            <span v-if="item.action" class="inline-flex items-center gap-1" :class="ACTION_CLASS[item.action]">
              <component :is="ACTION_ICON[item.action]" class="size-3 shrink-0" aria-hidden="true" />
              {{ t(ACTION_LABEL[item.action]) }}
            </span>
            <span v-if="item.action">·</span>
            <span>{{ t(ITEM_STATUS_LABEL[item.status]) }}</span>
            <span v-if="item.edited">· {{ t('connectors.edited') }}</span>
            <span v-if="pendingBranch">· {{ t('connectors.branchPending') }}</span>
          </span>

          <span v-if="item.error" class="text-destructive block truncate text-[11px]">{{ item.error }}</span>
        </span>
      </button>

      <!-- Actions appear on hover and on keyboard focus, and stay put for the
           row being reviewed — a control that vanishes when the pointer leaves
           is unreachable from the pane you just walked over to. -->
      <span
        v-if="events.length"
        class="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100"
        :class="selectedId === item.id && 'opacity-100'"
      >
        <button
          v-for="type in events"
          :key="type"
          type="button"
          class="text-muted-foreground hover:bg-background hover:text-foreground rounded px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-50 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
          :disabled="busy"
          @click="emit('event', { itemId: item.id, type, subtree: false })"
        >
          {{ t(ITEM_EVENT_LABEL[type]) }}
        </button>
        <button
          v-for="type in subtreeEvents"
          :key="`sub-${type}`"
          type="button"
          class="text-muted-foreground hover:bg-background hover:text-foreground rounded px-1.5 py-0.5 text-[11px] disabled:opacity-50 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
          :disabled="busy"
          :title="t('connectors.applyToBranch')"
          @click="emit('event', { itemId: item.id, type, subtree: true })"
        >
          {{ t(SUBTREE_EVENT_LABEL[type]) }}
        </button>
      </span>
    </div>

    <Collapse v-if="children.length" :open="open">
      <ul>
        <ConnectorRunTreeNode
          v-for="child in children"
          :key="child.item.id"
          :node="child"
          :depth="depth + 1"
          :selected-id="selectedId"
          :busy-ids="busyIds"
          :can-manage="canManage"
          @select="emit('select', $event)"
          @event="emit('event', $event)"
        />
      </ul>
    </Collapse>
  </li>
</template>
