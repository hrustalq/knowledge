/**
 * The documentation, rendered for a machine instead of a reader.
 *
 * Two shapes, both plain markdown on the clipboard:
 *
 *   buildSkill()  — a SKILL.md an agent loads when it works on this system:
 *                   frontmatter it can trigger on, then the parts it needs in
 *                   the order it needs them (orientation → write path → API →
 *                   MCP → the traps).
 *   buildBundle() — every article, whole, for when the agent should read it all.
 *
 * The generated tables are flattened here too: a reference that exists only as
 * a Vue table is a reference an agent cannot read.
 */
import { articles, type DocArticle } from './registry'
import reference from './reference.generated.json'

interface Endpoint {
  method: string
  path: string
  tag: string
  summary: string
  role: string | null
  source: string | null
  public: boolean
  platformAdmin: boolean
}

interface McpTool {
  name: string
  description: string
  inputs: { name: string; optional: boolean }[]
}

export const endpoints = reference.endpoints as Endpoint[]
export const mcpTools = reference.mcpTools as McpTool[]

/** Who may call an endpoint, as one word, matching the table in the UI. */
export function accessLabel(endpoint: Endpoint): string {
  if (endpoint.public) return 'public'
  if (endpoint.platformAdmin) return 'platform admin'
  if (endpoint.role) return endpoint.source ? `${endpoint.role} (${endpoint.source})` : endpoint.role
  return 'authenticated'
}

export function endpointsMarkdown(): string {
  const byTag = new Map<string, Endpoint[]>()
  for (const endpoint of endpoints) {
    const list = byTag.get(endpoint.tag) ?? []
    list.push(endpoint)
    byTag.set(endpoint.tag, list)
  }

  const out: string[] = []
  for (const [tag, list] of byTag) {
    out.push(`### ${tag}`, '', '| Method | Path | Access | Summary |', '| --- | --- | --- | --- |')
    for (const endpoint of list) {
      out.push(
        `| ${endpoint.method} | \`${endpoint.path}\` | ${accessLabel(endpoint)} | ${endpoint.summary.replace(/\|/g, '\\|')} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

export function mcpToolsMarkdown(): string {
  const out: string[] = ['| Tool | Inputs | Description |', '| --- | --- | --- |']
  for (const tool of mcpTools) {
    const inputs = tool.inputs.map((i) => (i.optional ? `${i.name}?` : i.name)).join(', ') || '—'
    out.push(`| \`${tool.name}\` | ${inputs} | ${tool.description.replace(/\|/g, '\\|')} |`)
  }
  return out.join('\n')
}

/** An article as markdown, with its generated table appended where it has one. */
export function articleMarkdown(article: DocArticle): string {
  const table =
    article.widget === 'api-reference'
      ? `\n\n${endpointsMarkdown()}`
      : article.widget === 'mcp-tools'
        ? `\n\n${mcpToolsMarkdown()}`
        : ''
  return `${article.body.trim()}${table}`
}

export function buildBundle(): string {
  const head = [
    '# Knowledge platform — documentation',
    '',
    'Every page of the in-app documentation, concatenated. Generated from the',
    'running build, so the API and MCP tables below match this deployment.',
    '',
    '---',
    '',
  ].join('\n')

  return (
    head +
    articles
      .filter((article) => article.widget !== 'agent-skill')
      .map((article) => `## ${article.title}\n\n_${article.summary}_\n\n${articleMarkdown(article)}`)
      .join('\n\n---\n\n') +
    '\n'
  )
}

/**
 * The skill.
 *
 * Deliberately not the full bundle with a header bolted on: a skill is read
 * *before* the agent knows what it needs, so it leads with orientation and the
 * two things it will get wrong unguided — where writes go, and which of the 174
 * endpoints it is allowed to call. The long-form articles stay one copy away.
 */
export function buildSkill(): string {
  const pick = (slug: string): string => {
    const article = articles.find((a) => a.slug === slug)
    return article ? articleMarkdown(article) : ''
  }

  return `---
name: knowledge-platform
description: Use when working on the Knowledge platform — its REST API (/v1/*), its MCP server (knowledge_* tools), or the monorepo itself (apps/api NestJS + worker, apps/web Vue SSR, Postgres + MinIO + ArcadeDB). Covers documents, revisions and branches, the ingestion pipeline, search, merge requests, workflows, connectors and agents.
---

# Knowledge platform

${pick('overview')}

## The write path

${pick('ingestion')}

## REST API

Base URL \`/v1\`. Auth is a bearer token — \`ks_…\` (session) or \`kn_…\` (API key) —
unless \`AUTH_MODE=none\`, where every request passes as a full-access dev principal.
Errors are always the same envelope: \`{ statusCode, code, message, details?, path,
timestamp, requestId }\`; branch on \`code\`, never on the message.

${endpointsMarkdown()}

## MCP server

Stdio transport, started with \`make dev-mcp\`. ${mcpTools.length} tools, all prefixed
\`knowledge_\`. Tools that take a \`workspaceId\` require it — there is no ambient
workspace on stdio.

${mcpToolsMarkdown()}

## Traps

${pick('architecture-notes')}
`
}
