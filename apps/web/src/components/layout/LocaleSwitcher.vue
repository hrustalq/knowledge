<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Languages } from 'lucide-vue-next'
import { SUPPORTED_LOCALES, type Locale } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getLocale, setLocale } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

/** Endonyms: a language is named in itself, never translated (docs/features/18). */
const LABELS: Record<Locale, string> = { en: 'English', ru: 'Русский' }

const { t, locale } = useI18n()
const auth = useAuthStore()
const active = computed(() => (locale.value as Locale) ?? getLocale())

async function choose(next: Locale) {
  if (next === active.value) return
  setLocale(next)
  locale.value = next
  document.documentElement.lang = next
  // Durable copy, so the choice follows the user to another browser. The cookie
  // alone would not; a failure here is not worth interrupting the switch for.
  await auth.saveLocale(next)
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon-sm" :aria-label="t('nav.language')" :title="t('nav.language')">
        <Languages class="size-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="min-w-36">
      <DropdownMenuItem
        v-for="code in SUPPORTED_LOCALES"
        :key="code"
        :class="code === active ? 'font-medium' : ''"
        @select="choose(code)"
      >
        {{ LABELS[code] }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
