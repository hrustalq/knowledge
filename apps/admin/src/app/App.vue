<script setup lang="ts">
// Root: the shell around the routed page, or the page alone for a `focus`
// route (the gate). Provides what @knowledge/ui's chrome asks of an app.
import { provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute } from 'vue-router'
import { Toaster } from '@knowledge/ui/sonner'
import { ConfirmDialog } from '@knowledge/ui/confirm'
import { ERROR_TEXT } from '@knowledge/ui/layout'
import { errorMessage } from '@/shared/api/errors'
import AppSidebar from './shell/AppSidebar.vue'

const { t } = useI18n()
const route = useRoute()

// PageState shows a thrown error through this, never its raw message.
provide(ERROR_TEXT, (error) => errorMessage(error, t))
</script>

<template>
  <RouterView v-if="route.meta.focus" />
  <div v-else class="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
    <AppSidebar />
    <main class="min-w-0 px-4 py-6 lg:px-8">
      <RouterView />
    </main>
  </div>
  <Toaster />
  <ConfirmDialog />
</template>
