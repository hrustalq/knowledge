<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Button } from '@knowledge/ui/button'

const { t } = useI18n()
</script>

<template>
  <div class="mx-auto mt-24 max-w-md text-center">
    <p class="text-6xl font-bold text-muted-foreground">404</p>
    <h1 class="mt-3 text-xl font-semibold">{{ t('auth.notFoundTitle') }}</h1>
    <p class="mt-2 text-sm text-muted-foreground">
      {{ t('auth.notFoundBody') }}
    </p>
    <Button class="mt-6" as-child>
      <RouterLink to="/documents">{{ t('auth.backToDocuments') }}</RouterLink>
    </Button>
  </div>
</template>
