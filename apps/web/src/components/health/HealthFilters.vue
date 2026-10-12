<script setup lang="ts">
/**
 * The narrowing row under the preset strip (docs/features/40): a title
 * search, an owner, and the sort.
 *
 * Every narrowing goes to the server — the list is cursor-paged, so filtering
 * the rows in hand would disagree with the counts on the strip and with
 * "Load more". The search is debounced for the same reason the merge-request
 * bar's is: each keystroke would otherwise be a request.
 *
 * The owner select offers the roster, not an "unowned" row: unowned is a
 * preset on the strip, with a count, and the API's `ownerId` takes a member.
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { Search } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMembers } from '@/components/merge-requests/use-members'
import { HEALTH_SORTS, type HealthSort } from './health-ui'

const props = defineProps<{
  q: string
  ownerId: string | null
  sort: HealthSort
}>()
const emit = defineEmits<{
  'update:q': [value: string]
  'update:ownerId': [value: string | null]
  'update:sort': [value: HealthSort]
}>()

const { t } = useI18n()
const { members } = useMembers()

/** The sentinel for "anyone": a select cannot carry an empty string as a value. */
const ANY = 'any'

const draft = ref(props.q)
watch(
  () => props.q,
  (q) => {
    if (q !== draft.value) draft.value = q
  },
)
const push = useDebounceFn((value: string) => emit('update:q', value.trim()), 300)
watch(draft, (value) => void push(value))

function setOwner(value: unknown) {
  if (typeof value !== 'string') return
  emit('update:ownerId', value === ANY ? null : value)
}
function setSort(value: unknown) {
  if (typeof value === 'string' && (HEALTH_SORTS as readonly string[]).includes(value)) emit('update:sort', value as HealthSort)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <label class="relative min-w-0 flex-1 basis-56">
      <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        v-model="draft"
        type="search"
        class="h-9 pl-8"
        :placeholder="t('health.search')"
        :aria-label="t('health.search')"
      />
    </label>

    <Select :model-value="ownerId ?? ANY" @update:model-value="setOwner">
      <SelectTrigger class="h-9 w-44" :aria-label="t('health.owner.label')">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem :value="ANY">{{ t('health.owner.any') }}</SelectItem>
        <SelectItem v-for="m in members" :key="m.userId" :value="m.userId">{{ m.displayName }}</SelectItem>
      </SelectContent>
    </Select>

    <Select :model-value="sort" @update:model-value="setSort">
      <SelectTrigger class="h-9 w-56" :aria-label="t('health.sort.label')">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="s in HEALTH_SORTS" :key="s" :value="s">{{ t(`health.sort.${s}`) }}</SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>
