import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, AgentRunInput } from '@knowledge/contracts';
import { parseMarkdown, readComponentFrontmatter } from '../src/common/frontmatter.js';
import { componentNameFor, draftablePath } from '../src/components/component-match.js';
import { componentFrontmatter, readComponentDraft, sectionHeadings } from '../src/agents/component-draft.js';
import { AgentExecutor } from '../src/agents/agent.executor.js';
import { TemplatesService } from '../src/templates/templates.service.js';
import { ComponentDraftsService } from '../src/components/component-drafts.service.js';
import { ComponentDraftSweeper } from '../src/components/component-draft.sweeper.js';
import { AgentFindingsService } from '../src/ai/agent-findings.service.js';
import type { RepoSnapshot } from '../src/connectors/code-research/repo-snapshot.service.js';

/**
 * Component pages, phase 5 (#236): "Document this component".
 *
 * What a green run does not show: that the page is drafted into the
 * `component` template and keeps every one of its sections, that the
 * `component:` block is computed and names exactly the files asked about, that
 * a duplicate press is refused rather than drafted twice, and that the draft
 * reaches the knowledge base only as a merge request on a hidden page —
 * never as a published one.
 */

const POPOVER = 'apps/web/src/components/ResponsivePopover.vue';
const SOURCE = `<script setup lang="ts">\nconst props = defineProps<{ open: boolean }>()\n</script>\n<template><div /></template>\n`;

function snapshot(files: Record<string, string> = { [POPOVER]: SOURCE }): RepoSnapshot {
  return {
    connectorId: 'c1',
    workspaceId: 'w',
    name: 'app',
    branch: 'main',
    subdir: '',
    host: { owner: 'acme', repo: 'app', origin: 'https://github.com' },
    files: new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])),
    skipped: { oversize: 0, binary: 0 },
    bytes: 0,
    loadedAt: new Date(),
    blobUrl: (path: string, lines?: readonly [number, number?]) =>
      `https://github.com/acme/app/blob/main/${path}${lines ? `#L${lines[0]}` : ''}`,
  } as unknown as RepoSnapshot;
}

const SKELETON = '# Popover\n\n## Purpose\n\nx\n\n## Public surface\n\nx\n\n## Behaviour & invariants\n\nx\n\n## Usage notes\n\nx\n';
const FILLED =
  '# ResponsivePopover\n\n**Source:** `' + POPOVER + '`\n\n' +
  '## Purpose\n\nShows content anchored to a trigger, as a hover card where the pointer can hover and a popover elsewhere.\n\n' +
  '## Public surface\n\n| Name | Kind | Description |\n| --- | --- | --- |\n| open | prop | Whether the popover is shown. |\n\n' +
  '## Behaviour & invariants\n\n- Not determined from the code.\n\n' +
  '## Usage notes\n\n- Do not nest a link inside the trigger button.\n';

describe('names and paths', () => {
  it('names a component after its file, or after its directory for an entry file', () => {
    expect(componentNameFor(POPOVER)).toBe('ResponsivePopover');
    expect(componentNameFor('apps/api/src/billing/index.ts')).toBe('billing');
    expect(componentNameFor('pkg/__init__.py')).toBe('pkg');
    expect(componentNameFor('index.ts')).toBe('index');
  });

  it('takes one repo-relative file and refuses globs, directories and walks out', () => {
    expect(draftablePath(` ./${POPOVER} `)).toBe(POPOVER);
    expect(draftablePath(`/${POPOVER}`)).toBe(POPOVER);
    for (const bad of ['apps/web/**/*.vue', 'apps/web/src/', '../secrets.env', 'a/./b.ts', 'a//b.ts', '']) {
      expect(draftablePath(bad), bad).toBeNull();
    }
  });
});

