import { HttpException, HttpStatus } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import { type AgentFinding, type AgentRunComponent, type AgentRunInput, type Locale, builtInTemplateRef } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { CODE_TOOLS } from '../../assistant/assistant-tool-types.js';
import { wrapUntrusted } from '../../common/untrusted.js';
import { visibilityWhere, type AccessScope } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import { runCodeReadingLoop } from '../code-reading-loop.js';
import { composeFrontmatter } from '../../common/frontmatter.js';
import type { Principal } from '../../auth/principal.js';
import { CODE_OUTPUT_CONTRACT, DIGEST_CONTRACT, MAX_CANDIDATE_FILES, MAX_DIGEST_INPUT_CHARS, MAX_FINDINGS_PER_FILE, MAX_PREVIEW_CHARS, MAX_RANKED_FILES, digestInput, headingDigest, declaredText, isCovered, isWikiCovered, wikiModulePaths, rankCandidates, readExcavation, selectRepoDocs, type Candidate } from '../archaeology.js';
import { COMPONENT_DRAFT_CONTRACT, componentFrontmatter, componentPreviews, readComponentDraft } from '../component-draft.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf, runBrief } from '../agent-services.js';

/** Workspace pages the archaeologist reads as "already declared" — linked to the connector or under its destination. */
const MAX_DECLARED_PAGES = 40;

export const archaeologistRunner: AgentRunner = { key: 'archaeologist', run: excavate };

/**
 * Reverse-documents one connected repository (docs/features/31).
 *
 * Four stages, three of them queries. `snapshot` opens the repository through
 * the same cache the chat tools use. `docs` gathers what is already declared
 * — the repository's own documents and the workspace pages linked to the
 * connector or under its destination — and asks the model once to digest it.
 * `candidates` ranks every source file by how much it decides and drops the
 * ones the declared text mentions, in code, with no model. Only `reading` is
 * judgement: one tool loop per uncovered file, with the file in front of the
 * model and the tools to follow its imports, returning the page it would
 * write. A person creates that page; the run never does.
 *
 * Re-running is what makes this converge rather than repeat: a page created
 * from a finding lands under the connector's destination, is read as declared
 * next time, and its file is no longer a candidate.
 */
