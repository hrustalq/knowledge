import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { AgentRegistryService } from '../../agents/agent-registry.service.js';
import { AiUsageService } from '../../ai/ai-usage.service.js';
import { AssistantClient } from '../../assistant/assistant.client.js';
import { t } from '../../i18n/t.js';
import { extractImports, extractSymbols, type CodeSymbol } from './code-symbols.js';
import {
  OVERVIEW_KEY,
  buildRepoMap,
  unitInputHash,
  type RepoMap,
  type RepoModule,
} from './repo-map.js';
import { blobUrl, downloadRepoArchive, repoHost, repoSubdir } from './repo-archive.js';
import { TreeSitterService } from './tree-sitter.service.js';
import {
  optionalConfig,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
} from './connector.types.js';

/**
 * A repository as a subject to document (docs/features/27).
 *
 * `markdown-git` mirrors prose that already exists. This one reads the *code*
 * and derives pages that exist nowhere upstream: a hub for the repository and
 * one page per module. The unit keys are ours, which is why it is pull-only —
 * there is nothing on the far side to write a derived page back to.
 *
 * ## The one house rule this adapter bends, and why
 *
 * Every other adapter is plain `fetch` with no model anywhere near it. This one
 * injects the model client, because every other adapter's external system
 * already holds prose and this one's holds source code: there is no "fetch the
 * text" step to separate from "write the text". Keeping the derivation in the
 * adapter is what avoids the alternative — a kind-specific branch inside
 * `ConnectorSyncService`, which would put this feature's shape into the generic
 * pipeline every other connector runs through.
 *
 * The rule that replaces it is **the adapter derives, the pipeline stages, the
 * API applies** — feature 17's *worker generates, API publishes*, one layer
 * down. Nothing here writes a page; staging and review are unchanged.
 *
 * ## Two layers, and the second one is optional
 *
 * The deterministic layer is tree-sitter: modules, exported symbols with their
 * signatures, dependencies, entrypoints. It costs nothing and it is the page's
 * substance. The model layer writes the prose that opens the page, from those
 * facts. If there is no model configured, no owner to bill, or no budget left,
 * the page still stages — with a warning saying which — because a connector
 * that produces nothing when the AI is off would be a worse version of a
 * feature that already works.
 */

/** Modules are capped so one enormous monorepo cannot become five hundred pages. */
const DEFAULT_MAX_MODULES = 24;

/** Files parsed per unit. Beyond this the surface is representative, not complete. */
const MAX_FILES_PER_UNIT = 200;

/** Symbols listed on a page. A module with more has a table nobody reads. */
const MAX_SYMBOLS_SHOWN = 60;

/** What the model is allowed to see. Facts, not source — the facts are smaller and better. */
const MAX_PROMPT_CHARS = 12_000;

interface ModuleAnalysis {
  symbols: CodeSymbol[];
  /** Bare import specifiers — `react`, `fmt`. Relative ones are dropped as noise. */
  external: string[];
  parsed: number;
  unreadable: number;
}

