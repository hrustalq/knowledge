<script setup lang="ts">
/**
 * The wizard's skill step (#1225): the skill in the format picked under
 * Preferences, the capture hook when it was asked for, and the ticket step a
 * developer's agent follows. Fetched as the key just minted when there is one,
 * because the SKILL.md describes the credential that reads it.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Download, KeyRound } from 'lucide-vue-next'
import type { ApiKeyScope } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { api } from '@/shared/api/queries'
import { saveFile } from '@/shared/api/api'
import {
  CopyBlock,
  SKILL_NAME,
  captureKitInstallCommand,
  skillInstallCommand,
  skillStackInstallCommand,
  type McpClientGuide,
} from '@/entities/access'

const props = defineProps<{
  url: string
  client: McpClientGuide
  needsKey: boolean
  apiKey: string | null
  keyScope: ApiKeyScope | null
  format: 'single' | 'stack'
  kit: boolean
  ticket: boolean
}>()
const { t } = useI18n()

const skill = ref<string | null>(null)
watch(
  () => props.apiKey,
  async (asKey) => {
    try {
      // Not the query cache: its key carries no credential, so a read as the new key would collide.
      skill.value = (await api.get('/v1/mcp/skill', {
        config: { responseType: 'text', ...(asKey ? { headers: { Authorization: `Bearer ${asKey}` } } : {}) },
      })) as unknown as string
    } catch {
      skill.value = null
    }
  },
  { immediate: true },
)

const dir = computed(() => props.client.skillDir)
const stack = computed(() => (dir.value && props.format === 'stack' ? skillStackInstallCommand(props.url, dir.value, props.needsKey) : null))
const ticketStep = computed(
  () => /^### Starting a ticket\n[\s\S]*?(?=\n#{2,3} |$(?![\s\S]))/m.exec(skill.value ?? '')?.[0].trim() ?? null,
)

function download() {
  if (skill.value) saveFile(new Blob([skill.value], { type: 'text/markdown' }), 'SKILL.md')
}
</script>

<template>
  <div class="grid min-w-0 gap-4">
    <p class="kn-measure text-xs leading-relaxed text-muted-foreground">{{ t('connect.skill.hint') }}</p>

    <template v-if="dir">
      <CopyBlock v-if="stack" :code="stack" :label="t('connect.skill.stackFor', { client: client.name, path: dir })" />
      <CopyBlock
        v-else
        :code="skillInstallCommand(`${url}/skill`, dir, needsKey)"
        :label="t('connect.skill.installFor', { client: client.name, path: `${dir}/${SKILL_NAME}/SKILL.md` })"
      />
      <p v-if="stack" class="kn-measure text-caption text-muted-foreground">{{ t('connect.skill.stackHint') }}</p>
    </template>
    <template v-else>
      <p class="kn-measure text-xs text-muted-foreground">{{ t('connect.skill.noSkillDir', { client: client.name }) }}</p>
      <div>
        <Button variant="outline" size="sm" class="gap-1.5" :disabled="!skill" @click="download">
          <Download class="size-3.5" />{{ t('connect.skill.download') }}
        </Button>
      </div>
    </template>
    <p class="kn-measure text-caption text-muted-foreground">{{ t('connect.skill.alsoServed') }}</p>

    <section v-if="kit && client.captureKit" class="grid min-w-0 gap-2 border-t pt-4">
      <h3 class="text-sm font-medium">{{ t('connect.capture.title') }}</h3>
      <p v-if="keyScope === 'read'" class="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
        <KeyRound class="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
        <span>{{ t('connect.capture.refused') }}</span>
      </p>
      <template v-else>
        <p class="kn-measure text-xs leading-relaxed text-muted-foreground">{{ t('connect.capture.hint', { client: client.name }) }}</p>
        <CopyBlock :code="captureKitInstallCommand(`${url}/capture-kit`, client.captureKit, needsKey)" :label="t('connect.wizard.skill.kitTitle')" />
        <p class="text-caption text-muted-foreground">
          <RouterLink to="/captures" class="text-primary underline underline-offset-2">{{ t('connect.capture.review') }}</RouterLink>
        </p>
      </template>
    </section>

    <section v-if="ticket && ticketStep" class="grid min-w-0 gap-2 border-t pt-4">
      <h3 class="text-sm font-medium">{{ t('connect.capture.ticket.title') }}</h3>
      <p class="kn-measure text-xs leading-relaxed text-muted-foreground">
        {{ t('connect.capture.ticket.hint', { client: client.name }) }}
        <template v-if="client.captureKit === 'cursor'">{{ t('connect.capture.ticket.cursor') }}</template>
      </p>
      <CopyBlock :code="ticketStep" :label="t('connect.capture.ticket.label')" />
    </section>
  </div>
</template>
