import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MemoryBank } from '@prisma/client';
import { createMasker } from '../common/mask.js';
import { lockSubject, withSubjectLock } from '../common/subject-lock.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService, type MemoryCaller, type MemoryRole } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import type { RetainItem } from './memory-facts.js';
import {
  ancestorsOf,
  commandOf,
  directoryListing,
  editedSnippet,
  fileChunks,
  fileDocumentId,
  fileView,
  imageRefused,
  insertAt,
  isImagePath,
  isRoot,
  isUnder,
  memoryPath,
  MemoryToolError,
  notAFile,
  pathMissing,
  readCommand,
  replaceOnce,
  type MemoryPath,
} from './memory-files.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { MemoryRateService } from './memory-rate.service.js';
import { MemoryUnitsService } from './memory-units.service.js';

/** What a memory tool call answers: the `tool_result` the application hands back to Claude. */
export interface MemoryToolResult {
  content: string;
  is_error: boolean;
}

/** The caller, resolved on execution for the role the command needs. `capture` lifts a capture key, for `create` only. */
export type MemoryToolCallerFor = (role: MemoryRole, opts?: { capture?: boolean }) => Promise<MemoryCaller>;

/** The role each command needs (#1006): `view` a viewer, `create` an editor or a capture key, every other an editor. */
export function memoryToolRole(command: string | null): { role: MemoryRole; capture?: boolean } {
  if (command === 'create') return { role: 'editor', capture: true };
  if (command === 'str_replace' || command === 'insert' || command === 'delete' || command === 'rename') return { role: 'editor' };
  // `view`, and an input naming no known command: it is answered with an error and touches nothing.
  return { role: 'viewer' };
}

type FileRow = { id: string; path: string; content: string };

/**
 * A bank's files (#1009): the Anthropic memory tool's six commands over
 * `memory_files`, for both of its wires, the REST route and the `files` MCP
 * profile. The rules and strings are `memory-files.ts`; this holds the rows
 * and the recall index.
 *
 * - **Roles on execution.** `execute` resolves the caller for the command
 *   before anything is read: memory off is a 404 and a missing role a 403,
 *   both as HTTP errors, never as a tool result.
 * - **A bank is created by its first `create`.** Everything else on a bank
 *   that does not exist reads an empty `/memories`.
 * - **Masked on write.** The stored text is what every later command reads,
 *   so a `str_replace` quoting the original secret is "did not appear".
 * - **Recall.** Each write replaces the file's chunks (`document_id =
 *   file:<path>`) through the intake, verbatim and born consolidated, so
 *   consolidation never claims them. A delete takes them with the file, a
 *   rename moves them, in the transaction that moves the rows.
 * - **Reads spend the recall rate, writes the retain rate.**
 *
 * Writes are serialised per bank by the `memory-files:{bank}` lock, taken
 * before the bank's `memory-bank:{bank}` lock wherever both are held. The
 * chunks are written after the file commits: an index that fails (no
 * embedding provider, a store not ready) leaves the file written and is
 * logged, and the next write of that file replaces the chunks again.
 *
 * API-only, as the intake it writes through.
 */
