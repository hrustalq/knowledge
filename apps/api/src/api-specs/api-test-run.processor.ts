import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  apiServerOptions,
  isSecretName,
  runTestPlan,
  testRunCounts,
  type TestRunPlan,
  type TestRunResult,
  type TestRunTarget,
} from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';
import { ApiTestEnvironmentsService } from './api-test-environments.service.js';
import { API_TEST_RUN_QUEUE } from './api-test-run.producer.js';
import { ApiTestRunsService } from './api-test-runs.service.js';
import { ApiTryService } from './api-try.service.js';

/**
 * The QA server runner (#483, phase 5), worker-side. Everything is checked
 * again here, at execution, because a run outlives the click: the runner is
 * still on, its owner still holds `api-test-suites.run` and may still open
 * every spec the plan calls, and the environment still exists. Then the plan
 * is walked by `runTestPlan` — the browser runner's rules — and each step
 * goes out through `ApiTryService.sendAs`, the proxy's own path: proxy mode,
 * source policies, safe-url, the target check and the audit.
 *
 * The worker writes run rows only; it publishes nothing.
 */
@Processor(API_TEST_RUN_QUEUE)
export class ApiTestRunProcessor extends WorkerHost {
  private readonly logger = new Logger(ApiTestRunProcessor.name);

  constructor(
    private readonly runs: ApiTestRunsService,
    private readonly environments: ApiTestEnvironmentsService,
    private readonly tries: ApiTryService,
    private readonly reads: ApiSpecReadService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
  ) {
    super();
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    const run = await this.runs.claim(job.data.runId);
    if (!run) return;
    const plan = run.plan as unknown as TestRunPlan;
    try {
      await this.runs.assertOn(run.workspaceId);
      const principal = await this.access.principalFor(run.createdBy, 'en');
      await this.access.requireRole(principal, run.workspaceId, 'viewer', false, { capability: 'api-test-suites.run' });
      const scope = await this.permissions.scopeFor(principal, run.workspaceId);
      const targets = targetsOf(plan);
      for (const id of new Set([plan.documentId, ...targets.map((x) => x.documentId)])) {
        await this.permissions.requireLevel(scope, { type: 'document', id }, 'view');
      }
      const env = run.environmentId ? await this.environments.values(run.workspaceId, run.environmentId) : null;
      if (!env) throw new Error(t('error.apiTestRun.environmentGone'));

      const servers = new Map<string, string[]>();
      for (const target of targets) {
        if (servers.has(target.revisionId)) continue;
        const spec = await this.reads.spec(target.documentId, target.revisionId);
        servers.set(target.revisionId, apiServerOptions(spec.document).map((s) => s.url.replace(/\/+$/u, '')));
      }
      // The environment's server, where the step's spec declares it; the plan's own server otherwise.
      const rebase = (target: TestRunTarget, url: string) =>
        env.server && target.server && url.startsWith(target.server) && servers.get(target.revisionId)?.includes(env.server)
          ? env.server + url.slice(target.server.length)
          : url;

      const results = await runTestPlan(plan, env.values, async (_key, target, req) => {
        const res = await this.tries.sendAs(
          run.createdBy,
          target.documentId,
          {
            revisionId: target.revisionId,
            entityKey: target.entityKey,
            method: req.method,
            url: rebase(target, req.url),
            headers: req.headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
          },
          false,
        );
        return { status: res.status, headers: res.headers, body: res.encoding === 'utf8' ? res.body : '', durationMs: res.durationMs };
      });
      const stored = withoutSecrets(Object.fromEntries(results));
      const counts = testRunCounts(plan, stored);
      await this.runs.finish(run.id, { status: counts.failed || counts.notRun ? 'failed' : 'passed', results: stored, counts });
    } catch (e) {
      this.logger.warn(`QA server run ${run.id} could not run: ${(e as Error).message}`);
      await this.runs.finish(run.id, { status: 'error', error: (e as Error).message, counts: testRunCounts(plan, {}) });
    }
  }
}

function targetsOf(plan: TestRunPlan): TestRunTarget[] {
  const steps = [...plan.setup, ...plan.teardown, ...plan.cases.flatMap((c) => [...c.setup, ...c.teardown])];
  return [...plan.cases.map((c) => c.target), ...steps.flatMap((s) => (s.kind === 'call' ? [s.target] : []))];
}

/** A run record keeps what was captured, never a capture named like a secret. */
function withoutSecrets(results: Record<string, TestRunResult>): Record<string, TestRunResult> {
  return Object.fromEntries(
    Object.entries(results).map(([key, r]) => [key, { ...r, captures: Object.fromEntries(Object.entries(r.captures).filter(([name]) => !isSecretName(name))) }]),
  );
}
