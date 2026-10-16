import { Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CodeImportIndex } from './adapters/connector.types.js';

/** Rows per insert: six bind parameters each keeps a batch far below Postgres's 65 535. */
const INSERT_BATCH = 5_000;

/** A repository of a few thousand files writes tens of thousands of rows; the default 5 s is too tight. */
const REPLACE_TIMEOUT_MS = 120_000;

/** One file that imports another, at the indexed head. */
export interface CodeImporter {
  importerPath: string;
  names: string[];
  headSha: string | null;
}

/**
 * The reverse-import index of a code connector (#236, phase 1).
 *
 * The adapter reads the edges from the archive a pull already downloaded; this
 * stores them. The index is the connector's head and nothing else: a pull
 * replaces it whole, in one transaction, so a reader sees one head or the
 * next — never rows from both, and never an older head's rows left behind.
 */
@Injectable()
export class CodeImportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Replace the connector's index with `index`. Returns the number of rows written. */
  async replace(connector: Pick<Connector, 'id' | 'workspaceId'>, index: CodeImportIndex): Promise<number> {
    const rows = index.edges.map((edge) => ({
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      headSha: index.headSha,
      importerPath: edge.importer,
      importedPath: edge.imported,
      names: edge.names,
    }));
    // An adapter that cannot list its files leaves the previous list alone
    // rather than claiming every declared path vanished.
    const files = index.files?.map((path) => ({
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      headSha: index.headSha,
      path,
    }));
    await this.prisma.$transaction(
      async (tx) => {
        await tx.codeImport.deleteMany({ where: { connectorId: connector.id } });
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          await tx.codeImport.createMany({ data: rows.slice(i, i + INSERT_BATCH) });
        }
        if (!files) return;
        await tx.codeFile.deleteMany({ where: { connectorId: connector.id } });
        for (let i = 0; i < files.length; i += INSERT_BATCH) {
          await tx.codeFile.createMany({ data: files.slice(i, i + INSERT_BATCH), skipDuplicates: true });
        }
      },
      { timeout: REPLACE_TIMEOUT_MS },
    );
    return rows.length;
  }

  /** The files that import `path` at the indexed head, in path order. */
  importersOf(connectorId: string, path: string): Promise<CodeImporter[]> {
    return this.prisma.codeImport.findMany({
      where: { connectorId, importedPath: path },
      select: { importerPath: true, names: true, headSha: true },
      orderBy: { importerPath: 'asc' },
    });
  }
}