async function excavate(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = (run.input ?? {}) as AgentRunInput;
  if (input.component) return draftComponent(svc, run, agent, input.component, principal, report);
  await report({ stage: 'snapshot', progress: 0.05 });
  // The API settled the scope at enqueue; a scheduled run never went through
  // it, so the only-repository fallback lives here too.
  const connectorId = input.connectorId ?? (await onlyRepository(svc, run.workspaceId));
  if (!connectorId) throw new Error(t('error.ai.agentNeedsConnector', { key: agent.key }));
  // The owner's scope clamped to the workspace, like every page this run
  // reads: findings are read by the workspace, so a restricted project's
  // repository reads as not found (#553).
  const scope = await svc.runScope(run, principal);
  const snapshot = await svc.snapshots.open(connectorId, scope);
  const connector = await svc.prisma.connector.findUnique({
    where: { id: connectorId },
    select: { id: true, name: true, projectId: true, parentId: true },
  });

  // --- what is already declared: repo docs + workspace pages, and a digest of them
  await report({ stage: 'docs', progress: 0.15 });
  const docs = selectRepoDocs(snapshot.files);
  const pages = connector ? await destinationPages(svc, scope, connector) : [];
  // Lower-cased once: coverage is a substring test against this, per file.
  const declared = [...docs.map((d) => d.text), ...pages.map(declaredText)].join('\n').toLowerCase();
  // Modules the repo wiki documents as a whole (docs/features/46): their
  // entry files are declared by the module page; the logic below them is not.
  const wikiModules = wikiModulePaths(pages);
  const counts = { docs: docs.length, pages: pages.length, repository: snapshot.name };

  // 'tools' is a preference, not a prerequisite — the curator's rule.
  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  const modelUsable = agent.config.enabled && blocking.length === 0;
  const call = {
    config: agent.config,
    userId: run.createdBy,
    operation: 'agent' as const,
    locale: run.locale as Locale,
  };

  let digest = headingDigest(docs, pages);
  if (modelUsable && (docs.length > 0 || pages.length > 0)) {
    try {
      const raw = await svc.client.chat(
        call,
        [
          { role: 'system', content: DIGEST_CONTRACT },
          { role: 'user', content: digestInput(docs, pages, MAX_DIGEST_INPUT_CHARS) },
        ],
        { json: true },
      );
      const topics = parseModelJson(raw)?.topics;
      if (Array.isArray(topics) && topics.length > 0) {
        digest = topics
          .filter((topic): topic is { name: string; summary?: string; paths?: unknown } =>
            !!topic && typeof (topic as { name?: unknown }).name === 'string',
          )
          .map((topic) => {
            const paths = Array.isArray(topic.paths) ? topic.paths.filter((p) => typeof p === 'string') : [];
            return `- ${topic.name}: ${topic.summary ?? ''}${paths.length ? ` (${paths.join(', ')})` : ''}`;
          })
          .join('\n');
      }
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return { summary: t('agent.archaeology.budgetSpent', { files: 0, candidates: 0 }), findings: [] };
      }
      svc.logger.warn(`Archaeologist digest failed: ${String(error)}`);
      await report({ warning: t('agent.archaeology.digestSkipped') });
    }
  }

  // --- which files decide something nothing declares: ranked, then outlined, in code
  await report({ stage: 'candidates', progress: 0.3 });
  const candidates: Candidate[] = [];
  for (const candidate of rankCandidates(snapshot.files, MAX_RANKED_FILES)) {
    const outline = await svc.code.outlineFile(snapshot, candidate.path);
    const names = outline?.symbols.filter((s) => s.exported).map((s) => s.name) ?? [];
    if (isWikiCovered(candidate.path, wikiModules) || isCovered(declared, candidate.path, names)) continue;
    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATE_FILES) break;
  }

  if (!modelUsable) {
    await report({ warning: t('agent.archaeology.noModel') });
    return { summary: t('agent.archaeology.noModel'), findings: [] };
  }
  if (candidates.length === 0) return { summary: t('agent.archaeology.noCandidates', counts), findings: [] };

  // --- the judgement: one tool loop per file
  const skills = await svc.guidance(run, agent);
  const tools = [...svc.readTools.definitions(), ...svc.code.definitions()];
  const toolCtx = svc.toolCtx(run, principal);
  const findings: AgentFinding[] = [];
  let filesRead = 0;

  for (const [at, candidate] of candidates.entries()) {
    await report({ stage: 'reading', progress: 0.3 + (0.65 * at) / candidates.length });
    const execute = (name: string, args: Record<string, unknown>) =>
      CODE_TOOLS.has(name)
        ? // The run is scoped to one repository: whatever connectorId the
          // model wrote, this is the one it reads.
          svc.code.execute(name, { ...args, connectorId }, toolCtx)
        : svc.readTools.execute(name, args, toolCtx);

    const text = Buffer.from(snapshot.files.get(candidate.path) ?? new Uint8Array()).toString('utf8');
    const outline = await svc.code.outlineFile(snapshot, candidate.path);
    const declares = outline?.symbols.length
      ? `\nIt declares: ${outline.symbols
          .slice(0, 40)
          .map((s) => `${s.kind} ${s.name}${s.exported ? ' (exported)' : ''}`)
          .join(', ')}.`
      : '';
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${agent.instructions}\n\n${CODE_OUTPUT_CONTRACT}${skills}` },
      {
        role: 'user',
        content:
          runBrief(input) +
          `Repository: ${snapshot.name} (${snapshot.host.owner}/${snapshot.host.repo} @ ${snapshot.branch}). ` +
          `Every code tool call reads this repository; connectorId is ${connectorId}.\n\n` +
          `What the repository's documents and the workspace's pages already declare:\n${digest || '(nothing)'}\n\n` +
          `The file nothing declares: ${candidate.path} (${candidate.lines} lines).${declares}\n\n` +
          `The first part of the file (use code_read for the rest, and code_search / code_outline for what it ` +
          `imports):\n<file path=${JSON.stringify(candidate.path)}>\n${text.slice(0, MAX_PREVIEW_CHARS)}\n</file>`,
      },
    ];

    try {
      // Every path the model actually opened. A finding may cite only these:
      // a path seen in a tree listing is not a path that was read.
      const { content: raw, readPaths } = await runCodeReadingLoop({
        client: svc.client,
        call,
        messages,
        tools,
        execute,
        toolless: agent.missing.includes('tools'),
        json: true,
        seen: [candidate.path],
      });
      filesRead += 1;
      const proposals = parseModelJson(raw)?.findings;
      let kept = 0;
      for (const proposal of Array.isArray(proposals) ? proposals : []) {
        const finding = readExcavation(proposal, snapshot, readPaths);
        if (!finding) continue;
        findings.push(finding);
        if (++kept >= MAX_FINDINGS_PER_FILE) break;
      }
    } catch (error) {
      const budgetSpent = () => t('agent.archaeology.budgetSpent', { files: filesRead, candidates: candidates.length });
      if (await svc.stopsPass(error, report, budgetSpent)) break;
      svc.logger.warn(`Archaeologist could not read ${candidate.path}: ${String(error)}`);
      await report({ warning: t('agent.warning.fileNotRead', { path: candidate.path, error: reasonOf(error) }) });
    }
    if (findings.length >= MAX_FINDINGS) break;
  }

  const kept = findings.slice(0, MAX_FINDINGS);
  return {
    summary: t('agent.archaeology.summary', { ...counts, files: filesRead, findings: kept.length }),
    findings: kept,
  };
}

/**
 * "Document this component" (#236, phase 5): one page, from the files the
 * run was asked about, written into the `component` template.
 *
 * The archaeologist's reading loop over a different question. The files
 * are given rather than ranked, so nothing here decides what to document,
 * only how: the template is rendered with the component's name and first
 * path, the model fills its sections from the code (`readComponentDraft`
 * refuses a body that drops one), and the frontmatter is computed — the
 * `component:` block names every file the run read. Nothing is written:
 * the draft rides on the finding, and `ComponentDraftSweeper` opens it as a
 * merge request API-side, as the person who asked.
 *
 * Failing loudly is the right answer to every problem here — a missing
 * file, no model, an unusable draft — because a person is waiting on this
 * one run and the failure is what they read.
 */
async function draftComponent(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  component: AgentRunComponent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = (run.input ?? {}) as AgentRunInput;
  if (!input.connectorId) throw new Error(t('error.ai.agentNeedsConnector', { key: agent.key }));
  if (!agent.config.enabled || agent.missing.some((capability) => capability !== 'tools')) {
    throw new Error(t('agent.component.noModel'));
  }
  await report({ stage: 'snapshot', progress: 0.1 });
  const scope = await svc.runScope(run, principal);
  const snapshot = await svc.snapshots.open(input.connectorId, scope);
  // Settled at enqueue against the request, not the archive: the API cannot
  // afford a download per press, and the head may have moved since anyway.
  const missing = component.paths.filter((path) => !snapshot.files.has(path));
  if (missing.length > 0) {
    throw new Error(t('agent.component.pathsMissing', { paths: missing.join(', '), repository: snapshot.name }));
  }

  const ref = builtInTemplateRef('component');
  const repository = `${snapshot.host.owner}/${snapshot.host.repo}`;
  const [template, rendered, skills] = await Promise.all([
    svc.templates.resolve(run.workspaceId, ref),
    svc.templates.render(
      {
        workspaceId: run.workspaceId,
        ref,
        title: component.name,
        values: { name: component.name, path: component.paths[0], repository },
        ...(component.projectId ? { projectId: component.projectId } : {}),
        ...(component.parentId ? { parentId: component.parentId } : {}),
      },
      scope,
      { id: run.createdBy },
    ),
    svc.guidance(run, agent),
  ]);
  const notes = template.parsed.meta.aiInstructions?.trim();
  const files = componentPreviews(snapshot, component.paths)
    .map((f) => `<file path=${JSON.stringify(f.path)} lines=${f.lines}>\n${f.text}\n</file>`)
    .join('\n');
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `${agent.instructions}\n\n${COMPONENT_DRAFT_CONTRACT}${skills}` },
    {
      role: 'user',
      content:
        runBrief(input) +
        `Repository: ${snapshot.name} (${repository} @ ${snapshot.branch}). ` +
        `Every code tool call reads this repository; connectorId is ${input.connectorId}.\n\n` +
        `The component: ${component.name}, declared by ${component.paths.join(', ')}` +
        (component.symbols?.length ? `, documenting only the exports ${component.symbols.join(', ')}` : '') +
        `.\n\nThe page skeleton to fill:\n${wrapUntrusted(rendered.body, 'component_template', 'template')}` +
        (notes ? `\n\nThe template's notes for whoever fills it:\n${wrapUntrusted(notes, 'component_template', 'template')}` : '') +
        `\n\nThe start of each file (use code_read for the rest):\n${wrapUntrusted(files, 'code_read', 'repo')}`,
    },
  ];

  await report({ stage: 'reading', progress: 0.3 });
  const toolCtx = svc.toolCtx(run, principal);
  const { content, readPaths } = await runCodeReadingLoop({
    client: svc.client,
    call: { config: agent.config, userId: run.createdBy, operation: 'component-draft', locale: run.locale as Locale },
    messages,
    tools: [...svc.readTools.definitions(), ...svc.code.definitions()],
    // One repository: whatever connectorId the model wrote, this is the one it reads.
    execute: (name, args) =>
      CODE_TOOLS.has(name)
        ? svc.code.execute(name, { ...args, connectorId: input.connectorId }, toolCtx)
        : svc.readTools.execute(name, args, toolCtx),
    toolless: agent.missing.includes('tools'),
    json: true,
    seen: component.paths,
  });
  const body = readComponentDraft(parseModelJson(content), rendered.body, snapshot, readPaths, component.paths);
  if (!body) throw new Error(t('agent.component.draftUnusable'));

  const title = rendered.title?.trim() || component.name;
  const markdown = composeFrontmatter(
    body.markdown,
    componentFrontmatter(rendered.frontmatter, {
      repository,
      component,
      source: snapshot.blobUrl(component.paths[0]),
      generatedBy: agent.key,
    }),
  );
  return {
    summary: t('agent.component.summary', { name: component.name, files: readPaths.size, repository: snapshot.name }),
    findings: [
      {
        kind: 'gap',
        severity: 'info',
        title: t('agent.component.findingTitle', { name: component.name }),
        detail: t('agent.component.findingDetail', { paths: component.paths.join(', ') }),
        documentIds: [],
        documentTitles: [],
        sources: body.sources,
        draft: { title: title.slice(0, 300), markdown, template: { ref: rendered.templateRef, version: rendered.templateVersion } },
      },
    ],
  };
}

