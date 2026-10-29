<script setup lang="ts">
// The Chat tab of /search (#339): searchable groups' masked messages, through
// the same SearchPanel as page search so the two cannot drift apart. No filter
// rail: what a person may read is already one ACL decision on the server.
import { useI18n } from 'vue-i18n'
import { onMounted } from 'vue'
import { chatSearchSource } from '../model/chat-search-source'
import { SearchPanel } from '@/entities/search'
import { useSearch } from '@/entities/search'

const { t } = useI18n()

const props = defineProps<{ initialQuery?: string }>()

const search = useSearch(chatSearchSource(t), { query: props.initialQuery ?? '' })

onMounted(() => {
  if (search.query.value.trim()) void search.run()
})
</script>

<template>
  <SearchPanel
    :search="search"
    :placeholder="t('search.chat.placeholder')"
    :copy="{
      idle: t('search.chat.idle'),
      idleHint: t('search.chat.idleHint'),
      none: t('search.chat.none'),
      noneHint: t('search.chat.noneHint'),
    }"
  />
</template>
