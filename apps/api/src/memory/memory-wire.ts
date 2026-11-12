/**
 * Response bodies in Hindsight's wire shape (OpenAPI v1.2.1), written by hand
 * for the routes this server answers (#986). Not in `@knowledge/contracts`:
 * the web client never sees them, and their names are Hindsight's, not ours.
 */

export interface Disposition {
  skepticism: number;
  literalism: number;
  empathy: number;
}

export const DEFAULT_DISPOSITION: Disposition = { skepticism: 3, literalism: 3, empathy: 3 };

export interface BankProfileResponse {
  bank_id: string;
  name: string;
  disposition: Disposition;
  mission: string;
  background: string | null;
}

export interface BankListItem {
  bank_id: string;
  name: string | null;
  disposition: Disposition;
  mission: string | null;
  created_at: string | null;
  updated_at: string | null;
  fact_count: number;
}

export interface BankListResponse {
  banks: BankListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeleteResponse {
  success: boolean;
  message: string | null;
  deleted_count: number | null;
}

/** The Hindsight API version these shapes follow. */
export const HINDSIGHT_API_VERSION = '1.2.1';

export interface VersionResponse {
  api_version: string;
  features: Record<
    | 'observations'
    | 'mcp'
    | 'worker'
    | 'bank_config_api'
    | 'bank_llm_health'
    | 'file_upload_api'
    | 'document_export_api'
    | 'document_import_api'
    | 'audit_log'
    | 'llm_trace'
    | 'store_document_text',
    boolean
  >;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RetainResponse {
  success: boolean;
  bank_id: string;
  items_count: number;
  async: boolean;
  operation_id?: string | null;
  usage?: TokenUsage | null;
}

/** `MemoryUnitListItem`, and what `GET …/memories/{id}` answers with (plus `type` and the entity names as a list). */
export interface MemoryUnitItem {
  id: string;
  text: string;
  context: string;
  /** The event date, empty when unknown. */
  date: string;
  fact_type: string;
  document_id: string;
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  /** Comma-separated names, as Hindsight lists them. */
  entities: string;
  chunk_id: null;
  proof_count: number;
  tags: string[];
  metadata: Record<string, unknown>;
  state: 'valid';
  updated_at: string;
  source_memory_ids: string[];
}

export interface ListMemoryUnitsResponse {
  items: MemoryUnitItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface BankStatsResponse {
  bank_id: string;
  total_nodes: number;
  total_links: number;
  total_documents: number;
  nodes_by_fact_type: Record<string, number>;
  links_by_link_type: Record<string, number>;
  links_by_fact_type: Record<string, number>;
  links_breakdown: Record<string, Record<string, number>>;
  pending_operations: number;
  failed_operations: number;
  last_memory_write_at: string | null;
  pending_consolidation: number;
  failed_consolidation: number;
  total_observations: number;
}

export interface RecallResult {
  id: string;
  text: string;
  type: string;
  entities: string[];
  context: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: string | null;
  document_id: string;
  metadata: Record<string, string>;
  chunk_id: null;
  tags: string[];
  source_fact_ids: string[];
  /** What was computed for this result; a leg that did not surface it is left out. */
  scores: { final: number; semantic?: number; keyword?: number };
}

export interface RecallResponse {
  results: RecallResult[];
  entities?: Record<string, { entity_id: string; canonical_name: string; observations: Array<{ text: string; mentioned_at?: string | null }> }>;
  chunks?: Record<string, never>;
  source_facts?: Record<string, never>;
}
