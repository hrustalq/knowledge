import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hasCapability, type Locale, type MemberCapability, type WorkspaceRole } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { DEV_PRINCIPAL, ROLE_ORDER, type Principal } from './principal.js';
import { AuthPolicyService } from './auth-policy.service.js';
import { t } from '../i18n/t.js';
import { WORKSPACE_SOURCES, workspaceOwnerOf, type RowSource } from './workspace-sources.js';

/**
 * Phase 5 ACLs (plan.md §11): authorization is resolved in PostgreSQL BEFORE
 * any graph/vector query runs. The mandatory workspaceId predicate that
 * GraphService injects into every graph statement is the second half of the
 * same guarantee (plan.md §6 security note).
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: AuthPolicyService,
  ) {}

  async requireRole(
    principal: Principal,
    workspaceId: string,
    role: WorkspaceRole,
    operator = false,
    opts: { allowGuest?: boolean; capture?: boolean; capability?: MemberCapability } = {},
  ): Promise<void> {
    // A key narrows its owner before anything widens them: checked ahead of the
    // platform-admin shortcut, or an admin's read-only key would write anyway.
    if (principal.apiKey) this.requireKeyAllows(principal.apiKey, workspaceId, role, opts);
    if (principal.mode === 'dev') return; // AUTH_MODE=none — full access
    // Ahead of the admin shortcut: a deleted workspace (#479) is gone to everyone,
    // whichever resolver found its id — most read it off a child row that
    // outlives the tombstone until the teardown sweeper reaches it.
    await this.workspaceExists(workspaceId);
    // The workspace's sign-in policy (#75): enforced SSO, keys under it, a
    // session age cap. Ahead of the admin shortcut so an admin's crossing is
    // audited as break-glass; behind the key, which narrows first regardless.
    await this.policy.enforce(principal, workspaceId);
    if (principal.isAdmin) return; // platform admin — implicit admin + operator everywhere
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: principal.userId } },
    });
    if (!member) throw new ForbiddenException(t('error.auth.notMember', { workspaceId }));
    // `allowGuest`: a route that filters its answer by page grants reads a
    // guest as a viewer of what they were granted (#76, `@Access({ guests })`).
    const held = member.role === 'guest' && opts.allowGuest ? ROLE_ORDER.viewer : (ROLE_ORDER[member.role as WorkspaceRole] ?? -1);
    if (held < ROLE_ORDER[role]) {
      throw new ForbiddenException(
        t('error.auth.roleRequired', {
          role: t(`role.${role}`),
          workspaceId,
          currentRole: t(`role.${member.role}`),
        }),
      );
    }
    if (operator && !member.trustedOperator) {
      throw new ForbiddenException(t('error.auth.trustedOperatorRequired'));
    }
    // A grained permission beside the role (#468). Platform admins returned
    // above; workspace admins hold every capability through the predicate.
    if (opts.capability && !hasCapability(member, opts.capability)) {
      throw new ForbiddenException(t('error.auth.capabilityRequired', { capability: opts.capability }));
    }
  }

  /**
   * The narrowing a `kn_` key carries (docs/features/33). Exposed separately so
   * a caller with no workspace to resolve (the MCP tool filter) asks the same
   * question the guard does rather than a copy of it.
   *
   * A `capture` key (issue #73) is a read key everywhere except the calls that
   * say `capture: true` — the agent-memory tools and routes, which only ever
   * stage a capture and open a merge request. Even there it reaches editor and
   * no further, so no flag can lift it to merge, approve or administer.
   */
  requireKeyAllows(
    key: NonNullable<Principal['apiKey']>,
    workspaceId: string,
    role: WorkspaceRole,
    opts: { capture?: boolean } = {},
  ): void {
    if (key.workspaceId && key.workspaceId !== workspaceId) {
      throw new ForbiddenException(t('error.auth.apiKeyWorkspace', { workspaceId }));
    }
    if (ROLE_ORDER[role] <= ROLE_ORDER.viewer || key.scope === 'write') return;
    if (key.scope === 'capture') {
      if (opts.capture && role === 'editor') return;
      throw new ForbiddenException(t('error.auth.apiKeyCaptureOnly', { role: t(`role.${role}`) }));
    }
    throw new ForbiddenException(t('error.auth.apiKeyReadOnly', { role: t(`role.${role}`) }));
  }

  /**
   * The principal a stored `created_by` stands for — how unattended work
   * (agent runs, workflow nodes) gets an identity to execute as.
   *
   * A disabled or deleted owner throws: background work never falls back to
   * ambient authority, and there is no service principal for it to become.
   * The one accommodation is the dev/MCP stub id, which has no `users` row by
   * design — the same allowance the merge gates make for that identity, and a
   * no-op under `api-key`, where no real user can hold it.
   *
   * It lives here rather than in each processor because both callers need the
   * exact same rule, and a second copy of it is a second place for the rule to
   * drift (docs/features/20).
   */
  async principalFor(userId: string, locale: Locale): Promise<Principal> {
    if (userId === DEV_PRINCIPAL.userId) return DEV_PRINCIPAL;
    const owner = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!owner || owner.disabledAt) {
      throw new ForbiddenException(t('error.auth.runOwnerUnavailable'));
    }
    return {
      userId: owner.id,
      email: owner.email,
      displayName: owner.displayName,
      avatarUrl: userAvatarUrl(owner),
      mode: 'api-key',
      isAdmin: owner.isAdmin,
      locale,
    };
  }

  /** For @Access(..., 'workspace') routes: 404 for unknown — or deleted (#479) — workspaces before the membership check. */
  async workspaceExists(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, deletedAt: true } });
    if (!ws || ws.deletedAt) throw new NotFoundException(t('error.workspace.notFound', { id: workspaceId }));
    return ws.id;
  }

  /**
   * The workspace the row `id` names belongs to, read from PostgreSQL; 404 when
   * there is no such row. How each source finds it is one row of
   * `WORKSPACE_SOURCES` — the guard and every service resolve through here.
   */
  async workspaceOf(source: RowSource, id: string | number): Promise<string> {
    const workspaceId = await workspaceOwnerOf(this.prisma, source, id);
    if (workspaceId) return workspaceId;
    const row = WORKSPACE_SOURCES[source];
    throw new NotFoundException(t(row.missing, { [row.arg ?? 'id']: id }));
  }

  workspaceOfDocument(documentId: string): Promise<string> {
    return this.workspaceOf('document', documentId);
  }

  workspaceOfProject(projectId: string): Promise<string> {
    return this.workspaceOf('project', projectId);
  }

  /** The page a merge request changes — what page permissions are checked against (#76). */
  async documentOfMergeRequest(mergeRequestId: string): Promise<{ workspaceId: string; documentId: string }> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      select: { documentId: true, document: { select: { workspaceId: true } } },
    });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return { workspaceId: mr.document.workspaceId, documentId: mr.documentId };
  }

  /**
   * A chat thread and its messages are their asker's (#772). The turn ran under
   * that person's scope, so its answers can quote pages nobody else may open.
   * Anyone else gets the same 404 as a thread that does not exist.
   */
  async requireOwnThread(principal: Principal, ref: { threadId: string } | { messageId: string }): Promise<void> {
    if (principal.mode === 'dev') return;
    const owner =
      'threadId' in ref
        ? await this.prisma.assistantThread.findUnique({ where: { id: ref.threadId }, select: { createdBy: true } })
        : await this.prisma.assistantMessage
            .findUnique({ where: { id: ref.messageId }, select: { thread: { select: { createdBy: true } } } })
            .then((message) => message?.thread ?? null);
    if (owner?.createdBy === principal.userId) return;
    throw new NotFoundException(
      'threadId' in ref
        ? t('error.assistant.threadNotFound', { id: ref.threadId })
        : t('error.assistant.messageNotFoundById', { id: ref.messageId }),
    );
  }

  async memberships(principal: Principal) {
    if (principal.mode === 'dev') return [];
    // A deleted workspace (#479) keeps its member rows until the teardown runs.
    return this.prisma.workspaceMember.findMany({ where: { userId: principal.userId, workspace: { deletedAt: null } } });
  }
}
