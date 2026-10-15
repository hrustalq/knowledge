import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KnowledgeEvent } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { canSee, hidesAnything, type AccessScope, type VisibilityRow } from '../permissions/access-scope.js';

interface CachedScope {
  scope: AccessScope;
  at: number;
}

/**
 * Which live frames a connection may receive (#76, phase 5), shared by the
 * SSE stream and the WS gateway so the two cannot disagree.
 *
 * An event about a page reaches only connections whose holder can open it.
 * Each connection's `AccessScope` is cached for ACL_CACHE_TTL_MS — a frame is
 * no request, and asking PG three questions per frame per socket would make
 * the bus a load test — and forgotten the moment `acl.changed` arrives for its
 * workspace. A page's chain is read once per frame, and only when some
 * listener's scope hides anything.
 *
 * Deny by default: a scope that cannot be computed (membership gone, PG down)
 * delivers nothing about pages, and a page that cannot be read (deleted)
 * reaches only those who see everything.
 */
@Injectable()
export class LiveVisibility {
  private readonly scopes = new Map<string, CachedScope>();
  private readonly ttlMs: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {
    this.ttlMs = config.get('ACL_CACHE_TTL_MS', { infer: true });
  }

  /**
   * Call once per frame, before any `allows`: an `acl.changed` drops every
   * cached scope for its workspace, so the very next frame is judged afresh.
   */
  observe(event: KnowledgeEvent): void {
    if (event.type !== 'acl.changed') return;
    for (const key of this.scopes.keys()) {
      if (key.endsWith(`:${event.workspaceId}`)) this.scopes.delete(key);
    }
  }

  /** Whether each listener may receive `event`, in the order given. */
  async allows(event: KnowledgeEvent, listeners: Principal[]): Promise<boolean[]> {
    if (!event.documentId || event.userId) {
      // Workspace-level frames, and frames addressed to one person (their own
      // notification, already filtered when it was written), pass as before.
      return listeners.map(() => true);
    }
    const scopes = await Promise.all(listeners.map((p) => this.scopeOf(p, event.workspaceId)));
    if (scopes.every((s) => s !== null && !hidesAnything(s))) return listeners.map(() => true);
    const row = await this.rowOf(event.documentId);
    return scopes.map((scope) => {
      if (!scope) return false;
      if (!hidesAnything(scope)) return true;
      return row !== null && row.workspaceId === event.workspaceId && canSee(scope, row);
    });
  }

  private async scopeOf(principal: Principal, workspaceId: string): Promise<AccessScope | null> {
    const key = `${principal.userId}:${workspaceId}`;
    const cached = this.scopes.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.scope;
    try {
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      this.scopes.set(key, { scope, at: Date.now() });
      if (this.scopes.size > 10_000) this.scopes.clear();
      return scope;
    } catch {
      this.scopes.delete(key);
      return null;
    }
  }

  private async rowOf(documentId: string): Promise<(VisibilityRow & { workspaceId: string }) | null> {
    try {
      return await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { workspaceId: true, projectId: true, path: true, restrictedBy: true },
      });
    } catch {
      return null;
    }
  }
}
