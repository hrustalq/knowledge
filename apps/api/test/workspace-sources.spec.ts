import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { WORKSPACE_SOURCES, type RowSource } from '../src/auth/workspace-sources.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const SOURCES = Object.keys(WORKSPACE_SOURCES) as RowSource[];

/** Every delegate answers the same row; a join that reads a relation it does not carry comes back undefined. */
const prismaWith = (row: unknown) =>
  new Proxy({}, { get: () => ({ findUnique: async () => row }) });
const owned = { workspaceId: WS, document: { workspaceId: WS }, thread: { workspaceId: WS }, site: { workspaceId: WS } };

describe('WORKSPACE_SOURCES', () => {
  it.each(SOURCES)('%s resolves its workspace and 404s an unknown id', async (source) => {
    const id = WORKSPACE_SOURCES[source].int ? 7 : ID;
    expect(await new AccessService(prismaWith(owned) as never, noAuthPolicy).workspaceOf(source, id)).toBe(WS);
    const missing = new AccessService(prismaWith(null) as never, noAuthPolicy).workspaceOf(source, id);
    await expect(missing).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing).rejects.toThrow(WORKSPACE_SOURCES[source].missing);
  });

  // These two resolve to a page (`documentOfMergeRequest`, `rootOfWorkflowRun`), not through `workspaceOf`.
  it.each(SOURCES.filter((s) => s !== 'merge-request' && s !== 'workflow-run'))('the guard reads %s from its param and refuses a malformed id', async (source) => {
    const row = WORKSPACE_SOURCES[source];
    const seen: unknown[] = [];
    const access = { workspaceOf: async (_: string, id: unknown) => (seen.push(id), WS), requireRole: async () => undefined, requireOwnThread: async () => undefined };
    const run = (value: string) =>
      new AclGuard(
        { getAllAndOverride: () => undefined, get: () => ({ role: 'viewer', source, operator: false }) } as never,
        access as never,
        { requireResource: async () => undefined, requireBranches: async () => undefined, requireConnectorVisible: async () => undefined } as never,
        {} as never,
      ).canActivate({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({ principal: { userId: 'u', mode: 'session' }, method: 'GET', params: { [row.param ?? 'id']: value }, query: {}, body: {} }),
        }),
      } as never);
    await run(row.int ? '7' : ID);
    expect(seen).toEqual([row.int ? 7 : ID]);
    await expect(run('nope')).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('workflow-run (#1085)', () => {
    const RUN = { workspaceId: WS, projectId: '33333333-3333-4333-8333-333333333333', rootDocumentId: ID };
    const access = (run: unknown, page: unknown) =>
      new AccessService(
        { workflowRun: { findUnique: async () => run }, document: { findUnique: async () => page } } as never,
        noAuthPolicy,
      );

    it('resolves a run to its root page', async () => {
      expect(await access(RUN, { id: ID }).rootOfWorkflowRun(ID)).toEqual({ workspaceId: WS, resource: { type: 'document', id: ID } });
    });

    it("falls back to the run's project once the page is gone", async () => {
      expect(await access(RUN, null).rootOfWorkflowRun(ID)).toEqual({
        workspaceId: WS,
        resource: { type: 'project', id: RUN.projectId },
      });
    });

    it('404s an unknown run', async () => {
      await expect(access(null, null).rootOfWorkflowRun(ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the guard holds the route to the page level', async () => {
      const asked: unknown[] = [];
      await new AclGuard(
        { getAllAndOverride: () => undefined, get: () => ({ role: 'editor', source: 'workflow-run', operator: false }) } as never,
        { rootOfWorkflowRun: async () => ({ workspaceId: WS, resource: { type: 'document', id: ID } }) } as never,
        { requireResource: async (...args: unknown[]) => void asked.push(args.slice(1, 4)) } as never,
        {} as never,
      ).canActivate({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({ principal: { userId: 'u', mode: 'session' }, method: 'POST', params: { id: ID }, query: {}, body: {} }),
        }),
      } as never);
      expect(asked).toEqual([[WS, { type: 'document', id: ID }, 'editor']]);
    });
  });
});
