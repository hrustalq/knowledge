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
