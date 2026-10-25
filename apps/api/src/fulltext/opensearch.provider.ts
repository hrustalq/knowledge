import { Logger } from '@nestjs/common';
import { aclAdmits, type DocumentAclFilter } from '../common/document-acl.js';
import type { FulltextChunk, FulltextHit, FulltextProvider } from './fulltext.provider.js';
import type { RevisionStamp, TemporalPoint } from '../graph/temporal.js';

/**
 * The ACL fields (#76). Declared on create and again on every boot with
 * `_mapping`, which is additive, so an index created before them gains them —
 * left to dynamic mapping, a uuid list would be analyzed as text and a
 * `terms` filter on it would match nothing.
 */
const ACL_PROPERTIES = {
  aclNodes: { type: 'keyword' },
  aclRestricted: { type: 'boolean' },
};

/**
 * #400: chunk text keeps the raw `standard` field and gains Russian and
 * English analysis (stemming, stopwords) as multi-fields. Built-in analyzers
 * need no index settings, so an existing index takes them through the same
 * additive `_mapping` update, and `reanalyze` backfills its rows in place.
 */
const ANALYZED = {
  type: 'text',
  fields: { ru: { type: 'text', analyzer: 'russian' }, en: { type: 'text', analyzer: 'english' } },
};

/**
 * #528: `heading` is the page title and the headings above the chunk, so a
 * page is keyword-findable by words only its title or a section heading
 * carries. `headingPath` stays a keyword for display. Rows written before the
 * field have none until the fulltext re-mirror rewrites them (the migration
 * `20261215100000_fulltext_heading` marks every indexed revision for it).
 */
const TEXT_PROPERTIES = { text: ANALYZED, heading: ANALYZED };

/** #528: how much a heading term outweighs the same term in a chunk body. */
const HEADING_BOOST = 2;

/** #400: rows written before the analyzed fields existed. */
const UNANALYZED = JSON.stringify({ query: { bool: { must_not: [{ exists: { field: 'text.ru' } }] } } });

/**
 * #400: the BM25 clause. The query's script picks one analyzed field, because
 * each analyzer drops only its own language's stopwords: summed over several
 * fields, «от» and «при» counted once per field that kept them. Latin tokens
 * in a Russian query (`main`, `MR`) pass the Russian analyzer unchanged. Up to
 * two terms need every term, longer queries 60% of them (rounded down), so
 * one shared generic token (`base`) no longer makes a hit.
 *
 * #528: body and heading are one `cross_fields` match, so the term share
 * counts across both — a query whose words sit partly in the title and partly
 * in the body still makes a hit. Both fields of a language share its analyzer,
 * which is what lets cross_fields blend them as one.
 */
export function bm25Clause(query: string) {
  const lang = /\p{Script=Cyrillic}/u.test(query) ? 'ru' : 'en';
  return {
    multi_match: {
      query,
      type: 'cross_fields',
      fields: [`text.${lang}`, `heading.${lang}^${HEADING_BOOST}`],
      minimum_should_match: '2<60%',
    },
  };
}

