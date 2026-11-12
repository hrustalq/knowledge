import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { MemoryBank } from '@prisma/client';
import { UUID_RE } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { FeaturesService } from '../auth/features.service.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { canSeeProject, type AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A memory request, resolved: who is asking, in which workspace, and what they may see there. */
export interface MemoryCaller {
  principal: Principal;
  workspaceId: string;
  scope: AccessScope;
}

/** What a memory route needs of its caller: a viewer recalls and reflects, an editor retains. */
export type MemoryRole = 'viewer' | 'editor';

// A bank id is the client's free text, so it travels in URLs and logs: bounded, and printable.
// eslint-disable-next-line no-control-regex
const BANK_ID_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

/**
 * The one place a memory request becomes a workspace and a bank (#986).
 * Every memory route and the per-bank MCP endpoint ask here, so no surface
 * restates the rule:
 *
 * 1. `MEMORY_ENABLED` off → 404, before anything else is read.
 * 2. `default` in the path is the key's pinned workspace; a key with no pin
 *    (or a browser session) is a 400. Under `AUTH_MODE=none` the workspace is
 *    named by the `X-Workspace-Id` header.
 * 3. `AccessService.requireRole`: membership, the role, and what the key
 *    narrows — a read-only key never retains, a `capture` key only where the
 *    route says so. A key limited to MCP toolsets never gets this far:
 *    `AuthGuard` refuses it on every route that is not `@McpKeyOk`.
 * 4. The workspace's `memory` section → 404 when off, told only to a member.
 * 5. A bank bound to a project follows that project's restriction: hidden
 *    from whoever cannot see the project, as a 404.
 */
@Injectable()
export class MemoryAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly features: FeaturesService,
    private readonly permissions: PermissionService,
  ) {}

  /** 404 while the server has memory off — for the routes that resolve no workspace. */
  requireEnabled(): void {
    if (this.features.unavailable().includes('memory')) throw new NotFoundException(t('error.memory.disabled'));
  }

  /** The database answers: what a Hindsight client's `/health` probe asks. */
  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async caller(principal: Principal, workspaceHeader: string | undefined, role: MemoryRole, opts: { capture?: boolean } = {}): Promise<MemoryCaller> {
    this.requireEnabled();
    const workspaceId = this.workspaceOf(principal, workspaceHeader);
    await this.access.requireRole(principal, workspaceId, role, false, { capture: opts.capture === true });
    await this.features.require(workspaceId, 'memory');
    return { principal, workspaceId, scope: await this.permissions.scopeFor(principal, workspaceId) };
  }

  /** The bank `bankId` names in the caller's workspace; 404 when there is none, or its project is hidden from them. */
  async bank(caller: MemoryCaller, bankId: string): Promise<MemoryBank> {
    const row = await this.find(caller, bankId);
    if (!row) throw new NotFoundException(t('error.memory.bankNotFound', { bankId }));
    return row;
  }

  /** As `bank`, or null where a caller may go on to create it. A hidden bank still throws: it exists. */
  async find(caller: MemoryCaller, bankId: string): Promise<MemoryBank | null> {
    if (!BANK_ID_RE.test(bankId)) throw new BadRequestException(t('error.memory.bankIdInvalid'));
    const row = await this.prisma.memoryBank.findUnique({ where: { workspaceId_bankId: { workspaceId: caller.workspaceId, bankId } } });
    if (!row) return null;
    if (!(await this.visible(caller.scope, [row])).length) throw new NotFoundException(t('error.memory.bankNotFound', { bankId }));
    return row;
  }

  /** The banks among `rows` this scope may read: `canSeeProject` on each bound project, as chat search asks of a binding. */
  async visible<B extends { projectId: string | null }>(scope: AccessScope, rows: B[]): Promise<B[]> {
    const projectIds = [...new Set(rows.flatMap((b) => (b.projectId ? [b.projectId] : [])))];
    const restricted = new Set(
      projectIds.length
        ? (await this.prisma.project.findMany({ where: { id: { in: projectIds }, restricted: true }, select: { id: true } })).map((p) => p.id)
        : [],
    );
    return rows.filter((b) => b.projectId === null || canSeeProject(scope, { id: b.projectId, restricted: restricted.has(b.projectId) }));
  }

  private workspaceOf(principal: Principal, header: string | undefined): string {
    if (principal.mode === 'dev') {
      if (!header || !UUID_RE.test(header)) throw new BadRequestException(t('error.memory.workspaceHeaderRequired'));
      return header;
    }
    const pinned = principal.apiKey?.workspaceId;
    if (!pinned) throw new BadRequestException(t('error.memory.workspaceRequired'));
    return pinned;
  }
}
