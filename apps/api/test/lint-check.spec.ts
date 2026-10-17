import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, DiffHunk, LintViolation, StyleRule } from '@knowledge/contracts';
import {
  changedText,
  countsOf,
  lintThreadBody,
  planLintThreads,
  resolveLintPolicy,
  styleFindings,
} from '../src/documents/lint/lint-check.js';
import { LintTriggerSweeper, type LintCandidate } from '../src/documents/lint/lint-trigger.sweeper.js';
import { LintPublishSweeper } from '../src/documents/lint/lint-publish.sweeper.js';
import { AgentExecutor } from '../src/agents/agent.executor.js';

/**
 * The merge request style lint (#74, phase 2).
 *
 * What is pinned:
 * 1. **The policy narrows and never widens**: a project inherits the
 *    workspace, the workspace the deployment, everything is clamped to
 *    STYLE_LINT_POLICY, and a disabled linter turns it off.
 * 2. **Only what the merge request adds is linted**, and a finding is anchored
 *    only to a quote the page holds.
 * 3. **One check per head**: the insert is the claim, a newer head supersedes a
 *    waiting one, and every reason not to call the model is recorded.
 * 4. **Published once**, and only lint threads are reconciled: a standing
 *    violation keeps its thread, a fixed one is resolved, a person's resolve
 *    stands, and a person's thread is never read.
 * 5. **The author pays**: the run is theirs, and it lints the head it was given.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const MR = '33333333-3333-4333-8333-333333333333';
const HEAD = '44444444-4444-4444-8444-444444444444';
const OLD_HEAD = '55555555-5555-4555-8555-555555555555';
const AUTHOR = '66666666-6666-4666-8666-666666666666';
const DOC = '77777777-7777-4777-8777-777777777777';

const RULES: StyleRule[] = [
  { id: 'ui-verbs', text: 'Say "select", never "click on".', severity: 'error', enabled: true },
  { id: 'no-we', text: 'Address the reader as "you".', severity: 'suggestion', enabled: true },
];

describe('resolveLintPolicy', () => {
  const base = { workspaceId: WS, linterEnabled: true };

  it('clamps what a scope asks for to the ceiling, and says so', () => {
    expect(resolveLintPolicy({ ...base, projectId: null, ceiling: 'warn', workspacePolicy: 'block', projectPolicy: null })).toMatchObject({
      requested: 'block',
      effective: 'warn',
      source: 'ceiling',
    });
    expect(resolveLintPolicy({ ...base, projectId: null, ceiling: 'block', workspacePolicy: 'warn', projectPolicy: null })).toMatchObject({
      effective: 'warn',
      source: 'scope',
    });
  });

  it('inherits: a project from the workspace, the workspace from the ceiling', () => {
    expect(resolveLintPolicy({ ...base, projectId: null, ceiling: 'warn', workspacePolicy: null, projectPolicy: null })).toMatchObject({
      requested: null,
      effective: 'warn',
      source: 'ceiling',
    });
    expect(resolveLintPolicy({ ...base, projectId: PROJECT, ceiling: 'block', workspacePolicy: 'off', projectPolicy: null })).toMatchObject({
      requested: null,
      inherited: 'off',
      effective: 'off',
      source: 'inherited',
    });
    // A project may turn lint on where the workspace turned it off — narrower is
    // the ceiling's rule, not the workspace's.
    expect(resolveLintPolicy({ ...base, projectId: PROJECT, ceiling: 'block', workspacePolicy: 'off', projectPolicy: 'warn' })).toMatchObject({
      effective: 'warn',
      source: 'scope',
    });
  });

  it('is off while the linter is disabled, whatever was asked for', () => {
    expect(
      resolveLintPolicy({ workspaceId: WS, projectId: null, ceiling: 'block', workspacePolicy: 'block', projectPolicy: null, linterEnabled: false }),
    ).toMatchObject({ requested: 'block', effective: 'off', source: 'agent-disabled', linterEnabled: false });
  });

  it('reads an unknown stored value as no value', () => {
    expect(resolveLintPolicy({ ...base, projectId: null, ceiling: 'warn', workspacePolicy: 'loud', projectPolicy: null }).requested).toBeNull();
  });
});

describe('changedText', () => {
  const hunk = (lines: DiffHunk['lines']): DiffHunk => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines });

  it('keeps the added lines, consecutive ones together, and nothing the change did not add', () => {
    const text = changedText([
      hunk([
        { kind: 'context', text: 'Untouched intro. We click on things here.' },
        { kind: 'deleted', text: 'Old line' },
        { kind: 'added', text: 'New line one,' },
        { kind: 'added', text: 'new line two.' },
        { kind: 'context', text: 'Between.' },
        { kind: 'added', text: 'Click on Save.' },
      ]),
      hunk([{ kind: 'deleted', text: 'Only removed.' }]),
    ]);
    expect(text).toBe('New line one,\nnew line two.\n\nClick on Save.');
    expect(text).not.toContain('Untouched');
  });

  it('is empty for a change that only removes', () => {
    expect(changedText([hunk([{ kind: 'deleted', text: 'gone' }])])).toBe('');
  });
});

describe('styleFindings', () => {
  const page = { documentId: DOC, title: 'Saving', revisionId: HEAD, markdown: 'Intro.\n\nTo save,   click on\nthe Save button. Done.' };
  const v = (quote: string, ruleId = 'ui-verbs'): LintViolation => ({
    ruleId,
    severity: RULES.find((r) => r.id === ruleId)!.severity,
    quote,
    message: 'Use select.',
  });

  it('anchors a quote the page holds, across layout whitespace, with context', () => {
    const [f] = styleFindings([{ ...v('click on the Save button'), suggestion: 'select Save' }], RULES, page);
    expect(f).toMatchObject({
      kind: 'style',
      severity: 'error',
      ruleId: 'ui-verbs',
      title: RULES[0].text,
      detail: 'Use select.',
      suggestion: 'select Save',
      documentIds: [DOC],
      anchor: { type: 'text', revisionId: HEAD, quote: 'click on the Save button', prefix: 'Intro. To save,', suffix: '. Done.' },
    });
  });

  it('drops a quote that straddles two runs of the linted text, and maps suggestion to info', () => {
    const out = styleFindings([v('Intro. click on'), v('Done.', 'no-we')], RULES, page);
    expect(out.map((f) => [f.ruleId, f.severity])).toEqual([['no-we', 'info']]);
    expect(countsOf(out)).toEqual({ error: 0, warning: 0, suggestion: 1 });
  });
});

describe('planLintThreads', () => {
  const finding = (ruleId: string, quote: string): AgentFinding => ({
    kind: 'style',
    severity: 'error',
    title: ruleId,
    detail: '',
    documentIds: [DOC],
    documentTitles: ['Saving'],
    ruleId,
    anchor: { type: 'text', revisionId: HEAD, quote },
  });

  it('keeps a standing violation, opens a new one, resolves a fixed one', () => {
    const plan = planLintThreads(
      [
        { threadId: 't-standing', ruleId: 'ui-verbs', quote: 'click  on Save', resolved: false },
        { threadId: 't-fixed', ruleId: 'ui-verbs', quote: 'click on Cancel', resolved: false },
      ],
      [finding('ui-verbs', 'click on Save'), finding('no-we', 'We recommend')],
    );
    expect(plan.keep.map((k) => k.threadId)).toEqual(['t-standing']);
    expect(plan.create.map((f) => f.ruleId)).toEqual(['no-we']);
    expect(plan.resolve).toEqual(['t-fixed']);
  });

  it('never reopens or repeats a violation a person resolved', () => {
    const plan = planLintThreads([{ threadId: 't-answered', ruleId: 'ui-verbs', quote: 'click on Save', resolved: true }], [finding('ui-verbs', 'click on Save')]);
    expect(plan).toEqual({ create: [], keep: [{ threadId: 't-answered', finding: expect.anything() }], resolve: [] });
  });

  it('reads a wider or narrower quote of the same rule as the same violation', () => {
    const plan = planLintThreads(
      [
        { threadId: 't-short', ruleId: 'no-we', quote: 'We recommend', resolved: false },
        { threadId: 't-other-rule', ruleId: 'ui-verbs', quote: 'We recommend you select Export first.', resolved: false },
      ],
      [finding('no-we', 'We recommend you select Export first.')],
    );
    expect(plan.keep.map((k) => k.threadId)).toEqual(['t-short']);
    expect(plan.create).toEqual([]);
    expect(plan.resolve).toEqual(['t-other-rule']);
  });

  it('reports a violation once even if the run repeated it', () => {
    expect(planLintThreads([], [finding('ui-verbs', 'x y z'), finding('ui-verbs', 'x  y z')]).create).toHaveLength(1);
  });
});

describe('lintThreadBody', () => {
  it('names the rule and quotes the passage, defusing mentions and markup from the page and the model', () => {
    const body = lintThreadBody({
      kind: 'style',
      severity: 'warning',
      title: 'Say "select".',
      detail: 'Ping @alice <b>now</b>',
      documentIds: [DOC],
      documentTitles: ['Saving'],
      ruleId: 'ui-verbs',
      anchor: { type: 'text', revisionId: HEAD, quote: 'ask @bob' },
      suggestion: 'select it',
    });
    // Bare unit test: t() answers with the key, which is what is pinned here.
    expect(body).toContain('**agent.lint.severity.warning** · Say "select".');
    expect(body).toContain('> ask @​bob');
    expect(body).toContain('Ping @​alice &lt;b>now&lt;/b>');
    expect(body).toContain('agent.lint.suggestion select it');
    expect(body).not.toMatch(/@(alice|bob)/);
  });
});

// ---------------------------------------------------------------------------

const CANDIDATE: LintCandidate = { mergeRequestId: MR, authorId: AUTHOR, workspaceId: WS, projectId: PROJECT, headRevisionId: HEAD };

function trigger(over: {
  effective?: 'off' | 'warn' | 'block';
  styleguide?: unknown;
  principal?: () => Promise<unknown>;
  budget?: () => Promise<void>;
  visible?: number;
  waiting?: number;
  inserted?: number;
  stale?: Array<{ id: string; agentRunId: string | null }>;
} = {}) {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ locale: 'ru' })) },
    mergeRequest: { count: vi.fn(async () => over.visible ?? 1) },
    mergeRequestCheck: {
      count: vi.fn(async () => over.waiting ?? 0),
      createMany: vi.fn(async () => ({ count: over.inserted ?? 1 })),
      findMany: vi.fn(async () => over.stale ?? []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'run-1', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    aiAgent: { findUnique: vi.fn(async () => null) },
  };
  const checks = { ceiling: 'warn', policyFor: vi.fn(async () => ({ effective: over.effective ?? 'warn' })) };
  const skills = {
    effectiveStyleguide: vi.fn(async () =>
      'styleguide' in over ? over.styleguide : { row: { id: 'sg-1' }, rules: RULES, scope: 'workspace' },
    ),
  };
  const usage = { assertWithinBudget: vi.fn(over.budget ?? (async () => undefined)) };
  const access = { principalFor: vi.fn(over.principal ?? (async () => ({ userId: AUTHOR }))), requireRole: vi.fn(async () => undefined) };
  const permissions = { scopeFor: vi.fn(async () => ({ workspaceId: WS, bypass: true })), audienceScope: vi.fn(async (s: unknown) => s) };
  const producer = { enqueue: vi.fn(async () => undefined) };
  const config = { get: () => 20 };
  const sweeper = new LintTriggerSweeper(
    prisma as never,
    checks as never,
    skills as never,
    usage as never,
    access as never,
    permissions as never,
    producer as never,
    config as never,
  );
  const inserted = () => (prisma.mergeRequestCheck.createMany.mock.calls as unknown as Array<[{ data: Array<Record<string, unknown>> }]>).map((c) => c[0].data[0]);
  return { sweeper, prisma, producer, usage, inserted };
}

describe('LintTriggerSweeper', () => {
  it("queues one run as the author, of the head it settled, and links it to the check", async () => {
    const t = trigger();
    const checkId = await t.sweeper.check(CANDIDATE);
    expect(checkId).toBe(t.inserted()[0].id);
    expect(t.inserted()[0]).toMatchObject({ status: 'pending', reason: null, kind: 'lint', headRevisionId: HEAD, styleguideId: 'sg-1' });
    expect(t.prisma.agentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentKey: 'linter',
        trigger: 'merge-request',
        createdBy: AUTHOR,
        locale: 'ru',
        input: { lint: { mergeRequestId: MR, headRevisionId: HEAD, checkId } },
      }),
    });
    expect(t.prisma.mergeRequestCheck.update).toHaveBeenCalledWith({ where: { id: checkId }, data: { agentRunId: 'run-1' } });
    expect(t.producer.enqueue).toHaveBeenCalledWith('run-1');
  });

  it('does nothing when another sweep already claimed the head', async () => {
    const t = trigger({ inserted: 0 });
    expect(await t.sweeper.check(CANDIDATE)).toBeNull();
    expect(t.prisma.agentRun.create).not.toHaveBeenCalled();
    expect(t.producer.enqueue).not.toHaveBeenCalled();
  });

  it('supersedes an older waiting check and cancels its run before it costs anything', async () => {
    const t = trigger({ stale: [{ id: 'old-check', agentRunId: 'old-run' }] });
    await t.sweeper.check(CANDIDATE);
    expect(t.prisma.mergeRequestCheck.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-check'] }, status: 'pending' },
      data: { status: 'skipped', reason: 'superseded' },
    });
    expect(t.prisma.agentRun.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-run'] }, status: 'pending' },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
  });

  it('records why it did not call the model', async () => {
    const cases: Array<[Parameters<typeof trigger>[0], string, string]> = [
      [{ styleguide: null }, 'skipped', 'no-styleguide'],
      [{ styleguide: { row: { id: 'sg' }, rules: [{ ...RULES[0], enabled: false }] } }, 'skipped', 'no-styleguide'],
      [{ principal: async () => Promise.reject(new Error('disabled')) }, 'skipped', 'author-unavailable'],
      [{ visible: 0 }, 'skipped', 'restricted'],
      [{ budget: async () => Promise.reject(new Error('spent')) }, 'error', 'budget'],
    ];
    for (const [over, status, reason] of cases) {
      const t = trigger(over);
      await t.sweeper.check(CANDIDATE);
      expect(t.inserted()[0]).toMatchObject({ status, reason });
      expect(t.prisma.agentRun.create).not.toHaveBeenCalled();
    }
  });

  it('records nothing under an off policy or a full queue, so a later tick can try again', async () => {
    for (const over of [{ effective: 'off' as const }, { waiting: 20 }]) {
      const t = trigger(over);
      expect(await t.sweeper.check(CANDIDATE)).toBeNull();
      expect(t.prisma.mergeRequestCheck.createMany).not.toHaveBeenCalled();
    }
  });

  it('lints again by dropping only a finished check of the head, and refuses while one waits', async () => {
    const t = trigger();
    const prisma = t.prisma as unknown as Record<string, Record<string, unknown>>;
    prisma.mergeRequest.findUnique = vi.fn(async () => ({
      id: MR,
      status: 'open',
      authorId: AUTHOR,
      sourceBranch: { headRevisionId: HEAD },
      document: { workspaceId: WS, projectId: PROJECT },
    }));
    prisma.mergeRequestCheck.findFirst = vi.fn(async () => null);
    await t.sweeper.relint(MR);
    expect(t.prisma.mergeRequestCheck.deleteMany).toHaveBeenCalledWith({
      where: { mergeRequestId: MR, kind: 'lint', headRevisionId: HEAD, status: { not: 'pending' } },
    });
    expect(t.producer.enqueue).toHaveBeenCalled();

    prisma.mergeRequestCheck.findFirst = vi.fn(async () => ({ id: 'waiting' }));
    await expect(t.sweeper.relint(MR)).rejects.toMatchObject({ status: 409 });
  });

  it('costs nothing at all on a deployment that lints nothing', async () => {
    const t = trigger();
    (t.sweeper as unknown as { checks: { ceiling: string } }).checks.ceiling = 'off';
    const raw = vi.fn();
    (t.prisma as unknown as { $queryRaw: unknown }).$queryRaw = raw;
    await t.sweeper.sweep();
    expect(raw).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

function publisher(over: {
  claimed?: number;
  runStatus?: string;
  finishedAt?: Date | null;
  sourceHead?: string;
  mrStatus?: string;
  findings?: AgentFinding[];
  prior?: Array<{ id: string; ruleId: string; anchor: unknown; resolved: boolean }>;
} = {}) {
  const writes: Array<[string, unknown]> = [];
  const tx = {
    mergeRequestThread: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        writes.push(['thread.create', data]);
        return { id: `new-${writes.length}` };
      }),
      update: vi.fn(async (args: unknown) => writes.push(['thread.update', args])),
      updateMany: vi.fn(async (args: unknown) => writes.push(['thread.resolve', args])),
    },
    mergeRequestComment: { create: vi.fn(async ({ data }: { data: unknown }) => writes.push(['comment.create', data])) },
  };
  const prisma = {
    $queryRaw: vi.fn(async () => [{ id: 'check-1', runStatus: over.runStatus ?? 'succeeded', finishedAt: 'finishedAt' in over ? over.finishedAt : new Date() }]),
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    mergeRequestCheck: {
      updateMany: vi.fn(async () => ({ count: over.claimed ?? 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'check-1', mergeRequestId: MR, headRevisionId: HEAD, agentRunId: 'run-1' })),
      update: vi.fn(async (args: unknown) => writes.push(['check.update', args])),
    },
    agentRun: { findUniqueOrThrow: vi.fn(async () => ({ id: 'run-1', createdBy: AUTHOR, locale: 'en', findings: over.findings ?? [] })) },
    mergeRequest: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: MR,
        documentId: DOC,
        status: over.mrStatus ?? 'open',
        sourceBranch: { headRevisionId: over.sourceHead ?? HEAD },
        document: { workspaceId: WS },
      })),
    },
    mergeRequestThread: { findMany: vi.fn(async () => over.prior ?? []) },
  };
  const events = { publish: vi.fn(async () => undefined) };
  const sweeper = new LintPublishSweeper(prisma as never, events as never);
  const checkUpdate = () => writes.filter(([k]) => k === 'check.update').map(([, v]) => (v as { data: unknown }).data);
  return { sweeper, prisma, events, writes, checkUpdate };
}

const styleFinding = (ruleId: string, quote: string, severity: AgentFinding['severity'] = 'error'): AgentFinding => ({
  kind: 'style',
  severity,
  title: `rule ${ruleId}`,
  detail: 'why',
  documentIds: [DOC],
  documentTitles: ['Saving'],
  ruleId,
  anchor: { type: 'text', revisionId: HEAD, quote },
});

describe('LintPublishSweeper', () => {
  it('publishes a check once: a lost claim writes nothing', async () => {
    const p = publisher({ claimed: 0, findings: [styleFinding('ui-verbs', 'click on')] });
    await p.sweeper.sweep();
    expect(p.writes).toEqual([]);
    expect(p.events.publish).not.toHaveBeenCalled();
  });

  it('opens one anchored, resolvable linter thread per violation, as the author', async () => {
    const p = publisher({ findings: [styleFinding('ui-verbs', 'click on'), styleFinding('no-we', 'We do', 'info')] });
    await p.sweeper.sweep();
    const threads = p.writes.filter(([k]) => k === 'thread.create').map(([, d]) => d);
    expect(threads).toEqual([
      expect.objectContaining({ source: 'ai', resolvable: true, anchorType: 'text', checkId: 'check-1', ruleId: 'ui-verbs' }),
      expect.objectContaining({ ruleId: 'no-we' }),
    ]);
    const comments = p.writes.filter(([k]) => k === 'comment.create').map(([, d]) => d);
    expect(comments[0]).toMatchObject({ authorId: AUTHOR, agentKey: 'linter' });
    expect(p.checkUpdate()).toEqual([{ status: 'failed', reason: null, counts: { error: 1, warning: 0, suggestion: 1 } }]);
    expect(p.events.publish).toHaveBeenCalledWith({ type: 'merge-request.updated', workspaceId: WS, documentId: DOC, subjectId: MR });
  });

  it('reads only lint threads, keeps a standing one on the new check and resolves a fixed one', async () => {
    const p = publisher({
      findings: [styleFinding('ui-verbs', 'click on')],
      prior: [
        { id: 't-standing', ruleId: 'ui-verbs', anchor: { type: 'text', revisionId: OLD_HEAD, quote: 'click on' }, resolved: false },
        { id: 't-fixed', ruleId: 'no-we', anchor: { type: 'text', revisionId: OLD_HEAD, quote: 'We do' }, resolved: false },
      ],
    });
    await p.sweeper.sweep();
    expect(p.prisma.mergeRequestThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mergeRequestId: MR, checkId: { not: null }, ruleId: { not: null } } }),
    );
    expect(p.writes.find(([k]) => k === 'thread.create')).toBeUndefined();
    expect(p.writes.find(([k]) => k === 'thread.update')?.[1]).toMatchObject({
      where: { id: 't-standing' },
      data: { checkId: 'check-1', anchor: { revisionId: HEAD } },
    });
    expect(p.writes.find(([k]) => k === 'thread.resolve')?.[1]).toMatchObject({
      where: { id: { in: ['t-fixed'] }, resolved: false },
      data: { resolved: true, resolvedBy: null },
    });
  });

  it('passes a clean head, and resolves what earlier pushes reported', async () => {
    const p = publisher({ prior: [{ id: 't-1', ruleId: 'ui-verbs', anchor: { type: 'text', revisionId: OLD_HEAD, quote: 'click on' }, resolved: false }] });
    await p.sweeper.sweep();
    expect(p.checkUpdate()).toEqual([{ status: 'passed', reason: null, counts: { error: 0, warning: 0, suggestion: 0 } }]);
    expect(p.writes.some(([k]) => k === 'thread.resolve')).toBe(true);
  });

  it('posts nothing for a head the branch has moved past, or a run that failed or is a day old', async () => {
    const cases: Array<[Parameters<typeof publisher>[0], Record<string, unknown>]> = [
      [{ sourceHead: OLD_HEAD, findings: [styleFinding('ui-verbs', 'click on')] }, { status: 'skipped', reason: 'superseded' }],
      [{ runStatus: 'failed' }, { status: 'error', reason: 'run-failed' }],
      [{ finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }, { status: 'skipped', reason: 'stale' }],
    ];
    for (const [over, expected] of cases) {
      const p = publisher(over);
      await p.sweeper.sweep();
      expect(p.writes.filter(([k]) => k.startsWith('thread') || k.startsWith('comment'))).toEqual([]);
      expect(p.checkUpdate()[0]).toMatchObject(expected);
    }
  });

  it('keeps the verdict of a merge request that closed, without threads', async () => {
    const p = publisher({ mrStatus: 'merged', findings: [styleFinding('ui-verbs', 'click on')] });
    await p.sweeper.sweep();
    expect(p.writes.filter(([k]) => k.startsWith('thread'))).toEqual([]);
    expect(p.checkUpdate()[0]).toMatchObject({ status: 'failed' });
  });
});

// ---------------------------------------------------------------------------

describe('AgentExecutor linter', () => {
  function executor(over: { targetHead?: string | null; visible?: boolean; hunks?: DiffHunk[] } = {}) {
    const client = {
      chat: vi.fn(async () => JSON.stringify({ violations: [{ ruleId: 'ui-verbs', quote: 'click on Save', message: 'Use select.' }] })),
    };
    const compare = {
      compare: vi.fn(async () => ({
        hunks: over.hunks ?? [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'context', text: 'Old text: click on Cancel.' },
              { kind: 'added', text: 'Now click on Save.' },
            ],
          },
        ],
      })),
      compareWithNothing: vi.fn(async () => ({ hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: 'added', text: 'Now click on Save.' }] }] })),
    };
    const prisma = {
      mergeRequest: {
        findFirst: vi.fn(async () =>
          over.visible === false
            ? null
            : { id: MR, documentId: DOC, targetBranch: { headRevisionId: 'targetHead' in over ? over.targetHead : OLD_HEAD }, document: { title: 'Saving', projectId: PROJECT } },
        ),
      },
    };
    const exec = new AgentExecutor(
      prisma as never,
      {} as never,
      {} as never,
      client as never,
      {} as never,
      { effectiveStyleguide: async () => ({ row: { id: 'sg' }, rules: RULES, scope: 'workspace' }) } as never,
      { getContent: async () => ({ markdown: 'Old text: click on Cancel.\nNow click on Save.', frontmatter: {} }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => 15 } as never,
      { scopeFor: async () => ({ workspaceId: WS, bypass: true }), audienceScope: async (s: unknown) => s } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      compare as never,
    );
    const run = {
      id: 'run-1',
      workspaceId: WS,
      agentKey: 'linter',
      createdBy: AUTHOR,
      locale: 'en',
      input: { lint: { mergeRequestId: MR, headRevisionId: HEAD, checkId: 'check-1' } },
    } as unknown as AgentRun;
    const agent = { key: 'linter', instructions: 'LINT', skillIds: [], config: { enabled: true }, missing: [], enabled: true };
    const report = vi.fn(async () => undefined);
    return { exec, run, agent, client, compare, report };
  }

  it('sends the model only what the merge request added, and anchors to the head it was given', async () => {
    const e = executor();
    const result = await e.exec.run(e.run, e.agent as never, { userId: AUTHOR } as never, e.report);
    expect(e.compare.compare).toHaveBeenCalledWith(DOC, OLD_HEAD, HEAD, 'merge-base', { structural: false });
    const [call, messages] = e.client.chat.mock.calls[0] as unknown as [{ userId: string; operation: string }, Array<{ content: string }>];
    expect(call).toMatchObject({ userId: AUTHOR, operation: 'lint' });
    expect(messages[1].content).toContain('Now click on Save.');
    expect(messages[1].content).not.toContain('click on Cancel');
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'style', ruleId: 'ui-verbs', severity: 'error', anchor: expect.objectContaining({ revisionId: HEAD, quote: 'click on Save' }) }),
    ]);
  });

  it("lints all of a page's first merge request", async () => {
    const e = executor({ targetHead: null });
    await e.exec.run(e.run, e.agent as never, { userId: AUTHOR } as never, e.report);
    expect(e.compare.compareWithNothing).toHaveBeenCalledWith(DOC, HEAD, { structural: false });
  });

  it('calls no model for a change that adds nothing, and refuses a page no longer open to every member', async () => {
    const quiet = executor({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: [{ kind: 'deleted', text: 'gone' }] }] });
    expect((await quiet.exec.run(quiet.run, quiet.agent as never, { userId: AUTHOR } as never, quiet.report)).findings).toEqual([]);
    expect(quiet.client.chat).not.toHaveBeenCalled();

    const hidden = executor({ visible: false });
    await expect(hidden.exec.run(hidden.run, hidden.agent as never, { userId: AUTHOR } as never, hidden.report)).rejects.toThrow();
    expect(hidden.client.chat).not.toHaveBeenCalled();
  });
});