@Injectable()
export class CodebaseAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'codebase';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: false, tree: true };

  private readonly logger = new Logger(CodebaseAdapter.name);

  /** One map per run, for the same reason the archive is cached per run. */
  private readonly maps = new WeakMap<object, Promise<RepoMap>>();

  constructor(
    private readonly treeSitter: TreeSitterService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
  ) {}

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    // Deliberately does not parse: this answers "can I reach it and is there
    // anything there", and a person is waiting for it in a dialog.
    const map = await this.repoMap(ctx);
    if (map.sourceFileCount === 0) {
      return { ok: false, detail: 'no source files were found — check the branch and subdirectory' };
    }
    const languages = map.languages.slice(0, 3).map((l) => l.language).join(', ');
    return {
      ok: true,
      detail: `${map.sourceFileCount} source file(s) in ${map.modules.length} module(s) — ${languages}`,
    };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const { files, branch } = await downloadRepoArchive(ctx);
    const map = await this.repoMap(ctx);
    const host = repoHost(ctx);

    // The hub first: it is the page everything else hangs under, and `applying`
    // orders by depth and position, so it is also the one to exist first.
    yield {
      externalId: OVERVIEW_KEY,
      title: `${host.repo} — overview`,
      url: `${host.origin}/${host.owner}/${host.repo}`,
      version: unitInputHash(files, map.overviewPaths, map.modules.map((m) => m.key)),
    };

    for (const module of map.modules) {
      yield {
        externalId: module.key,
        title: module.name,
        url: blobUrl(ctx, module.path, branch),
        // The module's own files decide its version, which is what makes a
        // re-sync skip every module except the one somebody touched.
        version: unitInputHash(files, module.files),
      };
    }
  }

  /**
   * The two-level shape `list()` already implies, said out loud.
   *
   * The overview has been "the page everything else hangs under" in the comment
   * above since this adapter was written, but it was never in the data — so
   * `seedFlat` imported the overview and every module as siblings, and a repo
   * with forty modules put forty pages at the destination's top level.
   */
  async *children(ctx: ConnectorContext, parent: ExternalRef | null): AsyncIterable<ExternalRef> {
    const { files, branch } = await downloadRepoArchive(ctx);
    const map = await this.repoMap(ctx);
    const host = repoHost(ctx);

    if (!parent) {
      yield {
        externalId: OVERVIEW_KEY,
        title: `${host.repo} — overview`,
        url: `${host.origin}/${host.owner}/${host.repo}`,
        version: unitInputHash(files, map.overviewPaths, map.modules.map((m) => m.key)),
        hasChildren: map.modules.length > 0,
      };
      return;
    }
    if (parent.externalId !== OVERVIEW_KEY) return;

    for (const module of map.modules) {
      yield {
        externalId: module.key,
        title: module.name,
        url: blobUrl(ctx, module.path, branch),
        version: unitInputHash(files, module.files),
        parentExternalId: OVERVIEW_KEY,
      };
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const { files, skipped, branch } = await downloadRepoArchive(ctx);
    const map = await this.repoMap(ctx);
    const host = repoHost(ctx);
    const warnings: string[] = [];

    // Warnings are catalogued rather than written inline (docs/features/18).
    // The connector's locale is passed explicitly: a sync runs in the worker,
    // which has no request for the ambient language to come from.
    if (skipped.oversize > 0) {
      warnings.push(t('connector.warning.codebase.oversize', { count: skipped.oversize }, ctx.locale));
    }

    if (ref.externalId === OVERVIEW_KEY) {
      if (map.omitted > 0) {
        warnings.push(t('connector.warning.codebase.modulesOmitted', { count: map.omitted }, ctx.locale));
      }
      const facts = this.overviewFacts(map, host.repo);
      const prose = await this.narrate(ctx, `${host.repo} overview`, facts, warnings);
      return {
        ref,
        title: `${host.repo} — overview`,
        markdown: joinSections(prose, this.overviewMarkdown(map)),
        frontmatter: {
          source: `${host.origin}/${host.owner}/${host.repo}`,
          generated: 'codebase-connector',
          unit: OVERVIEW_KEY,
        },
        warnings,
      };
    }

    const module = map.modules.find((m) => m.key === ref.externalId);
    if (!module) {
      // A module that was renamed or dropped upstream. The item fails and is
      // reported; the next full sync will not rediscover it, and the link is
      // left for a person to decide about.
      throw new Error(`${ref.externalId} is no longer part of this repository`);
    }

    const analysis = await this.analyse(ctx, module, files);
    if (analysis.unreadable > 0) {
      warnings.push(t('connector.warning.codebase.unparsed', { count: analysis.unreadable }, ctx.locale));
    }
    if (module.files.length > MAX_FILES_PER_UNIT) {
      warnings.push(
        t(
          'connector.warning.codebase.truncated',
          { total: module.files.length, limit: MAX_FILES_PER_UNIT },
          ctx.locale,
        ),
      );
    }

    const facts = this.moduleFacts(module, analysis);
    const prose = await this.narrate(ctx, module.name, facts, warnings);

    return {
      ref,
      title: module.name,
      markdown: joinSections(prose, this.moduleMarkdown(ctx, module, analysis, branch)),
      frontmatter: {
        source: blobUrl(ctx, module.path, branch),
        generated: 'codebase-connector',
        unit: module.key,
        module: module.path,
      },
      warnings,
    };
  }

  // --- analysis ---

  private repoMap(ctx: ConnectorContext): Promise<RepoMap> {
    let pending = this.maps.get(ctx.config);
    if (!pending) {
      pending = downloadRepoArchive(ctx).then(({ files }) =>
        buildRepoMap(files, {
          subdir: repoSubdir(ctx),
          maxModules: positiveInt(optionalConfig(ctx.config, 'maxModules')) ?? DEFAULT_MAX_MODULES,
        }),
      );
      this.maps.set(ctx.config, pending);
    }
    return pending;
  }

  /** Parse a module's files and collect what they declare. Never throws. */
  private async analyse(
    ctx: ConnectorContext,
    module: RepoModule,
    files: Map<string, Uint8Array>,
  ): Promise<ModuleAnalysis> {
    const symbols: CodeSymbol[] = [];
    const external = new Set<string>();
    let parsed = 0;
    let unreadable = 0;

    for (const path of module.files.slice(0, MAX_FILES_PER_UNIT)) {
      const language = this.treeSitter.languageForPath(path);
      const bytes = files.get(path);
      if (!language || !bytes) continue;

      const source = Buffer.from(bytes).toString('utf8');
      const read = await this.treeSitter.withTree(language, source, (tree) => ({
        symbols: extractSymbols(language, tree),
        imports: extractImports(language, tree),
      }));

      if (!read) {
        unreadable += 1;
        continue;
      }
      parsed += 1;
      for (const symbol of read.symbols) symbols.push(symbol);
      for (const specifier of read.imports) {
        // Relative specifiers describe this module's own internals, which the
        // file list already shows. What a reader cannot see is what it rests on.
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) external.add(specifier);
      }
    }

    ctx.debug('module analysed', { module: module.path, parsed, unreadable, symbols: symbols.length });
    return { symbols, external: [...external].sort(), parsed, unreadable };
  }

  // --- the deterministic page ---

  private overviewMarkdown(map: RepoMap): string {
    const sections: string[] = [];

    if (map.modules.length > 0) {
      const rows = map.modules.map(
        (m) => `| [${m.name}](#) | \`${m.path || '.'}\` | ${m.files.length} | ${formatBytes(m.bytes)} |`,
      );
      sections.push(
        ['## Modules', '', '| Module | Path | Files | Size |', '| --- | --- | --- | --- |', ...rows].join('\n'),
      );
    }

    if (map.languages.length > 0) {
      const rows = map.languages.map((l) => `- **${l.language}** — ${l.files} file(s)`);
      sections.push(['## Languages', '', ...rows].join('\n'));
    }

    const entrypoints = map.modules.flatMap((m) => m.entrypoints);
    if (entrypoints.length > 0) {
      sections.push(['## Entrypoints', '', ...entrypoints.map((e) => `- \`${e}\``)].join('\n'));
    }

    if (map.rootManifest?.dependencies.length) {
      const deps = map.rootManifest.dependencies.slice(0, 30).map((d) => `\`${d}\``).join(', ');
      sections.push(['## Depends on', '', deps].join('\n'));
    }

    return sections.join('\n\n');
  }

  private moduleMarkdown(
    ctx: ConnectorContext,
    module: RepoModule,
    analysis: ModuleAnalysis,
    branch: string,
  ): string {
    const sections: string[] = [];

    const facts = [
      `- **Path** — \`${module.path || '.'}\``,
      `- **Files** — ${module.files.length} source file(s), ${formatBytes(module.bytes)}`,
      ...(module.manifest?.name ? [`- **Package** — \`${module.manifest.name}\``] : []),
      ...(module.entrypoints.length > 0
        ? [`- **Entrypoints** — ${module.entrypoints.map((e) => `\`${e}\``).join(', ')}`]
        : []),
    ];
    sections.push(['## At a glance', '', ...facts].join('\n'));

    const exported = analysis.symbols.filter((s) => s.exported);
    if (exported.length > 0) {
      const shown = exported.slice(0, MAX_SYMBOLS_SHOWN);
      const rows = shown.map((s) => `| \`${s.name}\` | ${s.kind} | \`${escapePipes(s.signature)}\` |`);
      const more =
        exported.length > shown.length ? [``, `_…and ${exported.length - shown.length} more._`] : [];
      sections.push(
        ['## Public API', '', '| Name | Kind | Signature |', '| --- | --- | --- |', ...rows, ...more].join('\n'),
      );
    }

    const dependencies = [...new Set([...(module.manifest?.dependencies ?? []), ...analysis.external])];
    if (dependencies.length > 0) {
      const shown = dependencies.slice(0, 30).map((d) => `\`${d}\``).join(', ');
      sections.push(['## Depends on', '', shown].join('\n'));
    }

    const listed = module.files.slice(0, 40);
    sections.push(
      [
        '## Files',
        '',
        ...listed.map((f) => `- [\`${f}\`](${blobUrl(ctx, f, branch)})`),
        ...(module.files.length > listed.length ? ['', `_…and ${module.files.length - listed.length} more._`] : []),
      ].join('\n'),
    );

    return sections.join('\n\n');
  }

  // --- the model layer ---

  private overviewFacts(map: RepoMap, repo: string): string {
    return [
      `Repository: ${repo}`,
      `Source files: ${map.sourceFileCount} (${formatBytes(map.totalBytes)})`,
      `Languages: ${map.languages.map((l) => `${l.language} (${l.files})`).join(', ')}`,
      ...(map.rootManifest?.description ? [`Described as: ${map.rootManifest.description}`] : []),
      '',
      'Modules:',
      ...map.modules.map(
        (m) =>
          `- ${m.name} (${m.path || '.'}): ${m.files.length} files${
            m.manifest?.description ? ` — ${m.manifest.description}` : ''
          }`,
      ),
    ].join('\n');
  }

  private moduleFacts(module: RepoModule, analysis: ModuleAnalysis): string {
    const exported = analysis.symbols.filter((s) => s.exported).slice(0, MAX_SYMBOLS_SHOWN);
    return [
      `Module: ${module.name}`,
      `Path: ${module.path || '.'}`,
      ...(module.manifest?.description ? [`Package description: ${module.manifest.description}`] : []),
      `Files: ${module.files.length}`,
      ...(module.entrypoints.length > 0 ? [`Entrypoints: ${module.entrypoints.join(', ')}`] : []),
      '',
      'Exported API:',
      ...exported.map((s) => `- ${s.kind} ${s.name}: ${s.signature}`),
      '',
      `Depends on: ${[...new Set([...(module.manifest?.dependencies ?? []), ...analysis.external])]
        .slice(0, 30)
        .join(', ')}`,
      '',
      'Representative files:',
      ...module.files.slice(0, 40).map((f) => `- ${f}`),
    ].join('\n');
  }

  /**
   * The prose that opens the page, or null with a warning saying why not.
   *
   * Every refusal here is a warning rather than an error on purpose: the
   * deterministic page is already worth staging, and a run that failed because
   * a budget ran out would throw away work that cost nothing to keep.
   */
  private async narrate(
    ctx: ConnectorContext,
    subject: string,
    facts: string,
    warnings: string[],
  ): Promise<string | null> {
    // No owner, no spend. `connectors.created_by` is nullable, and billing a
    // non-uuid into `ai_usage.user_id` fails an insert that is deliberately
    // swallowed — which is how background spend becomes invisible. Feature 20
    // made `agent_runs.created_by` NOT NULL for exactly this; this column
    // predates that and cannot be tightened without a migration, so the adapter
    // refuses instead.
    if (!ctx.userId) {
      warnings.push(t('connector.warning.codebase.noOwner', {}, ctx.locale));
      return null;
    }

    const agent = await this.agents.resolve(ctx.workspaceId, 'author');
    if (!agent.enabled || !agent.config.enabled) {
      warnings.push(t('connector.warning.codebase.aiDisabled', {}, ctx.locale));
      return null;
    }

    try {
      await this.aiUsage.assertWithinBudget(ctx.workspaceId, ctx.userId);
    } catch {
      warnings.push(t('connector.warning.codebase.budget', {}, ctx.locale));
      return null;
    }

    try {
      const answer = await this.client.chat(
        { config: agent.config, userId: ctx.userId, operation: 'codebase', locale: ctx.locale },
        [
          {
            role: 'system' as const,
            content:
              `${agent.instructions}\n\n` +
              'You are writing the opening of a documentation page about part of a software project. ' +
              'You are given facts extracted from the source code by a parser — names, signatures, ' +
              'dependencies, file layout. Explain what this is and what it is for, in two to four short ' +
              'paragraphs of prose. Ground every statement in the facts given: if they do not say what ' +
              'something does, describe what it exposes rather than guessing at behaviour, and never ' +
              'invent a feature, a caller or a design reason. Do not repeat the lists back — a table of ' +
              'them follows your text on the page. No headings, no code fences, no bullet points.',
          },
          { role: 'user' as const, content: `${subject}\n\n${facts.slice(0, MAX_PROMPT_CHARS)}` },
        ],
      );

      const prose = answer.trim();
      return prose.length > 0 ? prose : null;
    } catch (err) {
      this.logger.warn(`narration failed for ${subject}: ${(err as Error).message}`);
      warnings.push(t('connector.warning.codebase.narrationFailed', {}, ctx.locale));
      return null;
    }
  }
}

// --- helpers ---

function joinSections(prose: string | null, deterministic: string): string {
  return prose ? `${prose}\n\n${deterministic}` : deterministic;
}

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A signature containing a pipe would otherwise end the table cell it sits in. */
function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}