describe('reading the model\'s draft', () => {
  const snap = snapshot();

  it('keeps a body that fills every section, drops frontmatter it wrote, and cites what it read', () => {
    const body = readComponentDraft(
      {
        markdown: `---\ncomponent:\n  paths: [elsewhere.ts]\n---\n${FILLED}`,
        sources: [
          { path: POPOVER, startLine: 2, endLine: 2, note: 'props' },
          { path: 'not/read.ts', startLine: 1 },
        ],
      },
      SKELETON,
      snap,
      new Set([POPOVER]),
      [POPOVER],
    )!;
    expect(body.markdown.startsWith('# ResponsivePopover')).toBe(true);
    expect(body.markdown).not.toContain('elsewhere.ts');
    expect(body.sources.map((s) => s.title)).toEqual([`${POPOVER}:2`]);
  });

  it('refuses a body that drops a section of the template', () => {
    const dropped = FILLED.replace(/## Usage notes[\s\S]*$/, '');
    expect(sectionHeadings(SKELETON)).toContain('Usage notes');
    expect(readComponentDraft({ markdown: dropped }, SKELETON, snap, new Set([POPOVER]), [POPOVER])).toBeNull();
    expect(readComponentDraft({ markdown: 'too short' }, SKELETON, snap, new Set(), [POPOVER])).toBeNull();
  });

  it('cites the declared files when the model cited none', () => {
    const body = readComponentDraft({ markdown: FILLED }, SKELETON, snap, new Set([POPOVER]), [POPOVER])!;
    expect(body.sources.map((s) => s.url)).toEqual([`https://github.com/acme/app/blob/main/${POPOVER}`]);
  });

  it('computes the component block: every file, the repository read, the symbols asked for', () => {
    const fm = componentFrontmatter(
      { tags: ['component'], component: { repository: 'acme/app', paths: [POPOVER], symbols: ['x'] }, relations: [] },
      {
        repository: 'acme/app',
        component: { name: 'Popover', paths: [POPOVER, 'apps/web/src/components/popover.css'], symbols: ['ResponsivePopover'] },
        source: 'https://github.com/acme/app/blob/main/' + POPOVER,
        generatedBy: 'archaeologist',
      },
    );
    expect(fm.tags).toEqual(['component']);
    expect(readComponentFrontmatter(fm)).toEqual({
      repository: 'acme/app',
      paths: [POPOVER, 'apps/web/src/components/popover.css'],
      symbols: ['ResponsivePopover'],
      name: null,
    });
    expect(fm).toMatchObject({ generatedBy: 'archaeologist' });
  });
});

describe('the archaeologist documenting a component', () => {
  function executor(answer: string, files?: Record<string, string>) {
    const templates = new TemplatesService(
      { pageTemplate: { findFirst: async () => null }, user: { findUnique: async () => null } } as never,
      {} as never,
      {} as never,
    );
    const client = { chat: vi.fn(), runWithTools: vi.fn(async () => ({ content: answer })) };
    const code = { definitions: () => [], execute: vi.fn(), outlineFile: vi.fn() };
    const exec = new AgentExecutor(
      // The learnings lookup asks which project the connector is in.
      { connector: { findFirst: async () => null } } as never,
      {} as never,
      {} as never,
      client as never,
      { definitions: () => [], execute: vi.fn() } as never,
      { renderPrompt: () => '', forTurn: async () => [] } as never,
      {} as never,
      {} as never,
      code as never,
      { open: async () => snapshot(files) } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
      { promptFor: async () => '', dismissedPrompt: async () => '' } as never,
      {} as never,
      templates,
    );
    const input: AgentRunInput = { connectorId: 'c1', component: { name: 'ResponsivePopover', paths: [POPOVER] } };
    const run = { id: 'run-1', workspaceId: 'w', agentKey: 'archaeologist', createdBy: 'u', locale: 'en', input } as unknown as AgentRun;
    const agent = { key: 'archaeologist', instructions: 'read code', skillIds: [], config: { enabled: true }, missing: [] };
    return { exec, run, agent, client, code };
  }

  it('fills the component template and computes the frontmatter, with the drafting operation', async () => {
    const { exec, run, agent, client, code } = executor(JSON.stringify({ markdown: FILLED, sources: [] }));
    const result = await exec.run(run, agent as never, { userId: 'u' } as never, async () => undefined);

    // The model was shown the template's sections and the file, wrapped untrusted.
    const [call, messages] = client.runWithTools.mock.calls[0] as unknown as [{ operation: string }, Array<{ content: string }>];
    expect(call.operation).toBe('component-draft');
    expect(messages[1].content).toContain('## Public surface');
    expect(messages[1].content).toContain('defineProps');
    expect(code.outlineFile).not.toHaveBeenCalled(); // no excavation ranking

    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding.documentIds).toEqual([]);
    expect(finding.draft?.title).toBe('ResponsivePopover');
    expect(finding.draft?.template).toEqual({ ref: 'builtin:component', version: 1 });
    const page = parseMarkdown(finding.draft!.markdown);
    expect(readComponentFrontmatter(page.data)).toMatchObject({ repository: 'acme/app', paths: [POPOVER] });
    // The template's relation survives: the page DESCRIBES component:ResponsivePopover.
    expect(JSON.stringify(page.data.relations)).toContain('component:ResponsivePopover');
    expect(page.data).not.toHaveProperty('template');
    expect(page.body).toContain('## Usage notes');
  });

  it('fails the run on a file the repository does not have, before any model call', async () => {
    const { exec, run, agent, client } = executor('{}', { 'other.ts': 'x' });
    await expect(exec.run(run, agent as never, { userId: 'u' } as never, async () => undefined)).rejects.toThrow(
      'agent.component.pathsMissing',
    );
    expect(client.runWithTools).not.toHaveBeenCalled();
  });

  it('fails the run when the draft drops a section', async () => {
    const { exec, run, agent } = executor(JSON.stringify({ markdown: FILLED.replace(/## Usage notes[\s\S]*$/, '') }));
    await expect(exec.run(run, agent as never, { userId: 'u' } as never, async () => undefined)).rejects.toThrow(
      'agent.component.draftUnusable',
    );
  });
});

describe('asking for a draft', () => {
  function drafts(opts: { declared?: boolean; prior?: Array<Record<string, unknown>>; model?: boolean; connectors?: number } = {}) {
    const created: Array<{ data: Record<string, unknown> }> = [];
    const prisma = {
      componentDeclaration: {
        findMany: vi.fn(async () => (opts.declared ? [{ documentId: 'decl', paths: [POPOVER] }] : [])),
      },
      agentRun: {
        findMany: vi.fn(async () => opts.prior ?? []),
        count: vi.fn(async () => 0),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return { id: 'run-new' };
        }),
      },
      mergeRequest: { count: vi.fn(async () => 1) },
      aiAgent: { findUnique: async () => null },
      document: { findFirst: vi.fn(async () => ({ projectId: 'p1' })) },
      project: { findFirst: vi.fn(async () => ({ id: 'p1' })) },
    };
    const registry = {
      resolve: async () => ({ enabled: true, config: { enabled: opts.model !== false }, missing: [] }),
    };
    const producer = { enqueue: vi.fn(async () => undefined) };
    const components = {
      codeConnectors: async () =>
        Array.from({ length: opts.connectors ?? 1 }, (_, i) => ({ id: `c${i + 1}`, repoUrl: `https://github.com/acme/app${i}` })),
    };
    const permissions = { scopeFor: async (_p: unknown, workspaceId: string) => ({ workspaceId, bypass: true }) };
    const service = new ComponentDraftsService(
      prisma as never,
      registry as never,
      { assertWithinBudget: async () => undefined } as never,
      producer as never,
      components as never,
      permissions as never,
    );
    return { service, prisma, producer, created };
  }
  const principal = { userId: 'u', locale: 'en' } as never;

  it('queues an archaeologist run with the component settled: files, name, place and subject', async () => {
    const { service, producer, created } = drafts();
    const res = await service.start(principal, { workspaceId: 'w', paths: [`./${POPOVER}`], parentId: 'parent' });
    expect(res).toEqual({ runId: 'run-new', connectorId: 'c1', title: 'ResponsivePopover', paths: [POPOVER] });
    expect(created[0].data).toMatchObject({
      agentKey: 'archaeologist',
      subjectKey: `component:c1:${POPOVER}`,
      createdBy: 'u',
      input: { connectorId: 'c1', component: { name: 'ResponsivePopover', paths: [POPOVER], projectId: 'p1', parentId: 'parent' } },
    });
    expect(producer.enqueue).toHaveBeenCalledWith('run-new');
  });

  it('refuses a glob, a second repository it cannot choose between, and a workspace with no model', async () => {
    await expect(drafts().service.start(principal, { workspaceId: 'w', paths: ['apps/**/*.vue'] })).rejects.toThrow(
      'error.component.draftPath',
    );
    await expect(drafts({ connectors: 2 }).service.start(principal, { workspaceId: 'w', paths: [POPOVER] })).rejects.toThrow(
      'error.component.draftAmbiguous',
    );
    await expect(drafts({ model: false }).service.start(principal, { workspaceId: 'w', paths: [POPOVER] })).rejects.toThrow(
      'error.component.draftNoModel',
    );
  });

  it('refuses a file a page already declares, a draft still running, and one waiting for review', async () => {
    const documented = drafts({ declared: true });
    await expect(documented.service.start(principal, { workspaceId: 'w', paths: [POPOVER] })).rejects.toMatchObject({
      response: { reason: 'already-documented', documentIds: ['decl'] },
    });
    expect(documented.created).toHaveLength(0);

    const running = drafts({ prior: [{ id: 'r1', status: 'running', input: {}, findings: [], finishedAt: null }] });
    await expect(running.service.start(principal, { workspaceId: 'w', paths: [POPOVER] })).rejects.toMatchObject({
      response: { reason: 'in-flight', runId: 'r1' },
    });

    const reviewing = drafts({
      prior: [
        {
          id: 'r2',
          status: 'succeeded',
          input: { publishedAt: new Date().toISOString() },
          findings: [{ mergeRequestId: 'mr-1' }],
          finishedAt: new Date(),
        },
      ],
    });
    await expect(reviewing.service.start(principal, { workspaceId: 'w', paths: [POPOVER] })).rejects.toMatchObject({
      response: { reason: 'already-proposed', mergeRequestId: 'mr-1' },
    });
  });

  it('drafts again once an earlier draft was merged or closed', async () => {
    const { service, prisma, created } = drafts({
      prior: [
        { id: 'r2', status: 'succeeded', input: { publishedAt: 'x' }, findings: [{ mergeRequestId: 'mr-1' }], finishedAt: new Date() },
      ],
    });
    prisma.mergeRequest.count.mockResolvedValue(0);
    await service.start(principal, { workspaceId: 'w', paths: [POPOVER] });
    expect(created).toHaveLength(1);
  });
});

describe('publishing the draft', () => {
  const draftFinding: AgentFinding = {
    kind: 'gap',
    severity: 'info',
    title: 'Document ResponsivePopover',
    detail: 'drafted',
    documentIds: [],
    documentTitles: [],
    sources: [{ kind: 'web', url: 'https://github.com/acme/app/blob/main/x', site: 'github.com', title: POPOVER }],
    draft: { title: 'ResponsivePopover', markdown: '---\ncomponent:\n  paths: [x]\n---\n# body', template: { ref: 'builtin:component', version: 1 } },
  };

  function findingsService(run: Record<string, unknown>) {
    const sql: string[] = [];
    const prisma = {
      agentRun: { findUnique: vi.fn(async () => run) },
      $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
        sql.push(strings.join('?'));
        return 1;
      }),
      withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      documentRevision: { findUnique: async () => ({ s3Key: 'k' }) },
      document: { update: vi.fn(async () => undefined) },
    };
    const documents = {
      createDocument: vi.fn(async () => ({ documentId: 'new-doc' })),
      createBranch: vi.fn(async () => undefined),
      createRevision: vi.fn(async () => ({ revisionId: 'rev' })),
      finalizeRevision: vi.fn(async () => undefined),
    };
    const storage = { putObjectText: vi.fn(async () => undefined) };
    const mergeRequests = { create: vi.fn(async () => ({ mergeRequest: { mergeRequestId: 'mr-new' } })) };
    const service = new AgentFindingsService(
      prisma as never,
      storage as never,
      documents as never,
      {} as never,
      mergeRequests as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, documents, storage, mergeRequests, sql };
  }
  const baseRun = {
    id: 'run-1',
    workspaceId: 'w',
    agentKey: 'archaeologist',
    createdBy: 'u',
    locale: 'en',
    input: { connectorId: 'c1', component: { name: 'ResponsivePopover', paths: [POPOVER] } },
    findings: [draftFinding],
  };

  it('opens the draft as a merge request on a hidden page, byte for byte, as the caller', async () => {
    const { service, prisma, documents, storage, mergeRequests } = findingsService(baseRun);
    const res = await service.proposePage('w', 'run-1', 0, { userId: 'u' } as never, { projectId: 'p1', parentId: 'parent' });
    expect(res).toEqual({ mergeRequestId: 'mr-new', documentId: 'new-doc', title: 'ResponsivePopover' });
    expect(documents.createDocument).toHaveBeenCalledWith(
      {
        workspaceId: 'w',
        projectId: 'p1',
        title: 'ResponsivePopover',
        parentId: 'parent',
        template: { ref: 'builtin:component', version: 1, provenanceOnly: true },
      },
      'u',
    );
    // No inline content: the page has no head until the merge request merges.
    expect((documents.createDocument.mock.calls[0] as unknown[])[0]).not.toHaveProperty('content');
    expect(storage.putObjectText).toHaveBeenCalledWith('k', draftFinding.draft!.markdown, 'text/markdown');
    expect(mergeRequests.create).toHaveBeenCalledWith(
      'new-doc',
      expect.objectContaining({ title: 'ResponsivePopover' }),
      'u',
      expect.objectContaining({ provenance: 'agent' }),
    );
    expect(prisma.document.update).toHaveBeenCalledWith({ where: { id: 'new-doc' }, data: { pendingMergeRequestId: 'mr-new' } });
  });

  it('refuses to open a draft twice, and never publishes a component draft directly', async () => {
    const proposed = findingsService({ ...baseRun, findings: [{ ...draftFinding, mergeRequestId: 'mr-1' }] });
    await expect(proposed.service.proposePage('w', 'run-1', 0, { userId: 'u' } as never, { projectId: 'p1' })).rejects.toMatchObject({
      response: { reason: 'already-proposed' },
    });
    const direct = findingsService(baseRun);
    await expect(direct.service.createPage('w', 'run-1', 0, { userId: 'u' } as never)).rejects.toThrow('error.ai.findingComponentDraft');
    expect(direct.documents.createDocument).not.toHaveBeenCalled();
  });

  function sweeper(run: Record<string, unknown>, role: 'editor' | 'viewer' = 'editor') {
    const prisma = {
      connector: { findFirst: async () => ({ projectId: 'conn-project', parentId: 'conn-parent' }) },
      project: { findFirst: async () => ({ id: 'first' }) },
    };
    const findings = { proposePage: vi.fn(async () => ({ mergeRequestId: 'mr', documentId: 'd', title: 't' })) };
    const access = {
      principalFor: async (userId: string) => ({ userId }),
      requireRole: async () => {
        if (role !== 'editor') throw new Error('forbidden');
      },
    };
    const s = new ComponentDraftSweeper(prisma as never, findings as never, access as never);
    return { s, findings, full: run as unknown as AgentRun };
  }

  it('opens a finished draft in the connector\'s destination, as the person who asked', async () => {
    const { s, findings, full } = sweeper(baseRun);
    await s.publish(full);
    expect(findings.proposePage).toHaveBeenCalledWith('w', 'run-1', 0, { userId: 'u' }, { projectId: 'conn-project', parentId: 'conn-parent' });
  });

  it('places it where it was asked for, and leaves it unopened for an owner who can no longer edit', async () => {
    const placed = { ...baseRun, input: { connectorId: 'c1', component: { name: 'X', paths: [POPOVER], projectId: 'p9' } } };
    const { s, findings, full } = sweeper(placed);
    await s.publish(full);
    expect(findings.proposePage).toHaveBeenCalledWith('w', 'run-1', 0, { userId: 'u' }, { projectId: 'p9', parentId: null });

    const demoted = sweeper(baseRun, 'viewer');
    await expect(demoted.s.publish(demoted.full)).rejects.toThrow('forbidden');
    expect(demoted.findings.proposePage).not.toHaveBeenCalled();
  });

  it('ignores an excavation, which has no component', async () => {
    const { s, findings, full } = sweeper({ ...baseRun, input: { connectorId: 'c1' } });
    await s.publish(full);
    expect(findings.proposePage).not.toHaveBeenCalled();
  });
});