@Injectable()
export class MemoryFilesService {
  private readonly logger = new Logger(MemoryFilesService.name);
  private readonly maxChars: number;
  private readonly maxItems: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
    private readonly intake: MemoryIntakeService,
    private readonly units: MemoryUnitsService,
    private readonly rate: MemoryRateService,
    config: ConfigService<Env, true>,
  ) {
    this.maxChars = config.get('MEMORY_RETAIN_MAX_CHARS', { infer: true });
    this.maxItems = config.get('MEMORY_RETAIN_MAX_ITEMS', { infer: true });
  }

  /** One raw `tool_use.input`, run. A refusal of the input is an `is_error` result; a refusal of the caller throws. */
  async execute(callerFor: MemoryToolCallerFor, bankId: string, input: unknown): Promise<MemoryToolResult> {
    const { role, capture } = memoryToolRole(commandOf(input));
    const caller = await callerFor(role, { capture });
    await this.rate.check(role === 'viewer' ? 'recall' : 'retain', caller.principal);
    try {
      const command = readCommand(input);
      switch (command.command) {
        case 'view':
          return ok(await this.view(caller, bankId, command.path, command.view_range));
        case 'create':
          return ok(await this.create(caller, bankId, command.path, command.file_text));
        case 'str_replace':
          return ok(await this.edit(caller, bankId, command.path, (content) => replaceOnce(command.path, content, command.old_str, command.new_str), editedSnippet));
        case 'insert':
          return ok(await this.edit(caller, bankId, command.path, (content) => ({ content: insertAt(content, command.insert_line, command.insert_text), line: 0 }), () => `The file ${command.path} has been edited.`));
        case 'delete':
          return ok(await this.delete(caller, bankId, command.path));
        case 'rename':
          return ok(await this.rename(caller, bankId, command.old_path, command.new_path));
      }
    } catch (e) {
      if (e instanceof MemoryToolError) return { content: `Error: ${e.message}`, is_error: true };
      throw e;
    }
  }

  // --- commands ----------------------------------------------------------

  private async view(caller: MemoryCaller, bankId: string, shown: string, viewRange: number[] | undefined): Promise<string> {
    const p = memoryPath(shown);
    const bank = await this.access.find(caller, bankId);
    if (!isRoot(p) && bank) {
      const file = await this.prisma.memoryFile.findUnique({ where: { bankId_path: { bankId: bank.id, path: p.path } }, select: { content: true } });
      if (file) {
        if (isImagePath(p.path)) throw imageRefused(shown);
        return fileView(shown, file.content, viewRange);
      }
    }
    // The root always exists, even in a bank that does not: an empty store's first view is not an error.
    const under = bank ? await this.filesUnder(bank, p) : [];
    if (!isRoot(p) && !under.length) throw pathMissing(shown);
    return directoryListing(shown, p, under);
  }

  private async create(caller: MemoryCaller, bankId: string, shown: string, text: string): Promise<string> {
    const p = memoryPath(shown);
    // The root is a directory, and so is any path files sit under: the SDK's answer for a directory in the way.
    if (isRoot(p)) throw new MemoryToolError(`File ${shown} already exists`);
    if (isImagePath(p.path)) throw imageRefused(shown);
    this.assertSize(shown, text);
    const bank = await this.banks.ensure(caller, bankId);
    const content = createMasker()(text);
    await withSubjectLock(this.prisma, filesLock(bank), async () => {
      await this.assertNoFileAbove(bank, p, shown);
      if ((await this.filesUnder(bank, p)).length) throw new MemoryToolError(`File ${shown} already exists`);
      // Overwrites a file that exists: the documentation allows it, and Claude's tool description says "creates or overwrites".
      await this.prisma.memoryFile.upsert({
        where: { bankId_path: { bankId: bank.id, path: p.path } },
        create: { workspaceId: caller.workspaceId, bankId: bank.id, path: p.path, content, createdBy: caller.principal.userId, updatedBy: caller.principal.userId },
        update: { content, updatedBy: caller.principal.userId },
      });
    });
    await this.index(caller, bank, p.path, content);
    return `File created successfully at: ${shown}`;
  }

  /**
   * `str_replace` and `insert`: the file's text read, changed by `change`,
   * masked, size-checked and written back under the lock; the answer is built
   * from the text as stored.
   */
  private async edit(
    caller: MemoryCaller,
    bankId: string,
    shown: string,
    change: (content: string) => { content: string; line: number },
    answer: (stored: string, line: number) => string,
  ): Promise<string> {
    const p = memoryPath(shown);
    if (isRoot(p)) throw notAFile(shown);
    const bank = await this.access.find(caller, bankId);
    if (!bank) throw pathMissing(shown);
    const done = await withSubjectLock(this.prisma, filesLock(bank), async () => {
      const file = await this.prisma.memoryFile.findUnique({ where: { bankId_path: { bankId: bank.id, path: p.path } }, select: { id: true, content: true } });
      if (!file) throw (await this.filesUnder(bank, p)).length ? notAFile(shown) : pathMissing(shown);
      const changed = change(file.content);
      const content = createMasker()(changed.content);
      this.assertSize(shown, content);
      await this.prisma.memoryFile.update({ where: { id: file.id }, data: { content, updatedBy: caller.principal.userId } });
      return { content, line: changed.line };
    });
    await this.index(caller, bank, p.path, done.content);
    return answer(done.content, done.line);
  }

  private async delete(caller: MemoryCaller, bankId: string, shown: string): Promise<string> {
    const p = memoryPath(shown);
    if (isRoot(p)) throw new MemoryToolError('Cannot delete the /memories directory itself');
    const bank = await this.access.find(caller, bankId);
    if (!bank) throw new MemoryToolError(`The path ${shown} does not exist`);
    await withSubjectLock(this.prisma, filesLock(bank), async () => {
      const doomed = await this.fileOrTree(bank, p);
      if (!doomed.length) throw new MemoryToolError(`The path ${shown} does not exist`);
      await this.removeRows(bank, doomed);
    });
    return `Successfully deleted ${shown}`;
  }

  /**
   * One file by its row id, with its recall chunks: the bank page's delete
   * (#1010). Under the same lock as the tool's writes. False when the bank
   * holds no such file.
   */
  async removeFile(bank: MemoryBank, fileId: string): Promise<boolean> {
    return withSubjectLock(this.prisma, filesLock(bank), async () => {
      const file = await this.prisma.memoryFile.findFirst({ where: { id: fileId, bankId: bank.id }, select: { id: true, path: true } });
      if (!file) return false;
      await this.removeRows(bank, [file]);
      return true;
    });
  }

  /** The one delete path for a bank's memories: under the bank lock, bare observations swept, vectors after. */
  private async removeRows(bank: MemoryBank, rows: Array<{ id: string; path: string }>): Promise<void> {
    await this.units.deleteWhere(bank, { documentId: { in: rows.map((f) => fileDocumentId(f.path)) } }, () =>
      this.prisma.memoryFile.deleteMany({ where: { id: { in: rows.map((f) => f.id) } } }),
    );
  }

  private async rename(caller: MemoryCaller, bankId: string, oldShown: string, newShown: string): Promise<string> {
    const from = memoryPath(oldShown);
    const to = memoryPath(newShown);
    if (isRoot(from)) throw new MemoryToolError('Cannot rename the /memories directory itself');
    const destinationExists = () => new MemoryToolError(`The destination ${newShown} already exists`);
    if (isRoot(to)) throw destinationExists();
    const bank = await this.access.find(caller, bankId);
    if (!bank) throw new MemoryToolError(`The path ${oldShown} does not exist`);
    await withSubjectLock(this.prisma, filesLock(bank), async () => {
      // In the SDK's order: the destination first, then the source.
      if ((await this.fileOrTree(bank, to)).length) throw destinationExists();
      const moving = await this.fileOrTree(bank, from);
      if (!moving.length) throw new MemoryToolError(`The path ${oldShown} does not exist`);
      const isFile = moving.length === 1 && moving[0]!.path === from.path;
      if (!isFile && isUnder(to.path, from.path)) throw new MemoryToolError(`Cannot move ${oldShown} into itself`);
      if (isFile && isImagePath(to.path)) throw imageRefused(newShown);
      await this.assertNoFileAbove(bank, to, newShown, from.path);
      const moves = moving.map((f) => ({ id: f.id, from: f.path, to: to.path + f.path.slice(from.path.length) }));
      await this.prisma.$executeRaw`
        UPDATE memory_files f SET path = m.to_path, updated_by = ${caller.principal.userId}::uuid, updated_at = now()
          FROM unnest(${moves.map((m) => m.id)}::uuid[], ${moves.map((m) => m.to)}::text[]) AS m(id, to_path)
         WHERE f.id = m.id`;
      // The recall index moves with the rows, under the bank's lock so no retain of these ids interleaves.
      await lockSubject(this.prisma, `memory-bank:${bank.id}`);
      await this.prisma.$executeRaw`
        UPDATE memory_units u SET document_id = 'file:' || m.to_path, context = m.to_path, updated_at = now()
          FROM unnest(${moves.map((m) => fileDocumentId(m.from))}::text[], ${moves.map((m) => m.to)}::text[]) AS m(doc, to_path)
         WHERE u.bank_id = ${bank.id}::uuid AND u.fact_type <> 'observation' AND u.document_id = m.doc`;
    });
    return `Successfully renamed ${oldShown} to ${newShown}`;
  }

  // --- helpers -----------------------------------------------------------

  /** The files under the directory `p` (the whole bank for the root), with their size in bytes. */
  private filesUnder(bank: MemoryBank, p: MemoryPath): Promise<Array<{ path: string; size: number }>> {
    return this.prisma.$queryRaw<Array<{ path: string; size: number }>>`
      SELECT path, octet_length(content)::int AS size FROM memory_files
       WHERE bank_id = ${bank.id}::uuid AND starts_with(path, ${`${p.path}/`})`;
  }

  /** The file at `p`, or every file under it when it is a directory; empty when it is neither. `starts_with`, not LIKE: a path may hold `_` or `%`. */
  private fileOrTree(bank: MemoryBank, p: MemoryPath): Promise<FileRow[]> {
    return this.prisma.$queryRaw<FileRow[]>`
      SELECT id, path, '' AS content FROM memory_files
       WHERE bank_id = ${bank.id}::uuid AND (path = ${p.path} OR starts_with(path, ${`${p.path}/`}))
       ORDER BY path`;
  }

  /** A file cannot sit under a file. `moving` is a path leaving in the same step, which may stand above the destination. */
  private async assertNoFileAbove(bank: MemoryBank, p: MemoryPath, shown: string, moving?: string): Promise<void> {
    const above = ancestorsOf(p).filter((a) => a !== moving);
    if (!above.length) return;
    const file = await this.prisma.memoryFile.findFirst({ where: { bankId: bank.id, path: { in: above } }, select: { path: true } });
    if (file) throw new MemoryToolError(`Cannot write ${shown}: ${file.path} is a file`);
  }

  private assertSize(shown: string, content: string): void {
    if (content.length > this.maxChars) throw new MemoryToolError(`File ${shown} would hold ${content.length} characters; the limit is ${this.maxChars}`);
  }

  /**
   * The file's recall chunks, replaced: verbatim, born consolidated, the path
   * as their context. A file emptied of text keeps no chunk. A failure is
   * logged, never answered: the file is written and the next write re-indexes.
   */
  private async index(caller: MemoryCaller, bank: MemoryBank, path: string, content: string): Promise<void> {
    const documentId = fileDocumentId(path);
    try {
      const chunks = fileChunks(content, this.maxItems);
      if (!chunks.length) {
        await this.units.deleteWhere(bank, { documentId, factType: { not: 'observation' } });
        return;
      }
      const timestamp = new Date().toISOString();
      const items: RetainItem[] = chunks.map((chunk) => ({ content: chunk, context: path, timestamp, metadata: { file: path }, documentId, entities: [], tags: [], append: false }));
      await this.intake.store(caller, bank, items, { verbatim: true, consolidated: true });
    } catch (e) {
      this.logger.warn({ msg: 'memory file written, recall index not updated', bankId: bank.id, path, error: String(e) });
    }
  }
}

const ok = (content: string): MemoryToolResult => ({ content, is_error: false });
const filesLock = (bank: MemoryBank) => `memory-files:${bank.id}`;
