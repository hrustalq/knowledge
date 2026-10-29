import type { Component } from 'vue'
import { BookOpen, FileText, Figma, GitBranch, Github, Gitlab, HardDrive, LifeBuoy, ListChecks, MessagesSquare, Server } from 'lucide-vue-next'
import { connectionMethodsFor, type ConnectionMethod, type ConnectionProvider } from '@knowledge/contracts'

/**
 * What the connect flow shows for each provider (#564). The label is a product
 * name and is not translated — except plain `git`, which is a description and
 * lives in the catalogue (`connectors.connections.providers.git`).
 */
export interface ProviderMeta {
  provider: ConnectionProvider
  label: string | null
  icon: Component
  group: 'code' | 'docs' | 'support' | 'design'
  /** How the site is asked for: a typed origin, a region, or not at all. */
  site: { kind: 'url'; placeholder: string; optional?: boolean } | { kind: 'region' } | null
}

export const PROVIDERS: readonly ProviderMeta[] = [
  { provider: 'github', label: 'GitHub', icon: Github, group: 'code', site: null },
  { provider: 'gitlab', label: 'GitLab', icon: Gitlab, group: 'code', site: { kind: 'url', placeholder: 'https://gitlab.com', optional: true } },
  { provider: 'git', label: null, icon: GitBranch, group: 'code', site: { kind: 'url', placeholder: 'https://git.example.com' } },
  { provider: 'atlassian', label: 'Atlassian', icon: BookOpen, group: 'docs', site: { kind: 'url', placeholder: 'https://your-team.atlassian.net' } },
  { provider: 'confluence-server', label: 'Confluence Server', icon: Server, group: 'docs', site: { kind: 'url', placeholder: 'https://confluence.example.com' } },
  { provider: 'notion', label: 'Notion', icon: FileText, group: 'docs', site: null },
  { provider: 'google', label: 'Google Drive', icon: HardDrive, group: 'docs', site: null },
  { provider: 'zendesk', label: 'Zendesk', icon: LifeBuoy, group: 'support', site: { kind: 'url', placeholder: 'https://your-team.zendesk.com' } },
  { provider: 'intercom', label: 'Intercom', icon: MessagesSquare, group: 'support', site: { kind: 'region' } },
  { provider: 'linear', label: 'Linear', icon: ListChecks, group: 'support', site: null },
  { provider: 'figma', label: 'Figma', icon: Figma, group: 'design', site: null },
]

export const PROVIDER_GROUPS = ['code', 'docs', 'support', 'design'] as const

export function providerMeta(provider: ConnectionProvider): ProviderMeta {
  return PROVIDERS.find((p) => p.provider === provider) ?? PROVIDERS[0]
}

/**
 * How the connect flow offers to sign in: the provider's methods this server
 * can finish (`app` / `oauth` need their keys), and never a pasted token once
 * the person signed in through one of those — the token is the fallback, not
 * a second way in for someone already connected.
 */
export function offeredMethods(
  provider: ConnectionProvider,
  server: { app: boolean; oauth: boolean },
  signedIn: boolean,
): ConnectionMethod[] {
  const live = connectionMethodsFor(provider).filter((m) => m === 'token' || (m === 'app' ? server.app : server.oauth))
  return signedIn && live.some((m) => m !== 'token') ? live.filter((m) => m !== 'token') : live
}

/** Intercom's region, as the API host its tokens belong to — `connectionProviderFor`'s spelling. */
export const INTERCOM_REGIONS = { us: 'https://api.intercom.io', eu: 'https://api.eu.intercom.io', au: 'https://api.au.intercom.io' } as const
