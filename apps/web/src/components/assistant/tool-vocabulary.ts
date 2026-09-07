// One place that decides how a tool call looks and reads, so the live trail
// and the finished transcript can never label the same call differently.
import {
  FilePlus2, FileText, LayoutTemplate, MessageCircleQuestion, Network, Search, SquarePen, Wand2, Wrench,
} from 'lucide-vue-next'
import type { Component } from 'vue'

interface ToolVocabulary {
  icon: Component
  /** Present continuous, for a call that is running right now. */
  running: string
  /** Past tense, for a call in the finished record. */
  done: string
}

const TOOLS: Record<string, ToolVocabulary> = {
  search_knowledge: { icon: Search, running: 'Searching the workspace', done: 'Searched the workspace' },
  read_document: { icon: FileText, running: 'Reading a page', done: 'Read a page' },
  explore_document_graph: { icon: Network, running: 'Following the graph', done: 'Followed the graph' },
  render_component: { icon: LayoutTemplate, running: 'Building a view', done: 'Built a view' },
  create_document: { icon: FilePlus2, running: 'Creating a page', done: 'Created a page' },
  propose_update: { icon: SquarePen, running: 'Drafting a merge request', done: 'Drafted a merge request' },
  ask_user: { icon: MessageCircleQuestion, running: 'Asking you', done: 'Asked you' },
  request_agent_mode: { icon: Wand2, running: 'Requesting Agent mode', done: 'Requested Agent mode' },
}

/** Falls back to the raw tool name so a tool added on the API stays legible here. */
export function toolVocabulary(tool: string): ToolVocabulary {
  const known = TOOLS[tool]
  if (known) return known
  const spoken = tool.replace(/_/g, ' ')
  return { icon: Wrench, running: spoken, done: spoken }
}
