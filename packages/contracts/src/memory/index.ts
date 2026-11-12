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

/** The capture kinds a memory can be promoted as: page-text notes. */
export const MEMORY_PROMOTE_KINDS = ['gotcha', 'convention', 'howto'] as const;
export type MemoryPromoteKind = (typeof MEMORY_PROMOTE_KINDS)[number];
