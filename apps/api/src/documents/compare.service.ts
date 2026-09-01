import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { structuredPatch } from 'diff';
import type {
  CompareMode,
  CompareResponse,
  CompareRevisionRef,
  DiffHunk,
  DiffLine,
  SemanticDiff,
  SemanticRelationChange,
  StructuralDiff,
} from '@knowledge/contracts';
import type { DocumentBranch, DocumentRevision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { parseStructured, structuralDiff } from './structural-diff.js';

const DIFF_FORMAT = 'unified-json';
const STRUCTURAL_FORMAT = 'structural-json';

export interface CompareOptions {
  /** Path-level structural diff (JSON/YAML body or markdown frontmatter). Default true — cheap and cached. */
  structural?: boolean;
  /** Graph-projection semantic diff (entities/relations/embedding shift). Default false — hits the graph store. */
  semantic?: boolean;
}

type RevisionWithBranch = DocumentRevision & { branch: DocumentBranch | null };

/**
 * GitLab-style revision comparison (plan.md §8):
 *  - direct      → git diff from to
 *  - merge-base  → git diff from...to (diff `to` against the nearest common
 *                  ancestor of from/to, isolating the incoming side's changes)
 *
 * Three diff levels (plan.md §12.6): raw line diff, structural path diff,
 * semantic graph diff. Line + structural diffs between finalized (immutable)
 * revisions are cached in revision_diffs.
 */
@Injectable()
export class CompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
  ) {}

  async compare(
    documentId: string,
    fromId: string,
    toId: string,
    mode: CompareMode,
    opts: CompareOptions = {},
  ): Promise<CompareResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);

    const [from, to] = await Promise.all([
      this.getComparableRevision(documentId, fromId),
      this.getComparableRevision(documentId, toId),
    ]);

    let mergeBaseRevisionId: string | null = null;
    let base = from;
    if (mode === 'merge-base') {
      mergeBaseRevisionId = await this.findMergeBase(documentId, from.id, to.id);
      if (mergeBaseRevisionId && mergeBaseRevisionId !== from.id) {
        base = await this.getComparableRevision(documentId, mergeBaseRevisionId);
      } else {
        base = from;
        mergeBaseRevisionId = mergeBaseRevisionId ?? null;
      }
    }

    const [{ additions, deletions, hunks }, structural, semantic] = await Promise.all([
      this.diff(base, to),
      opts.structural === false ? Promise.resolve(undefined) : this.structuralOf(base, to),
      opts.semantic ? this.semanticOf(document.workspaceId, documentId, base, to) : Promise.resolve(undefined),
    ]);

    return {
      documentId,
      from: this.toRef(from),
      to: this.toRef(to),
      comparisonMode: mode,
      mergeBaseRevisionId: mode === 'merge-base' ? mergeBaseRevisionId : null,
      summary: { additions, deletions },
      hunks,
      structural,
      semantic,
    };
  }

  /**
   * Nearest common ancestor over the revision_parents DAG (BFS by depth).
   * Returns null when the two revisions share no history.
   */
  async findMergeBase(documentId: string, aId: string, bId: string): Promise<string | null> {
    if (aId === bId) return aId;

    // Documents have bounded revision counts — load the whole parent map once.
    const edges = await this.prisma.revisionParent.findMany({
      where: { revision: { documentId } },
      select: { revisionId: true, parentRevisionId: true },
    });
    const parentsOf = new Map<string, string[]>();
    for (const e of edges) {
      const list = parentsOf.get(e.revisionId) ?? [];
      list.push(e.parentRevisionId);
      parentsOf.set(e.revisionId, list);
    }

    const ancestorsOfA = new Set<string>();
    let frontier = [aId];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (ancestorsOfA.has(id)) continue;
        ancestorsOfA.add(id);
        next.push(...(parentsOf.get(id) ?? []));
      }
      frontier = next;
    }

    const seen = new Set<string>();
    frontier = [bId];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (ancestorsOfA.has(id)) return id; // first hit at minimal depth from b
        next.push(...(parentsOf.get(id) ?? []));
      }
      frontier = next;
    }
    return null;
  }

  private async diff(
    from: RevisionWithBranch,
    to: RevisionWithBranch,
  ): Promise<{ additions: number; deletions: number; hunks: DiffHunk[] }> {
    if (from.id === to.id) return { additions: 0, deletions: 0, hunks: [] };

    // Finalized revisions are immutable → cache is always valid once written.
    const cached = await this.prisma.revisionDiff.findUnique({
      where: {
        fromRevisionId_toRevisionId_format: {
          fromRevisionId: from.id,
          toRevisionId: to.id,
          format: DIFF_FORMAT,
        },
      },
    });
    if (cached) {
      return {
        additions: cached.additions,
        deletions: cached.deletions,
        hunks: cached.changes as unknown as DiffHunk[],
      };
    }

    const [fromText, toText] = await Promise.all([
      this.storage.getObjectText(from.s3Key),
      this.storage.getObjectText(to.s3Key),
    ]);

    const patch = structuredPatch('content.md', 'content.md', fromText, toText, undefined, undefined, {
      context: 3,
    });

    let additions = 0;
    let deletions = 0;
    const hunks: DiffHunk[] = patch.hunks.map((h) => {
      let oldLine = h.oldStart;
      let newLine = h.newStart;
      const lines: DiffLine[] = [];
      for (const raw of h.lines) {
        const marker = raw[0];
        const text = raw.slice(1);
        if (marker === '+') {
          additions += 1;
          lines.push({ kind: 'added', new: newLine++, text });
        } else if (marker === '-') {
          deletions += 1;
          lines.push({ kind: 'deleted', old: oldLine++, text });
        } else if (marker === '\\') {
          // "\ No newline at end of file" — metadata, not content.
          continue;
        } else {
          lines.push({ kind: 'context', old: oldLine++, new: newLine++, text });
        }
      }
      return {
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines,
      };
    });

    await this.prisma.revisionDiff
      .create({
        data: {
          fromRevisionId: from.id,
          toRevisionId: to.id,
          format: DIFF_FORMAT,
          additions,
          deletions,
          changes: hunks as unknown as object,
        },
      })
      .catch(() => {
        /* unique race with a concurrent compare — cache row already exists */
      });

    return { additions, deletions, hunks };
  }

  /**
   * Structural (path-level) diff: JSON/YAML bodies as parsed values, markdown
   * on its frontmatter (plan.md §8). Null when either side isn't structured
   * content, or the sides parse into different structural sources.
   */
  private async structuralOf(from: RevisionWithBranch, to: RevisionWithBranch): Promise<StructuralDiff | null> {
    if (from.id === to.id) return null;

    const cached = await this.prisma.revisionDiff.findUnique({
      where: {
        fromRevisionId_toRevisionId_format: {
          fromRevisionId: from.id,
          toRevisionId: to.id,
          format: STRUCTURAL_FORMAT,
        },
      },
    });
    // Only applicable diffs are cached, so a hit is always a real StructuralDiff.
    if (cached) return cached.changes as unknown as StructuralDiff;

    const [fromText, toText] = await Promise.all([
      this.storage.getObjectText(from.s3Key),
      this.storage.getObjectText(to.s3Key),
    ]);
    const fromParsed = parseStructured(from.contentType, fromText);
    const toParsed = parseStructured(to.contentType, toText);
    if (!fromParsed || !toParsed || fromParsed.source !== toParsed.source) return null;

    const result = structuralDiff(toParsed.source, fromParsed.data, toParsed.data);

    await this.prisma.revisionDiff
      .create({
        data: {
          fromRevisionId: from.id,
          toRevisionId: to.id,
          format: STRUCTURAL_FORMAT,
          additions: result.summary.added,
          deletions: result.summary.removed,
          changes: result as unknown as object,
        },
      })
      .catch(() => {
        /* unique race with a concurrent compare — cache row already exists */
      });

    return result;
  }

  /**
   * Semantic diff (plan.md §8): compare the graph projections the two
   * revisions asserted. Phase 3 covers deterministic sources (frontmatter
   * relation edges + relation-derived entities) plus the embedding-shift
   * score; LLM-extracted entities/relations arrive in Phase 4.
   */
  private async semanticOf(
    workspaceId: string,
    documentId: string,
    from: RevisionWithBranch,
    to: RevisionWithBranch,
  ): Promise<SemanticDiff> {
    const relations = await this.graph.getDocumentRelations(workspaceId, documentId);
    const keyOf = (r: { type: string; targetKey: string }) => `${r.type}|${r.targetKey}`;

    const fromRels = new Map(relations.filter((r) => r.revisionId === from.id).map((r) => [keyOf(r), r]));
    const toRels = new Map(relations.filter((r) => r.revisionId === to.id).map((r) => [keyOf(r), r]));

    const toChange = (r: { type: string; targetKey: string; extractor: string; confidence: number }): SemanticRelationChange => ({
      type: r.type,
      targetKey: r.targetKey,
      extractor: r.extractor,
      confidence: r.confidence,
    });

    const added = [...toRels.values()].filter((r) => !fromRels.has(keyOf(r))).map(toChange);
    const removed = [...fromRels.values()].filter((r) => !toRels.has(keyOf(r))).map(toChange);

    const fromEntities = new Set([...fromRels.values()].map((r) => r.targetKey));
    const toEntities = new Set([...toRels.values()].map((r) => r.targetKey));

    return {
      entities: {
        added: [...toEntities].filter((k) => !fromEntities.has(k)).sort(),
        removed: [...fromEntities].filter((k) => !toEntities.has(k)).sort(),
      },
      relations: { added, removed },
      embeddingShift: await this.graph.revisionEmbeddingShift(workspaceId, from.id, to.id),
    };
  }

  private async getComparableRevision(documentId: string, revisionId: string): Promise<RevisionWithBranch> {
    const rev = await this.prisma.documentRevision.findUnique({
      where: { id: revisionId },
      include: { branch: true },
    });
    if (!rev || rev.documentId !== documentId) {
      throw new NotFoundException(`Revision ${revisionId} not found on document ${documentId}`);
    }
    if (!rev.contentHash) {
      throw new BadRequestException(
        `Revision ${revisionId} is ${rev.status} — only finalized revisions can be compared`,
      );
    }
    return rev;
  }

  private toRef(r: RevisionWithBranch): CompareRevisionRef {
    return {
      revisionId: r.id,
      revisionNumber: r.revisionNumber,
      branch: r.branch?.name ?? null,
      contentHash: r.contentHash,
    };
  }
}
