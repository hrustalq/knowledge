import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { globToRegExp } from '../../common/glob.js';
import { AccessService } from '../../auth/access.service.js';
import type { AccessScope } from '../../permissions/access-scope.js';
import { PermissionService } from '../../permissions/permission.service.js';
import { CODE_TOOLS } from '../../assistant/assistant-tool-types.js';
import type { AssistantToolContext, AssistantToolResult } from '../../assistant/assistant-tool-types.js';
import type { CodeSymbol } from '../adapters/code-symbols.js';
import { TreeSitterService } from '../adapters/tree-sitter.service.js';
import { codeToolDefinitions, SnapshotCodeTools } from './code-tools.js';
import { RepoSnapshotService, type RepoSnapshot, type RepoSummary } from './repo-snapshot.service.js';

export { globToRegExp };
export { compileSearch, listTree, normalizeRepoPath, windowLines, type TreeEntry } from './code-tools.js';

/**
 * The tools that read a connected repository (docs/features/31).
 *
 * Shaped like AssistantReadToolsService — `definitions()` and `execute()` in
 * one worker-loadable service — for the same reason: a background agent has
 * to be able to run these without loading anything that writes. The chat
 * harness reaches them through AssistantToolsService, which delegates here.
 *
 * Every result is wrapped as untrusted data. A repository is written by people
 * the model cannot see, and a file that says "ignore your instructions" is a
 * file, not an instruction — the web pages rule, applied to source.
 *
 * `code_read` cites: its result carries the file's address on its host as a
 * web source, so an answer built on it shows the same chip a fetched page
 * would, linking to the file on GitHub or GitLab. A code citation *is* a link
 * that leaves the product, which is exactly what that chip was drawn for.
 */
@Injectable()
export class CodeResearchService {
  private readonly logger = new Logger(CodeResearchService.name);

  constructor(
    private readonly access: AccessService,
    private readonly snapshots: RepoSnapshotService,
    private readonly permissions: PermissionService,
    treeSitter: TreeSitterService,
  ) {
    this.tools = new SnapshotCodeTools(treeSitter);
  }

  private readonly tools: SnapshotCodeTools;

  /** The repositories `scope` may read, `projectId`'s first — what decides whether the tools are offered. */
  repositories(scope: AccessScope, projectId?: string): Promise<RepoSummary[]> {
    return this.snapshots.listRepos(scope, projectId);
  }

  definitions(): ChatCompletionFunctionTool[] {
    return codeToolDefinitions();
  }

  /**
   * Runs one code tool.
   *
   * Authorises on every call, the read-tools rule: the other caller is a
   * background agent with no guard in front of it. The connector is then
   * re-resolved by RepoSnapshotService, which is where workspace, project
   * visibility, kind and enabled are checked — on execution, not on offer,
   * because a turn outlives a settings change. A run's audience clamps the
   * project check like it clamps page reads (#553).
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    if (!CODE_TOOLS.has(name)) return this.fail(`Unknown tool: ${name}`);
    try {
      await this.access.requireRole(ctx.principal, ctx.workspaceId, 'viewer');
      const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
      if (!connectorId) return this.fail('connectorId is required — pick one from the connected repositories list');
      const snapshot = await this.snapshots.open(connectorId, await this.permissions.toolScope(ctx));
      return await this.tools.run(name, args, snapshot);
    } catch (error) {
      // A refused connector, a vanished file, a bad pattern: the model gets the
      // reason and moves on. Nothing here is a 500.
      const message = error instanceof HttpException ? error.message : (error as Error).message;
      this.logger.debug(`${name} failed: ${message}`);
      return this.fail(message);
    }
  }

  /**
   * What a file declares, as data — shared by the tool and by the archaeologist,
   * which needs the exported names to decide whether a file is documented.
   * Null when there is no grammar for the file or the parse failed.
   */
  outlineFile(snapshot: RepoSnapshot, path: string): Promise<{ symbols: CodeSymbol[]; imports: string[] } | null> {
    return this.tools.outlineFile(snapshot, path);
  }

  private fail(message: string): AssistantToolResult {
    return { content: JSON.stringify({ error: message }), ok: false, sources: [] };
  }
}
