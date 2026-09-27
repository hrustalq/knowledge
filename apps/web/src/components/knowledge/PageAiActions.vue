<script setup lang="ts">
/**
 * The page's AI actions menu (issue #68): hand this page to an AI tool.
 *
 * A split button. The primary half copies the page as Markdown, which is the
 * one action every reader wants and never leaves the reader's machine. The ⌄
 * opens the rest: view the raw `.md`, open the page in ChatGPT / Claude /
 * Cursor, copy an MCP install config, and copy an agent link.
 *
 * What the menu offers comes from `GET /v1/ai/page-actions`, the same
 * resolved setting the admin page shows, so the "Open in…" entries disappear
 * when the workspace (or the deployment ceiling) switches them off. That gating
 * happens on offer only: opening a vendor URL is a client-side navigation the
 * server cannot see. The docs say so, and the env ceiling is the hard control.
 *
 * SSR: nothing here touches `window` or the clipboard at setup. The page
 * markdown is fetched and every URL is built on click.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Bot, Check, ChevronDown, Copy, ExternalLink, FileText, KeyRound, Link2, Plug } from 'lucide-vue-next'
import type { AiActionId } from '@knowledge/contracts/content'
import type { AiPageActionsResponse, McpConnectionInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { apiFetch, apiFetchText, getWorkspaceId } from '@/lib/api'
import { useCopy } from '@/lib/use-copy'
import { mcpClients } from '@/lib/mcp-clients'
import { agentLink, cursorMcpInstallUrl, openInVendor, pageMarkdownUrl, type ExternalVendor } from '@/lib/ai-actions'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const props = defineProps<{
  documentId: string
  title: string
  /** The revision on screen (`?revision=`), so "Copy" copies what the reader is looking at. */
  revisionId?: string | null
}>()

const { t } = useI18n()
const { state: copyState, copy } = useCopy()

const actionsQuery = useQuery(apiQueryOptions('/v1/ai/page-actions', { query: { workspaceId: getWorkspaceId() } }))
const pageActions = computed(() => actionsQuery.data.value as AiPageActionsResponse | undefined)

/**
 * Until the settings answer, offer only what is never gated. A reader on a
 * slow link must not see "Open in ChatGPT" flash and then vanish.
 */
const offered = computed<ReadonlySet<AiActionId>>(
  () => new Set(pageActions.value?.actions ?? ['copy-markdown', 'view-markdown', 'copy-mcp-config', 'copy-agent-link']),
)
const has = (id: AiActionId) => offered.value.has(id)
const anyExternal = computed(() => has('open-chatgpt') || has('open-claude') || has('open-cursor'))

const webBase = () => window.location.origin

async function fetchMarkdown(): Promise<string> {
  const q = props.revisionId ? `?revision=${encodeURIComponent(props.revisionId)}` : ''
  return apiFetchText(`/v1/documents/${props.documentId}/markdown${q}`, { headers: { Accept: 'text/markdown' } })
}

const busy = ref(false)

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) return undefined
  busy.value = true
  try {
    return await fn()
  } catch (e) {
    toast.error((e as Error).message || t('aiActions.failed'))
    return undefined
  } finally {
    busy.value = false
  }
}

async function copyMarkdown() {
  const md = await run(fetchMarkdown)
  if (md === undefined) return
  await copy(md)
  if (copyState.value === 'failed') toast.error(t('aiActions.copyFailed'))
}

function viewMarkdown() {
  // The kn_token cookie authenticates the tab; nothing is put in the URL.
  window.open(pageMarkdownUrl(webBase(), props.documentId), '_blank', 'noopener')
}

async function openIn(vendor: ExternalVendor) {
  // Open the tab synchronously, inside the click, or a popup blocker eats it;
  // it is pointed at the vendor once the page's markdown has arrived.
  const tab = vendor === 'cursor' ? null : window.open('about:blank', '_blank')
  const md = await run(fetchMarkdown)
  if (md === undefined) {
    tab?.close()
    return
  }
  const action = openInVendor(
    vendor,
    { id: props.documentId, title: props.title, markdown: md },
    { webBase: webBase(), maxChars: pageActions.value?.inlineMaxChars ?? 6000 },
  )
  if (action.kind === 'url') {
    if (tab) {
      tab.opener = null
      tab.location.href = action.url
    } else {
      window.location.href = action.url
    }
    return
  }
  tab?.close()
  await copy(action.text)
  if (copyState.value === 'failed') toast.error(t('aiActions.copyFailed'))
  else toast.info(t('aiActions.tooLongCopied'))
}

