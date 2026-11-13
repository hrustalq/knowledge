/**
 * Memory banks (#986) as this platform's own web routes show them
 * (`/v1/memory/...`, docs/features/80). The Hindsight-shaped routes keep their
 * own wire types in the API and never reach the generated client.
 */

/** The capture origin a promoted memory carries: `platform` is this, `chatTitle` the bank's name. */
export const MEMORY_ORIGIN_PLATFORM = 'memory';

export interface MemoryBankSummary {
  /** The row id, for this platform's routes. */
  id: string;
  /** The client's name for the bank, as it appears in Hindsight paths and the MCP URL. */
  bankId: string;
  name: string;
  /** The project the bank follows the restriction of; null = the whole workspace. */
  projectId: string | null;
  facts: number;
  observations: number;
  /** Entities written through the graph wire (`/mcp/<bank>/graph`, #1008). */
  entities: number;
  /** Files written through the memory tool (`…/memory-tool`, `/mcp/<bank>/files`, #1009). */
  files: number;
  /** When a memory of this bank was last written; null while it holds none. */
  lastWriteAt: string | null;
  createdAt: string;
}

export interface MemoryBankListResponse {
  banks: MemoryBankSummary[];
  /** What a Hindsight client uses as its base URL, and the MCP endpoints hang off: `API_PUBLIC_URL`. */
  apiUrl: string;
  /** Whether consolidation can run in this workspace: a model is routed to the consolidator. */
  consolidation: boolean;
}

export const MEMORY_UNIT_TYPES = ['world', 'experience', 'observation'] as const;
export type MemoryUnitType = (typeof MEMORY_UNIT_TYPES)[number];

/** One memory as the bank page lists it. Agent-written: render as text, never as trusted markup. */
export interface MemoryUnitSummary {
  id: string;
  type: MemoryUnitType;
  text: string;
  context: string | null;
  tags: string[];
  entities: string[];
  /** An observation's supporting facts; a fact's own count is 1. */
  proofCount: number;
  occurredAt: string | null;
  createdAt: string;
}

export interface MemoryUnitListResponse {
  bank: MemoryBankSummary;
  items: MemoryUnitSummary[];
  total: number;
}

/** One graph observation (#1008): a fact row, so its id is a memory id and deletes through that route. Agent-written text. */
export interface MemoryGraphObservation {
  id: string;
  text: string;
}

/** One entity of a bank's graph, as the bank page lists it. Agent-written: render as text. */
export interface MemoryEntitySummary {
  id: string;
  name: string;
  entityType: string;
  /** In the order they were added, as the reference server returns them. */
  observations: MemoryGraphObservation[];
  createdAt: string;
}

/** One relation touching a listed entity; `from`/`to` are entity names, `fromId`/`toId` their row ids. */
export interface MemoryRelationSummary {
  id: string;
  fromId: string;
  from: string;
  toId: string;
  to: string;
  relationType: string;
}

export interface MemoryEntityListResponse {
  bank: MemoryBankSummary;
  /** In creation order. */
  entities: MemoryEntitySummary[];
  /** Every relation with a listed entity at either end, in creation order. */
  relations: MemoryRelationSummary[];
  /** Entities matching the query, beyond the page served. */
  total: number;
}

/** One file of a bank's memory tool store (#1009), without its text. */
export interface MemoryFileSummary {
  id: string;
  /** Canonical, under `/memories`. */
  path: string;
  /** In bytes, as the tool's listing counts them. */
  size: number;
  updatedAt: string;
}

export interface MemoryFileListResponse {
  bank: MemoryBankSummary;
  /** By path. */
  files: MemoryFileSummary[];
  total: number;
}

/** A file's text as stored (masked on write). Agent-written: render as plain text, never as markdown. */
export interface MemoryFileContent extends MemoryFileSummary {
  content: string;
}

/** The capture kinds a memory can be promoted as: page-text notes. */
export const MEMORY_PROMOTE_KINDS = ['gotcha', 'convention', 'howto'] as const;
export type MemoryPromoteKind = (typeof MEMORY_PROMOTE_KINDS)[number];