/** Valid-time stamps (#81), added to an existing index by the same mapping update. */
const VALIDITY_PROPERTIES = {
  validFrom: { type: 'long' },
  validTo: { type: 'long' },
  lineage: { type: 'keyword' },
};

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
              ...VALIDITY_PROPERTIES,
              chunkId: { type: 'keyword' },
              index: { type: 'integer' },
              headingPath: { type: 'keyword' },
              ...TEXT_PROPERTIES,
              ...ACL_PROPERTIES,
            },
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        if (!body.includes('resource_already_exists_exception')) {
          throw new Error(`OpenSearch index create failed (${res.status}): ${body.slice(0, 300)}`);
        }
        const mapped = await fetch(`${this.baseUrl}/${this.index}/_mapping`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: { ...TEXT_PROPERTIES, ...ACL_PROPERTIES, ...VALIDITY_PROPERTIES } }),
        });
        if (!mapped.ok) {
          throw new Error(`OpenSearch mapping update failed (${mapped.status}): ${(await mapped.text()).slice(0, 300)}`);
        }
        await this.reanalyze();
      }
    })().catch((err: unknown) => {
      // Any failure, an HTTP error or a thrown fetch, leaves nothing cached: the next call retries (#330).
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  /**
   * #400: rows indexed before the analyzed fields existed lack `text.ru`, so
   * BM25 cannot find them. Rewrite them from their own `_source`, with nothing
   * re-chunked or re-embedded, as a background task. Keyed on the rows rather
   * than the mapping, so a backfill that failed or was cut short by a restart
   * resumes on the next boot. Two processes booting together may both start
   * one; the second only rewrites rows again.
   */
  private async reanalyze(): Promise<void> {
    const missing = await fetch(`${this.baseUrl}/${this.index}/_count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: UNANALYZED,
    });
    if (!missing.ok) throw new Error(`OpenSearch count failed (${missing.status}): ${(await missing.text()).slice(0, 300)}`);
    const { count } = (await missing.json()) as { count?: number };
    if (!count) return;
    const res = await fetch(
      `${this.baseUrl}/${this.index}/_update_by_query?conflicts=proceed&refresh=true&wait_for_completion=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: UNANALYZED,
      },
    );
    if (!res.ok) throw new Error(`OpenSearch reanalyze failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const { task } = (await res.json()) as { task?: string };
    this.logger.log(`Re-analyzing ${count} row(s) of ${this.index} for ru/en search fields (task ${task})`);
  }

  async indexRevisionChunks(
    workspaceId: string,
    revisionId: string,
    chunks: FulltextChunk[],
    { live, aclNodes, title }: { live: boolean; aclNodes: string[]; title: string },
  ): Promise<void> {
    await this.ensureIndex();
    await this.deleteRevision(revisionId);
    if (chunks.length === 0) return;
    const ndjson =
      chunks
        .flatMap((c) => [
          JSON.stringify({ index: { _index: this.index, _id: c.chunkId } }),
          JSON.stringify({
            ...c,
            // A page whose body opens with `# <title>` would count the title twice.
            heading: [...new Set([title, ...c.headingPath])],
            workspaceId,
            live,
            aclNodes,
            aclRestricted: aclNodes.length > 0,
          }),
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
    await this.deleteByTerm({ revisionId }, `revision ${revisionId}`);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.deleteByTerm({ workspaceId }, `workspace ${workspaceId}`);
  }

  private async deleteByTerm(term: Record<string, string>, what: string): Promise<void> {
    await this.ensureIndex();
    const res = await fetch(`${this.baseUrl}/${this.index}/_delete_by_query?refresh=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { term } }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`OpenSearch delete_by_query failed (${res.status}) for ${what}`);
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

  async restamp(workspaceId: string, documentId: string, aclNodes: string[]): Promise<void> {
    await this.ensureIndex();
    const res = await fetch(`${this.baseUrl}/${this.index}/_update_by_query?refresh=true&conflicts=proceed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { bool: { filter: [{ term: { workspaceId } }, { term: { documentId } }] } },
        script: {
          source: 'ctx._source.aclNodes = params.aclNodes; ctx._source.aclRestricted = params.aclRestricted',
          lang: 'painless',
          params: { aclNodes, aclRestricted: aclNodes.length > 0 },
        },
      }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`OpenSearch restamp failed (${res.status}) for document ${documentId}`);
    }
  }

  /**
   * `acl` (#76) goes in as an exact page-id predicate while the list is short
   * enough. Past `ACL_DENY_LIST_MAX`, a member's filter falls back to the
   * `aclNodes` stamps (a page under any node they are denied), which lag a
   * restriction change by up to one re-stamp tick; a guest's is not pushed at
   * all. Either way the hits are filtered again below and in PG afterwards,
   * so a lagging stamp can only cost recall, never leak a page.
   */
  /** #81: one update_by_query per revision, scoped to the page. */
  async stampRevisions(workspaceId: string, documentId: string, stamps: readonly RevisionStamp[]): Promise<void> {
    if (stamps.length === 0) return;
    await this.ensureIndex();
    for (const stamp of stamps) {
      const res = await fetch(`${this.baseUrl}/${this.index}/_update_by_query?refresh=true&conflicts=proceed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: { bool: { filter: [{ term: { workspaceId } }, { term: { documentId } }, { term: { revisionId: stamp.revisionId } }] } },
          script: {
            source: 'ctx._source.validFrom = params.validFrom; ctx._source.validTo = params.validTo; ctx._source.lineage = params.lineage',
            lang: 'painless',
            params: { validFrom: stamp.validFrom, validTo: stamp.validTo, lineage: stamp.lineage },
          },
        }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`OpenSearch validity stamp failed (${res.status}) for document ${documentId}`);
      }
    }
  }

  async search(workspaceId: string, query: string, k: number, acl: DocumentAclFilter, at?: TemporalPoint): Promise<FulltextHit[]> {
    await this.ensureIndex();
    const filter: unknown[] = [{ term: { workspaceId } }];
    // #83: only the live projection. must_not rather than a term on true, so
    // documents indexed before the field existed still match.
    const mustNot: unknown[] = at ? [] : [{ term: { live: false } }];
    // #81: as of a point, the rows whose interval covers it — the chunk
    // predicate of `asOfChunkClause`, spelled for OpenSearch.
    if (at) {
      filter.push(
        { term: { lineage: 'default' } },
        { range: { validFrom: { lte: at.at } } },
        { bool: { should: [{ bool: { must_not: [{ exists: { field: 'validTo' } }] } }, { range: { validTo: { gt: at.at } } }], minimum_should_match: 1 } },
      );
    }
    if (acl.kind !== 'all') {
      const ids = acl.documentIds.size ? [...acl.documentIds] : [''];
      if (acl.kind === 'allow') {
        if (acl.pushdown) filter.push({ terms: { documentId: ids } });
      } else if (acl.pushdown) {
        mustNot.push({ terms: { documentId: ids } });
      } else {
        mustNot.push({ terms: { aclNodes: acl.nodeIds } });
      }
    }
    const res = await fetch(`${this.baseUrl}/${this.index}/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: k,
        query: {
          bool: {
            must: [bm25Clause(query)],
            // Mandatory server-side workspace predicate (plan.md §6).
            filter,
            must_not: mustNot,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`OpenSearch search failed (${res.status})`);
    const body = (await res.json()) as { hits?: { hits?: SearchHit[] } };
    return (body.hits?.hits ?? []).filter((h) => aclAdmits(acl, h._source.documentId)).map((h) => ({
      chunkId: h._source.chunkId,
      documentId: h._source.documentId,
      revisionId: h._source.revisionId,
      text: h._source.text ?? '',
      headingPath: h._source.headingPath ?? [],
      score: h._score,
    }));
  }
}
