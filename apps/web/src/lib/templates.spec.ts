import { describe, expect, it } from 'vitest'
import type { TemplateMeta, TemplateSummary } from '@knowledge/contracts'
import { composeTemplateSource, type TemplateDetail } from '@knowledge/contracts'
import { htmlToMarkdown } from '@/lib/markdown/serialize'
import {
  canWriteTemplate,
  groupTemplates,
  matchesTemplate,
  offeredTemplates,
  previewTemplate,
  templateSourceFields,
  unescapePlaceholders,
} from './templates'

const summary = (overrides: Partial<TemplateSummary>): TemplateSummary => ({
  ref: 'builtin:adr',
  id: null,
  builtInKey: 'adr',
  scope: 'built-in',
  workspaceId: 'ws',
  projectId: null,
  name: 'Architecture decision record',
  description: 'Record one decision and its consequences.',
  icon: null,
  category: 'architecture',
  currentVersion: 1,
  enabled: true,
  customized: false,
  archivedAt: null,
  updatedAt: null,
  ...overrides,
})

describe('offeredTemplates', () => {
  it('leaves out archived templates and hidden built-ins — they still resolve, but nothing starts from them', () => {
    const list = [
      summary({ ref: 'builtin:adr' }),
      summary({ ref: 'builtin:rfc', builtInKey: 'rfc', enabled: false }),
      summary({ ref: 'a', scope: 'project', builtInKey: null, archivedAt: '2026-10-01T00:00:00Z' }),
    ]
    expect(offeredTemplates(list).map((t) => t.ref)).toEqual(['builtin:adr'])
  })
})

describe('matchesTemplate', () => {
  const adr = summary({ name: 'Запись архитектурного решения', description: null })

  it('finds a built-in by its key in any language', () => {
    expect(matchesTemplate(adr, 'adr')).toBe(true)
  })

  it('matches every word against name, description and category label', () => {
    expect(matchesTemplate(adr, 'архитектурного архитектура', 'Архитектура')).toBe(true)
    expect(matchesTemplate(adr, 'runbook')).toBe(false)
  })

  it('an empty query matches everything', () => {
    expect(matchesTemplate(adr, '  ')).toBe(true)
  })
})

describe('groupTemplates', () => {
  it('orders project, workspace, built-in and drops empty groups', () => {
    const groups = groupTemplates([
      summary({ ref: 'builtin:adr' }),
      summary({ ref: 'p', scope: 'project', builtInKey: null }),
    ])
    expect(groups.map((g) => g.scope)).toEqual(['project', 'built-in'])
  })
})

describe('previewTemplate', () => {
  const meta: TemplateMeta = {
    category: 'architecture',
    titlePattern: 'ADR-{{number}}: {{title}}',
    placeholders: [
      { name: 'number', kind: 'text', required: true },
      { name: 'owner', kind: 'user' },
      { name: 'decided', kind: 'date' },
    ],
  }
  const body = '# {{title}}\n\nOwner: {{owner}} · {{decided}} · by {{author}}\n\nKeep `{{handlebars}}` and \\{{number}}.'
  const OWNER = '5f0c2b0e-8d4a-4c1e-9a7b-3e2d1c0b9a87'

  it('fills system and declared placeholders, leaving undeclared and escaped ones literal', () => {
    const preview = previewTemplate(
      { body, meta },
      { number: '7', owner: OWNER, decided: '2026-10-12' },
      { locale: 'en', title: 'Use Postgres', author: 'Ada', labels: { [OWNER]: 'Grace' } },
    )
    expect(preview.title).toBe('ADR-7: Use Postgres')
    expect(preview.body).toBe(
      `# Use Postgres\n\nOwner: <span data-kn-user="${OWNER}">@Grace</span> · 12 Oct 2026 · by Ada\n\n` +
        'Keep `{{handlebars}}` and {{number}}.',
    )
    expect(preview.missing).toEqual([])
  })

  it('reports required values still blank, which is what keeps Create from rendering', () => {
    expect(previewTemplate({ body, meta }, {}, { locale: 'en', title: '' }).missing).toEqual(['number'])
  })

  it('dates follow the locale, the way the server renders them', () => {
    const preview = previewTemplate({ body: '{{decided}}', meta }, { decided: '2026-10-12' }, { locale: 'ru', title: '' })
    expect(preview.body).toMatch(/^12 окт\.? 2026/)
  })
})

describe('settings role gating', () => {
  it('lets an editor write project templates only, and an admin everything', () => {
    expect(canWriteTemplate('project', 'editor')).toBe(true)
    expect(canWriteTemplate('workspace', 'editor')).toBe(false)
    expect(canWriteTemplate('built-in', 'editor')).toBe(false)
    for (const scope of ['project', 'workspace', 'built-in'] as const) {
      expect(canWriteTemplate(scope, 'admin')).toBe(true)
      expect(canWriteTemplate(scope, 'viewer')).toBe(false)
      expect(canWriteTemplate(scope, null)).toBe(false)
    }
  })
})

describe('a template body written in the rich editor', () => {
  it('is escaped by the serializer, which is why the unescape exists', () => {
    const written = htmlToMarkdown('<p>Due {{due_date}}</p>')
    expect(written).not.toContain('{{due_date}}')
    expect(unescapePlaceholders(written)).toContain('{{due_date}}')
  })

  it('keeps its placeholders after the editor escapes underscores', () => {
    expect(unescapePlaceholders('Due {{due\\_date}} for {{ owner\\_id }}; snake\\_case prose stays')).toBe(
      'Due {{due_date}} for {{ owner_id }}; snake\\_case prose stays',
    )
  })

  it('leaves an escaped placeholder escaped', () => {
    expect(unescapePlaceholders('\\\\{{literal\\_one}}')).toBe('\\\\{{literal_one}}')
  })

  it('round-trips through the fields an editor holds', () => {
    const detail = {
      meta: { category: 'guide', placeholders: [{ name: 'service', kind: 'entity' }] },
      tags: ['runbook'],
      relations: [{ type: 'DESCRIBES', target: 'service:{{service}}' }],
      frontmatter: { tags: ['runbook'], glossary: false },
      body: '# {{title}}\n',
    } as unknown as TemplateDetail
    const fields = templateSourceFields(detail)
    fields.meta.placeholders[0].required = true
    expect(detail.meta.placeholders[0].required).toBeUndefined()
    expect(composeTemplateSource(fields)).toBe(
      [
        '---',
        '"glossary": false',
        'tags: ["runbook"]',
        'relations:',
        '  - type: "DESCRIBES"',
        '    target: "service:{{service}}"',
        'template:',
        '  category: "guide"',
        '  placeholders:',
        '    - {"name":"service","kind":"entity","required":true}',
        '---',
        '# {{title}}\n',
      ].join('\n'),
    )
  })
})

