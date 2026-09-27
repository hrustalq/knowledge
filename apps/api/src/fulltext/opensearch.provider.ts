import { Logger } from '@nestjs/common';
import type { FulltextChunk, FulltextHit, FulltextProvider } from './fulltext.provider.js';

interface SearchHit {
  _score: number;
  _source: FulltextChunk & { workspaceId: string };
}

/**
 * OpenSearch-backed BM25 provider (plan.md §11 Phase 5). Plain HTTP like
 * ArcadeClient — no SDK dependency. Index mapping is applied lazily on first
 * use; every search carries a mandatory workspaceId term filter.
 */
export class OpenSearchFulltextProvider implements FulltextProvider {
  readonly enabled = true;
  private readonly logger = new Logger(OpenSearchFulltextProvider.name);
  private ready?: Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly index: string,
  ) {}

  private ensureIndex(): Promise<void> {
    this.ready ??= (async () => {
      const res = await fetch(`${this.baseUrl}/${this.index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: {
            properties: {
              workspaceId: { type: 'keyword' },
              documentId: { type: 'keyword' },
              revisionId: { type: 'keyword' },
              live: { type: 'boolean' },
              chunkId: { type: 'keyword' },
              index: { type: 'integer' },
              headingPath: { type: 'keyword' },
              text: { type: 'text' },
            },
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        if (!body.includes('resource_already_exists_exception')) {
          this.ready = undefined; // retry on next call
          throw new Error(`OpenSearch index create failed (${res.status}): ${body.slice(0, 300)}`);
        }
      }
    })();
    return this.ready;
  }

  async indexRevisionChunks(
    workspaceId: string,
    revisionId: string,
    chunks: FulltextChunk[],
    live = true,
  ): Promise<void> {
    await this.ensureIndex();
    await this.deleteRevision(revisionId);
    if (chunks.length === 0) return;
    const ndjson =
      chunks
        .flatMap((c) => [
          JSON.stringify({ index: { _index: this.index, _id: c.chunkId } }),
          JSON.stringify({ ...c, workspaceId, live }),
        ])
        .join('\n') + '\n';
    const res = await fetch(`${this.baseUrl}/_bulk?refresh=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
    });
    const body = (await res.json()) as { errors?: boolean };
    if (!res.ok || body.errors) {
      throw new Error(`OpenSearch bulk index failed (${res.status}) for revision ${revisionId}`);
    }
    this.logger.log(`Indexed ${chunks.length} chunk(s) for revision ${revisionId} into ${this.index}`);
  }

  async deleteRevision(revisionId: string): Promise<void> {
    await this.ensureIndex();
    const res = await fetch(`${this.baseUrl}/${this.index}/_delete_by_query?refresh=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { term: { revisionId } } }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`OpenSearch delete_by_query failed (${res.status}) for revision ${revisionId}`);
    }
  }

  /**
   * #83: two update_by_query passes, raise then lower, so a concurrent search
   * sees a duplicate for a moment rather than a missing page. Documents
   * indexed before the `live` field existed have no value and read as live
   * (see `search`) until this runs for their document.
   */
  async setLiveRevision(workspaceId: string, documentId: string, revisionId: string | null): Promise<void> {
    await this.ensureIndex();
    const scope = [{ term: { workspaceId } }, { term: { documentId } }];
    const passes: Array<{ live: boolean; query: unknown }> = [
      ...(revisionId
        ? [{ live: true, query: { bool: { filter: [...scope, { term: { revisionId } }] } } }]
        : []),
      {
        live: false,
        query: {
          bool: { filter: scope, ...(revisionId ? { must_not: [{ term: { revisionId } }] } : {}) },
        },
      },
    ];
    for (const pass of passes) {
      const res = await fetch(`${this.baseUrl}/${this.index}/_update_by_query?refresh=true&conflicts=proceed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: pass.query,
          script: { source: 'ctx._source.live = params.live', lang: 'painless', params: { live: pass.live } },
        }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`OpenSearch update_by_query failed (${res.status}) for document ${documentId}`);
      }
    }
  }

  async search(workspaceId: string, query: string, k: number): Promise<FulltextHit[]> {
    await this.ensureIndex();
    const res = await fetch(`${this.baseUrl}/${this.index}/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: k,
        query: {
          bool: {
            must: [{ match: { text: { query } } }],
            // Mandatory server-side workspace predicate (plan.md §6).
            filter: [{ term: { workspaceId } }],
            // #83: only the live projection. must_not rather than a term on
            // true, so documents indexed before the field existed still match.
            must_not: [{ term: { live: false } }],
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`OpenSearch search failed (${res.status})`);
    const body = (await res.json()) as { hits?: { hits?: SearchHit[] } };
    return (body.hits?.hits ?? []).map((h) => ({
      chunkId: h._source.chunkId,
      documentId: h._source.documentId,
      revisionId: h._source.revisionId,
      text: h._source.text ?? '',
      headingPath: h._source.headingPath ?? [],
      score: h._score,
    }));
  }
}
