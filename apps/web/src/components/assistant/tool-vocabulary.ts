// One place that decides how a tool call looks and reads, so the live trail
// and the finished transcript can never label the same call differently.
import {
  FileCode2, FilePlus2, FileText, FolderTree, Globe, LayoutTemplate, Link, ListTree, MessageCircleQuestion, Network,
  Search, SearchCode, SquarePen, Wand2, Wrench,
} from 'lucide-vue-next'
import type { Component } from 'vue'

interface ToolVocabulary {
  icon: Component
  /** Message key: present continuous, for a call running right now. */
  running: string
  /** Message key: past tense, for a call in the finished record. */
  done: string
}

const TOOLS: Record<string, ToolVocabulary> = {
  search_knowledge: { icon: Search, running: 'tool.search_knowledge.running', done: 'tool.search_knowledge.done' },
  read_document: { icon: FileText, running: 'tool.read_document.running', done: 'tool.read_document.done' },
  explore_document_graph: { icon: Network, running: 'tool.explore_document_graph.running', done: 'tool.explore_document_graph.done' },
  // docs/features/08. Distinct from explore_document_graph on purpose: one
  // followed what pages mean to each other, this one only looked at where they
  // sit, and a reader deciding how much to trust an answer wants to know which.
  list_document_tree: { icon: FolderTree, running: 'tool.list_document_tree.running', done: 'tool.list_document_tree.done' },
  render_component: { icon: LayoutTemplate, running: 'tool.render_component.running', done: 'tool.render_component.done' },
  create_document: { icon: FilePlus2, running: 'tool.create_document.running', done: 'tool.create_document.done' },
  propose_update: { icon: SquarePen, running: 'tool.propose_update.running', done: 'tool.propose_update.done' },
  ask_user: { icon: MessageCircleQuestion, running: 'tool.ask_user.running', done: 'tool.ask_user.done' },
  request_agent_mode: { icon: Wand2, running: 'tool.request_agent_mode.running', done: 'tool.request_agent_mode.done' },
  // docs/features/25. Two verbs, not one: "searched the web" and "read a page"
  // are different amounts of trust to have spent, and the trail is the only
  // place a reader sees which happened.
  web_search: { icon: Globe, running: 'tool.web_search.running', done: 'tool.web_search.done' },
  web_fetch: { icon: Link, running: 'tool.web_fetch.running', done: 'tool.web_fetch.done' },
  // docs/features/31. Four verbs again, for the same reason: listing a tree,
  // searching, reading an outline and reading a file are different amounts of
  // a repository looked at, and the trail is where a reader sees which.
  code_tree: { icon: FolderTree, running: 'tool.code_tree.running', done: 'tool.code_tree.done' },
  code_search: { icon: SearchCode, running: 'tool.code_search.running', done: 'tool.code_search.done' },
  code_outline: { icon: ListTree, running: 'tool.code_outline.running', done: 'tool.code_outline.done' },
  code_read: { icon: FileCode2, running: 'tool.code_read.running', done: 'tool.code_read.done' },
}

/**
 * `running`/`done` are message keys — resolve them with t() at the call site
 * (docs/features/18). A tool added on the API and not yet in this map falls
 * back to its own spoken name, which t() passes through unchanged.
 */
export function toolVocabulary(tool: string): ToolVocabulary {
  const known = TOOLS[tool]
  if (known) return known
  const spoken = tool.replace(/_/g, ' ')
  return { icon: Wrench, running: spoken, done: spoken }
}
