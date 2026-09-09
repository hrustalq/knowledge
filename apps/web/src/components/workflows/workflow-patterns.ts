import type { WorkflowGraph } from '@knowledge/contracts'
import { FileStack, Layers, PenLine, Sparkles } from 'lucide-vue-next'
import type { Component } from 'vue'

/**
 * Shapes a chain comes in.
 *
 * A blank canvas is an honest option and a terrible default: the four step
 * kinds are learnable, but *how they go together* is not, and the old flow
 * taught it by dropping one seeded `ai.generate` step into an empty editor and
 * leaving. These are the arrangements the feature was designed around, written
 * out so an operator can start from one and edit rather than derive it.
 *
 * They are plain data built through `t()`, so the titles and the prompts arrive
 * in the operator's own language — a step called "Use cases" whose prompt is in
 * English is a chain that will produce English pages in a Russian workspace.
 *
 * Blank is last. It is the escape hatch, not the front door.
 */
export interface WorkflowPattern {
  key: string
  icon: Component
  name: string
  summary: string
  graph: WorkflowGraph
}

type T = (key: string, named?: Record<string, unknown>) => string

export function workflowPatterns(t: T): WorkflowPattern[] {
  const p = (key: string) => t(`workflow.pattern.${key}`)

  return [
    {
      key: 'breakdown',
      icon: Layers,
      name: p('breakdown.name'),
      summary: p('breakdown.summary'),
      graph: {
        steps: [
          {
            id: 'items',
            kind: 'ai.generate',
            title: p('breakdown.itemsTitle'),
            next: ['write'],
            fanOut: true,
            autoApprove: false,
            maxItems: 8,
            prompt: { user: p('breakdown.itemsPrompt') },
            produces: { category: 'use-case', relationToParent: 'IMPLEMENTS', nestUnderParent: true },
          },
          {
            id: 'write',
            kind: 'ai.draft',
            title: p('breakdown.writeTitle'),
            next: [],
            fanOut: false,
            autoApprove: false,
            prompt: { user: p('breakdown.writePrompt') },
            produces: { category: 'use-case', relationToParent: 'IMPLEMENTS', nestUnderParent: true },
          },
        ],
      },
    },
    {
      key: 'twoLevel',
      icon: FileStack,
      name: p('twoLevel.name'),
      summary: p('twoLevel.summary'),
      graph: {
        steps: [
          {
            id: 'use-cases',
            kind: 'ai.generate',
            title: p('twoLevel.useCasesTitle'),
            next: ['endpoints', 'screens'],
            fanOut: true,
            autoApprove: false,
            maxItems: 8,
            prompt: { user: p('twoLevel.useCasesPrompt') },
            produces: { category: 'use-case', relationToParent: 'IMPLEMENTS', nestUnderParent: true },
          },
          {
            id: 'endpoints',
            kind: 'ai.draft',
            title: p('twoLevel.endpointsTitle'),
            next: [],
            fanOut: false,
            autoApprove: false,
            prompt: { user: p('twoLevel.endpointsPrompt') },
            produces: { category: 'contract', relationToParent: 'IMPLEMENTS', nestUnderParent: true },
          },
          {
            id: 'screens',
            kind: 'ai.draft',
            title: p('twoLevel.screensTitle'),
            next: [],
            fanOut: false,
            autoApprove: false,
            prompt: { user: p('twoLevel.screensPrompt') },
            produces: { category: 'reference', relationToParent: 'IMPLEMENTS', nestUnderParent: true },
          },
        ],
      },
    },
    {
      key: 'research',
      icon: PenLine,
      name: p('research.name'),
      summary: p('research.summary'),
      graph: {
        steps: [
          {
            id: 'gather',
            kind: 'search',
            title: p('research.gatherTitle'),
            next: ['draft'],
            fanOut: false,
            autoApprove: false,
            filters: { limit: 12 },
          },
          {
            id: 'draft',
            kind: 'ai.draft',
            title: p('research.draftTitle'),
            next: ['check'],
            fanOut: false,
            autoApprove: false,
            prompt: { user: p('research.draftPrompt') },
            produces: { category: 'guide', relationToParent: 'RELATED_TO', nestUnderParent: true },
          },
          {
            id: 'check',
            kind: 'review',
            title: p('research.checkTitle'),
            next: [],
            fanOut: false,
            autoApprove: false,
          },
        ],
      },
    },
    {
      key: 'blank',
      icon: Sparkles,
      name: p('blank.name'),
      summary: p('blank.summary'),
      graph: {
        // Not literally empty: the compiler rejects a graph with no steps, so a
        // "blank" start that saved nothing would present its first error before
        // the operator had done anything wrong.
        steps: [
          {
            id: 'first-step',
            kind: 'ai.generate',
            title: p('blank.firstTitle'),
            next: [],
            fanOut: true,
            autoApprove: false,
            maxItems: 8,
            prompt: { user: '' },
            produces: { category: 'use-case', relationToParent: 'IMPLEMENTS', nestUnderParent: true },
          },
        ],
      },
    },
  ]
}
