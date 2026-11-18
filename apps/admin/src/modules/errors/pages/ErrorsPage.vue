<script setup lang="ts">
// Filled by #1240; until then the head says what the section will hold.
import { useI18n } from 'vue-i18n'
import { Construction } from 'lucide-vue-next'
import { PageLayout, PageState } from '@knowledge/ui/layout'

const { t } = useI18n()
</script>

<template>
  <PageLayout :title="t('admin.nav.errors')" :subtitle="t('admin.sections.errors')">
    <PageState state="empty" :icon="Construction" :title="t('admin.notBuilt.title')" :description="t('admin.notBuilt.description')" />
  </PageLayout>
</template>