/** The one enabled repository connector, when there is exactly one to mean. */
async function onlyRepository(svc: AgentServices, workspaceId: string): Promise<string | null> {
  const rows = await svc.prisma.connector.findMany({
    where: { workspaceId, enabled: true, kind: { in: ['codebase', 'markdown-git'] } },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * The workspace pages that count as "already declared" for a repository:
 * the ones the connector itself wrote (its links) and the ones under its
 * destination — which is where a page created from a finding lands, and
 * what makes a second run skip the file that page is about. With no
 * destination parent the project's root pages stand in. Capped, and read
 * through the same `getContent` a reader uses; a draft-only page is skipped.
 */
export async function destinationPages(
  svc: AgentServices,
  scope: AccessScope,
  connector: { id: string; projectId: string; parentId: string | null },
): Promise<Array<{ id: string; title: string; markdown: string; frontmatter: Record<string, unknown> | null }>> {
  const workspaceId = scope.workspaceId;
  const ids = new Set<string>();
  for (const link of await svc.prisma.connectorLink.findMany({
    where: { connectorId: connector.id },
    select: { documentId: true },
    take: MAX_DECLARED_PAGES,
  })) {
    ids.add(link.documentId);
  }
  if (connector.parentId) {
    ids.add(connector.parentId);
    let frontier = [connector.parentId];
    while (frontier.length > 0 && ids.size < MAX_DECLARED_PAGES) {
      const children = await svc.prisma.document.findMany({
        where: { workspaceId, parentId: { in: frontier } },
        select: { id: true },
        take: MAX_DECLARED_PAGES,
      });
      frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
      for (const id of frontier) ids.add(id);
    }
  } else {
    for (const root of await svc.prisma.document.findMany({
      where: { workspaceId, projectId: connector.projectId, parentId: null },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_DECLARED_PAGES,
    })) {
      ids.add(root.id);
    }
  }

  // Walked unfiltered so a hidden section does not cut off what is under
  // it, then filtered: a page the run may not read declares nothing to it.
  const rows = await svc.prisma.document.findMany({
    where: { id: { in: [...ids].slice(0, MAX_DECLARED_PAGES) }, workspaceId, AND: [visibilityWhere(scope)] },
    select: { id: true, title: true },
  });
  const out: Array<{ id: string; title: string; markdown: string; frontmatter: Record<string, unknown> | null }> = [];
  for (const row of rows) {
    try {
      const content = await svc.documents.getContent(row.id);
      // The frontmatter counts as declared text too: a page created from a
      // finding names its file in `source:`, and that is the mention that
      // keeps the next run from proposing the same file again even when the
      // prose paraphrases the path.
      const frontmatter = content.frontmatter ? JSON.stringify(content.frontmatter) : '';
      out.push({
        id: row.id,
        title: row.title,
        markdown: `${content.markdown}\n${frontmatter}`,
        frontmatter: (content.frontmatter as Record<string, unknown> | null) ?? null,
      });
    } catch {
      // No indexed content yet, or a draft: nothing declared, nothing to read.
    }
  }
  return out;
}