/* ---------------------------------------------------------- MCP install */

const connection = ref<McpConnectionInfo | null>(null)

async function loadConnection() {
  if (connection.value) return
  connection.value = (await run(() => apiFetch<McpConnectionInfo>('/v1/mcp/connection'))) ?? null
}

/** Never a key: `key: null`, so every snippet carries the KNOWLEDGE_API_KEY placeholder. */
const clients = computed(() =>
  connection.value
    ? mcpClients({
        url: connection.value.url,
        serverName: connection.value.serverName,
        auth: connection.value.authMode === 'api-key',
        key: null,
      })
    : [],
)

async function copyClientConfig(id: string) {
  const c = clients.value.find((x) => x.id === id)
  if (!c) return
  await copy(c.command ?? c.config.code)
  if (copyState.value === 'failed') toast.error(t('aiActions.copyFailed'))
  else toast.success(t('aiActions.copied'))
}

function installInCursor() {
  const c = clients.value.find((x) => x.id === 'cursor')
  if (!c || !connection.value) return
  const name = connection.value.serverName
  const entry = (JSON.parse(c.config.code) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers[name]
  if (entry) window.location.href = cursorMcpInstallUrl(name, entry)
}

async function copyAgentLink() {
  await copy(agentLink(webBase(), props.documentId))
  if (copyState.value === 'failed') toast.error(t('aiActions.copyFailed'))
  else toast.success(t('aiActions.copied'))
}
</script>

<template>
  <div class="inline-flex" role="group" :aria-label="t('aiActions.menu')">
    <Button
      variant="outline"
      size="sm"
      class="rounded-r-none border-r-0"
      :disabled="busy"
      :title="t('aiActions.copyMarkdown')"
      @click="copyMarkdown"
    >
      <Check v-if="copyState === 'copied'" class="size-3.5" />
      <Copy v-else class="size-3.5" />
      {{ copyState === 'copied' ? t('aiActions.copied') : t('aiActions.copyPage') }}
    </Button>
    <DropdownMenu @update:open="(open: boolean) => open && void loadConnection()">
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="sm" class="rounded-l-none px-1.5" :aria-label="t('aiActions.menu')">
          <ChevronDown class="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-64">
        <DropdownMenuItem v-if="has('copy-markdown')" @select="copyMarkdown">
          <Copy class="size-3.5" />
          {{ t('aiActions.copyMarkdown') }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="has('view-markdown')" @select="viewMarkdown">
          <FileText class="size-3.5" />
          {{ t('aiActions.viewMarkdown') }}
        </DropdownMenuItem>

        <template v-if="anyExternal">
          <DropdownMenuSeparator />
          <DropdownMenuItem v-if="has('open-chatgpt')" @select="openIn('chatgpt')">
            <ExternalLink class="size-3.5" />
            {{ t('aiActions.openChatgpt') }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="has('open-claude')" @select="openIn('claude')">
            <ExternalLink class="size-3.5" />
            {{ t('aiActions.openClaude') }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="has('open-cursor')" @select="openIn('cursor')">
            <ExternalLink class="size-3.5" />
            {{ t('aiActions.openCursor') }}
          </DropdownMenuItem>
        </template>

        <DropdownMenuSeparator />
        <DropdownMenuSub v-if="has('copy-mcp-config')">
          <DropdownMenuSubTrigger>
            <Plug class="size-3.5" />
            {{ t('aiActions.copyMcpConfig') }}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="w-52">
            <DropdownMenuItem v-for="c in clients" :key="c.id" @select="copyClientConfig(c.id)">
              {{ c.name }}
            </DropdownMenuItem>
            <DropdownMenuItem v-if="!clients.length" disabled>{{ t('common.loading') }}</DropdownMenuItem>
            <template v-if="clients.some((c) => c.id === 'cursor')">
              <DropdownMenuSeparator />
              <DropdownMenuItem @select="installInCursor">
                <Bot class="size-3.5" />
                {{ t('aiActions.installCursor') }}
              </DropdownMenuItem>
            </template>
            <DropdownMenuSeparator />
            <DropdownMenuItem as-child>
              <RouterLink to="/settings/connect">
                <KeyRound class="size-3.5" />
                {{ t('aiActions.manageKeys') }}
              </RouterLink>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem v-if="has('copy-agent-link')" @select="copyAgentLink">
          <Link2 class="size-3.5" />
          {{ t('aiActions.copyAgentLink') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
