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
import { ChevronRight, Loader2, MoreHorizontal, Sparkles } from 'lucide-vue-next'
import { allowedItemEvents, type ConnectorItemEventType } from '@knowledge/contracts'
import { Collapse } from '@/shared/ui/collapse'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu'
import {
  ACTION_CLASS,
  ACTION_ICON,
  ACTION_LABEL,
  ITEM_EVENT_ICON,
  ITEM_EVENT_LABEL,
  ITEM_STATUS_CLASS,
  ITEM_STATUS_ICON,
  ITEM_STATUS_LABEL,
  SUBTREE_EVENT_LABEL,
  isBusyItem,
  wantsReview,
  type ItemNode,
} from '../model/connector-ui'

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
 * three verbs where "and everything under it" is a thing someone means. Fetch
 * is the one people reach for most on a paused walk — read this section, leave
 * the rest of the space alone. Retrying or reverting a whole branch is a
 * different, riskier gesture and is left to the rows themselves.
 */
const subtreeEvents = computed(() =>
  children.value.length
    ? events.value.filter(
        (e): e is 'FETCH' | 'APPROVE' | 'SKIP' => e === 'FETCH' || e === 'APPROVE' || e === 'SKIP',
      )
    : [],
)

/**
 * The one verb the row says in words: what a reviewer most likely came to do.
 * Every other verb, the branch ones included, is a word in the row's menu —
 * never a fifth button fighting the title for width.
 */
const PRIMARY_ORDER: ConnectorItemEventType[] = ['APPROVE', 'RETRY', 'FETCH']
const primary = computed<ConnectorItemEventType | null>(
  () => PRIMARY_ORDER.find((e) => events.value.includes(e)) ?? events.value[0] ?? null,
)
const rest = computed(() => events.value.filter((e) => e !== primary.value))
/** Open menu keeps the toolbar up while the pointer is in the menu's portal. */
const menuOpen = ref(false)
const toolbarShown = computed(() => props.selectedId === item.value.id || menuOpen.value)

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
            <span class="min-w-0 truncate text-ui leading-snug" :class="wantsReview(item) ? 'font-medium' : ''">
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

          <span class="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-caption">
            <span v-if="item.action" class="inline-flex items-center gap-1" :class="ACTION_CLASS[item.action]">
              <component :is="ACTION_ICON[item.action]" class="size-3 shrink-0" aria-hidden="true" />
              {{ t(ACTION_LABEL[item.action]) }}
            </span>
            <span v-if="item.action">·</span>
            <span>{{ t(ITEM_STATUS_LABEL[item.status]) }}</span>
            <span v-if="item.edited">· {{ t('connectors.edited') }}</span>
            <span v-if="pendingBranch">· {{ t('connectors.branchPending') }}</span>
          </span>

          <span v-if="item.error" class="text-destructive block truncate text-caption">{{ item.error }}</span>
        </span>
      </button>

      <!-- Actions appear on hover and on keyboard focus, and stay put for the
           row being reviewed — a control that vanishes when the pointer leaves
           is unreachable from the pane you just walked over to.

           In flow, but only on that one row. Rendered on every row (as they
           once were, `shrink-0` and merely invisible) four Russian verbs took
           the width of a 24rem column from every title in the tree; laid over
           the row instead, they covered the title and status they act on. Shown
           only where the pointer, focus or selection is, they take room from
           that row alone: its title truncates and its status wraps beneath, and
           nothing is drawn on top of anything. At most two controls — the row's
           likeliest verb, in words, and a menu with the rest. -->
      <span
        v-if="events.length"
        class="relative shrink-0 items-center gap-px self-center group-focus-within/row:flex group-hover/row:flex"
        :class="toolbarShown ? 'flex' : 'hidden'"
      >
        <button
          v-if="primary"
          type="button"
          class="rounded px-2 py-0.5 text-caption font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          :class="ITEM_EVENT_ICON[primary] && 'grid size-6 place-items-center px-0'"
          :disabled="busy"
          :title="ITEM_EVENT_ICON[primary] ? t(ITEM_EVENT_LABEL[primary]) : undefined"
          :aria-label="ITEM_EVENT_ICON[primary] ? t(ITEM_EVENT_LABEL[primary]) : undefined"
          @click="emit('event', { itemId: item.id, type: primary, subtree: false })"
        >
          <component :is="ITEM_EVENT_ICON[primary]" v-if="ITEM_EVENT_ICON[primary]" class="size-3.5" aria-hidden="true" />
          <template v-else>{{ t(ITEM_EVENT_LABEL[primary]) }}</template>
        </button>

        <DropdownMenu v-if="rest.length || subtreeEvents.length" v-model:open="menuOpen">
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
              :disabled="busy"
              :aria-label="t('connectors.moreActions', { title: item.title })"
            >
              <MoreHorizontal class="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="min-w-44">
            <DropdownMenuItem v-for="type in rest" :key="type" @select="emit('event', { itemId: item.id, type, subtree: false })">
              <component :is="ITEM_EVENT_ICON[type]" v-if="ITEM_EVENT_ICON[type]" class="size-3.5" aria-hidden="true" />
              {{ t(ITEM_EVENT_LABEL[type]) }}
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="rest.length && subtreeEvents.length" />
            <DropdownMenuItem
              v-for="type in subtreeEvents"
              :key="`sub-${type}`"
              @select="emit('event', { itemId: item.id, type, subtree: true })"
            >
              {{ t(SUBTREE_EVENT_LABEL[type]) }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
