import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WIKI_DEFAULT_FLOWS,
  effectiveWikiConfig,
  wikiUnitKey,
  type ConnectorCapabilities,
  type ConnectorKind,
  type EffectiveWikiConfig,
  type WikiFlow,
  type WikiPageSection,
} from '@knowledge/contracts';
import { AgentRegistryService } from '../../agents/agent-registry.service.js';
import { AiUsageService } from '../../ai/ai-usage.service.js';
import { AssistantClient } from '../../assistant/assistant.client.js';
import { wrapUntrusted } from '../../common/untrusted.js';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';
import { extractImports, extractSymbols, type CodeSymbol } from './code-symbols.js';
import {
  OVERVIEW_KEY,
  buildRepoMap,
  unitInputHash,
  type RepoMap,
  type RepoModule,
} from './repo-map.js';
import { blobUrl, downloadRepoArchive, repoHost, repoSubdir, type RepoArchive } from './repo-archive.js';
import { TreeSitterService } from './tree-sitter.service.js';
import { readWikiSteering, wikiPathFilter, type WikiSteering } from './wiki-steering.js';
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
 *
 * ## The wiki (docs/features/46)
 *
 * With the connector's `wiki` key on, the same two layers produce a wiki rather
 * than a hub and a list: Architecture, Data flow and Public API pages hang under
 * the overview beside the module pages, and `.knowledge/wiki.yml` steers which
 * exist, which paths are read and how much may be spent. The existing
 * `overview` / `module:<path>` keys are kept, never renamed — renaming would
 * orphan every live link — and the new sections are new keys. With the wiki off
 * the output is exactly what it was, and the steering file is not read.
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

/** Everything a run decides once, from the archive alone. */
interface RepoPlan {
  archive: RepoArchive;
  map: RepoMap;
  steering: WikiSteering;
  wiki: EffectiveWikiConfig;
  /** Declared flows, or ones seeded from entrypoints when the file declares none. */
  flows: WikiFlow[];
}

const SECTION_TITLE_KEY: Record<WikiPageSection, string> = {
  architecture: 'connector.wiki.section.architecture',
  'data-flow': 'connector.wiki.section.dataFlow',
  api: 'connector.wiki.section.api',
};

@Injectable()
export class CodebaseAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'codebase';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: false, tree: true };

  private readonly logger = new Logger(CodebaseAdapter.name);

  /** One plan per run, for the same reason the archive is cached per run. */
  private readonly plans = new WeakMap<object, Promise<RepoPlan>>();
  /** Module analyses per run: the API section's version needs them before any fetch. */
  private readonly analyses = new WeakMap<object, Map<string, Promise<ModuleAnalysis>>>();

  private readonly maxEffort: Env['WIKI_MAX_EFFORT'];
  private readonly maxDiagramNodes: number;

  constructor(
    private readonly treeSitter: TreeSitterService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
    config: ConfigService<Env, true>,
  ) {
    this.maxEffort = config.get('WIKI_MAX_EFFORT', { infer: true });
    this.maxDiagramNodes = config.get('WIKI_DIAGRAM_MAX_NODES', { infer: true });
  }

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    // Deliberately does not parse: this answers "can I reach it and is there
    // anything there", and a person is waiting for it in a dialog.
    const { map } = await this.plan(ctx);
    if (map.sourceFileCount === 0) {
      return { ok: false, detail: 'no source files were found — check the branch and subdirectory' };
    }
    const languages = map.languages.slice(0, 3).map((l) => l.language).join(', ');
    return {
      ok: true,
      detail: `${map.sourceFileCount} source file(s) in ${map.modules.length} module(s) — ${languages}`,
    };
  }

  /** The same set as `children()`, flat — the orphan repair pass reads this. */
  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    for (const ref of await this.units(ctx)) {
      const { parentExternalId: _parent, hasChildren: _children, ...flat } = ref;
      yield flat;
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
    const want = parent?.externalId ?? null;
    for (const ref of await this.units(ctx)) {
      if ((ref.parentExternalId ?? null) === want) yield ref;
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const plan = await this.plan(ctx);
    const { map, wiki, archive } = plan;
    const { skipped } = archive;
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
      if (wiki.enabled) this.steeringWarnings(ctx, plan, warnings);
      const facts = this.overviewFacts(map, host.repo);
      const prose = await this.narrate(ctx, plan, `${host.repo} overview`, facts, warnings);
      return {
        ref,
        title: `${host.repo} — overview`,
        markdown: wiki.enabled
          ? joinParts(prose, this.sectionIndex(ctx, plan), this.overviewMarkdown(map))
          : joinSections(prose, this.overviewMarkdown(map)),
        frontmatter: {
          source: `${host.origin}/${host.owner}/${host.repo}`,
          ...this.generatedBy(plan, OVERVIEW_KEY, map.modules.map((m) => m.path)),
        },
        warnings,
      };
    }

    if (ref.externalId === wikiUnitKey('architecture')) return this.architecturePage(ctx, plan, ref, warnings);
    if (ref.externalId === wikiUnitKey('data-flow')) return this.dataFlowPage(ctx, plan, ref, warnings);
    if (ref.externalId === wikiUnitKey('api')) return this.apiPage(ctx, plan, ref, warnings);

    const module = map.modules.find((m) => m.key === ref.externalId);
    if (!module) {
      // A module that was renamed or dropped upstream. The item fails and is
      // reported; the next full sync will not rediscover it, and the link is
      // left for a person to decide about.
      throw new Error(t('error.connector.moduleGone', { path: ref.externalId }, ctx.locale));
    }

    const analysis = await this.analysis(ctx, plan, module);
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
    const prose = await this.narrate(ctx, plan, module.name, facts, warnings);

    return {
      ref,
      title: module.name,
      markdown: joinSections(prose, this.moduleMarkdown(ctx, module, analysis, archive.branch)),
      frontmatter: {
        source: blobUrl(ctx, module.path, archive.branch),
        ...this.generatedBy(plan, module.key, [module.path]),
        module: module.path,
      },
      warnings,
    };
  }

  // --- planning ---

  private plan(ctx: ConnectorContext): Promise<RepoPlan> {
    let pending = this.plans.get(ctx.config);
    if (!pending) {
      pending = downloadRepoArchive(ctx).then((archive) => this.buildPlan(ctx, archive));
      this.plans.set(ctx.config, pending);
    }
    return pending;
  }

  private buildPlan(ctx: ConnectorContext, archive: RepoArchive): RepoPlan {
    const connectorMax = positiveInt(optionalConfig(ctx.config, 'maxModules'));
    const ceiling = { maxEffort: this.maxEffort, maxDiagramNodes: this.maxDiagramNodes };

    // Off means off: the steering file is not even read, so a repository that
    // carries one does not change a connector that never asked for a wiki.
    const steering: WikiSteering = effectiveWikiConfig(ctx.config, null, ceiling).enabled
      ? readWikiSteering(archive.files)
      : { config: null, source: 'default', errors: [], hash: 'default' };
    const wiki = effectiveWikiConfig(ctx.config, steering.config, ceiling);

    const map = buildRepoMap(archive.files, {
      subdir: repoSubdir(ctx),
      // The file's `modules.max` is the more specific statement — it was written
      // by someone looking at this repository — so it wins over the form field.
      maxModules: (wiki.enabled ? wiki.modules.max : null) ?? connectorMax ?? DEFAULT_MAX_MODULES,
      pathFilter: wiki.enabled ? wikiPathFilter(wiki.include, wiki.exclude) : null,
      titles: wiki.enabled ? wiki.modules.titles : {},
    });

    return { archive, map, steering, wiki, flows: wiki.enabled ? this.flowsFor(wiki, map) : [] };
  }

  /**
   * Declared flows, or — when the file declares none — one per entrypoint, so
   * the Data flow page has something to trace before anyone writes a config.
   */
  private flowsFor(wiki: EffectiveWikiConfig, map: RepoMap): WikiFlow[] {
    if (wiki.flows.length > 0) return wiki.flows.map((f) => ({ ...f, seeded: false }));
    return map.modules
      .flatMap((m) => m.entrypoints.map((entry) => ({ module: m, entry })))
      .slice(0, WIKI_DEFAULT_FLOWS)
      .map(({ module, entry }) => ({ name: `${module.name}: ${entry.split('/').pop()}`, entry, seeded: true }));
  }

  /** Every unit this run would stage, in walk order: the hub, then what hangs under it. */
  private async units(ctx: ConnectorContext): Promise<ExternalRef[]> {
    const plan = await this.plan(ctx);
    const { archive, map, wiki } = plan;
    const { files, branch } = archive;
    const host = repoHost(ctx);
    const extra = this.versionSalt(plan);

    const modules = !wiki.enabled || wiki.sections.includes('modules') ? map.modules : [];
    const sections = wiki.enabled ? (['architecture', 'data-flow', 'api'] as const).filter((s) => wiki.sections.includes(s)) : [];

    const refs: ExternalRef[] = [
      {
        // The hub first: it is the page everything else hangs under, and
        // `applying` orders by depth and position, so it is also the one to
        // exist first.
        externalId: OVERVIEW_KEY,
        title: `${host.repo} — overview`,
        url: `${host.origin}/${host.owner}/${host.repo}`,
        version: unitInputHash(files, map.overviewPaths, [...map.modules.map((m) => m.key), ...extra, ...sections]),
        hasChildren: modules.length + sections.length > 0,
      },
    ];

    for (const section of sections) {
      refs.push({
        externalId: wikiUnitKey(section),
        title: this.sectionTitle(ctx, host.repo, section),
        url: `${host.origin}/${host.owner}/${host.repo}`,
        version: await this.sectionVersion(ctx, plan, section, extra),
        parentExternalId: OVERVIEW_KEY,
      });
    }

    for (const module of modules) {
      refs.push({
        externalId: module.key,
        title: module.name,
        url: blobUrl(ctx, module.path, branch),
        // The module's own files decide its version, which is what makes a
        // re-sync skip every module except the one somebody touched.
        version: unitInputHash(files, module.files, extra),
        parentExternalId: OVERVIEW_KEY,
      });
    }

    return refs;
  }

  /**
   * What every wiki unit's version mixes in besides its own inputs: the
   * steering file and the effort that applies. Editing `wiki.yml` re-derives
   * the pages it can affect; with the wiki off this is empty, so the versions
   * are exactly what they were.
   */
  private versionSalt(plan: RepoPlan): string[] {
    if (!plan.wiki.enabled) return [];
    return [`wiki:${plan.steering.hash}`, `effort:${plan.wiki.effort.applied}`];
  }

  /**
   * Each section's version covers only what that section reads, so a change
   * re-derives the pages it can affect and nothing else.
   */
  private async sectionVersion(
    ctx: ConnectorContext,
    plan: RepoPlan,
    section: WikiPageSection,
    extra: string[],
  ): Promise<string> {
    const { map, archive, flows } = plan;
    switch (section) {
      case 'architecture': {
        // The manifests and the module list — not the source bytes. A body-only
        // edit inside a module moves that module's page, never this one.
        const manifests = map.modules.flatMap((m) => (m.manifest ? [m.manifest.path] : []));
        if (map.rootManifest) manifests.push(map.rootManifest.path);
        // Everything the page prints: names and entrypoints, but no file counts.
        const modules = map.modules.map((m) => `${m.key}=${m.name}:${m.entrypoints.join(',')}`).sort();
        return unitInputHash(archive.files, [...new Set(manifests)], [...extra, ...modules]);
      }
      case 'data-flow':
        return unitInputHash(
          archive.files,
          flows.map((f) => f.entry),
          [...extra, ...flows.map((f) => `${f.name}|${f.entry}|${f.symbol ?? ''}`)],
        );
      case 'api': {
        // Exported signatures only: renaming a private helper is not a change
        // to the public surface, so it does not re-derive the page.
        // Walked in key order: the map sorts modules by size, and a file that
        // grew must not reorder the digest of a surface that did not change.
        const digest = createHash('sha256');
        for (const module of [...map.modules].sort((a, b) => a.key.localeCompare(b.key))) {
          const analysis = await this.analysis(ctx, plan, module);
          digest.update(`${module.key}\n`);
          for (const s of analysis.symbols.filter((x) => x.exported)) digest.update(`${s.kind} ${s.name} ${s.signature}\n`);
        }
        return unitInputHash(archive.files, [], [...extra, digest.digest('hex')]);
      }
    }
  }

  // --- analysis ---

  private analysis(ctx: ConnectorContext, plan: RepoPlan, module: RepoModule): Promise<ModuleAnalysis> {
    let perRun = this.analyses.get(ctx.config);
    if (!perRun) {
      perRun = new Map();
      this.analyses.set(ctx.config, perRun);
    }
    let pending = perRun.get(module.key);
    if (!pending) {
      pending = this.analyse(ctx, module, plan.archive.files);
      perRun.set(module.key, pending);
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
      const read = await this.readFile(path, files);
      if (read === undefined) continue;
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

  /** One file's symbols and imports; `undefined` = not source, `null` = unparseable. */
  private async readFile(
    path: string,
    files: Map<string, Uint8Array>,
  ): Promise<{ symbols: CodeSymbol[]; imports: string[] } | null | undefined> {
    const language = this.treeSitter.languageForPath(path);
    const bytes = files.get(path);
    if (!language || !bytes) return undefined;
    const source = Buffer.from(bytes).toString('utf8');
    return this.treeSitter.withTree(language, source, (tree) => ({
      symbols: extractSymbols(language, tree),
      imports: extractImports(language, tree),
    }));
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

  /** The wiki hub's table of contents — the sections that exist, in reading order. */
  private sectionIndex(ctx: ConnectorContext, plan: RepoPlan): string {
    const host = repoHost(ctx);
    const rows = (['architecture', 'data-flow', 'api'] as const)
      .filter((s) => plan.wiki.sections.includes(s))
      .map((s) => `- ${this.sectionTitle(ctx, host.repo, s)}`);
    if (plan.wiki.sections.includes('modules') && plan.map.modules.length > 0) {
      rows.push(`- ${t('connector.wiki.section.modules', { count: plan.map.modules.length }, ctx.locale)}`);
    }
    return rows.length > 0 ? ['## Wiki', '', ...rows].join('\n') : '';
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

  // --- wiki sections ---

  private async architecturePage(
    ctx: ConnectorContext,
    plan: RepoPlan,
    ref: ExternalRef,
    warnings: string[],
  ): Promise<ExternalDocument> {
    const { map } = plan;
    const host = repoHost(ctx);
    const internal = internalDependencies(map);
    // By path, not by size: this page must not change when a module merely grows.
    const modules = [...map.modules].sort((a, b) => a.path.localeCompare(b.path));

    const sections: string[] = [];
    if (modules.length > 0) {
      const rows = modules.map(
        (m) =>
          `| ${m.name} | \`${m.path || '.'}\` | ${m.manifest?.name ? `\`${m.manifest.name}\`` : '—'} | ${
            m.entrypoints.length > 0 ? m.entrypoints.map((e) => `\`${e.split('/').pop()}\``).join(', ') : '—'
          } |`,
      );
      sections.push(
        [
          '## Components',
          '',
          '| Module | Path | Package | Entrypoints |',
          '| --- | --- | --- | --- |',
          ...rows,
        ].join('\n'),
      );
    }

    if (internal.size > 0) {
      const rows = [...internal].map(([from, to]) => `- **${from.name}** → ${[...to].map((m) => m.name).join(', ')}`);
      sections.push(['## How the modules depend on each other', '', ...rows].join('\n'));
    }

    const external = externalDependencies(map);
    if (external.length > 0) {
      const rows = external.slice(0, 30).map(([name, count]) => `- \`${name}\` — ${count} module(s)`);
      sections.push(['## Shared external dependencies', '', ...rows].join('\n'));
    }

    const facts = [
      `Repository: ${host.repo}`,
      'Modules:',
      ...modules.map((m) => `- ${m.name} (${m.path || '.'})`),
      '',
      'Internal dependencies:',
      ...[...internal].map(([from, to]) => `- ${from.name} -> ${[...to].map((m) => m.name).join(', ')}`),
      '',
      `Shared external dependencies: ${external.slice(0, 20).map(([n]) => n).join(', ')}`,
    ].join('\n');

    const title = this.sectionTitle(ctx, host.repo, 'architecture');
    const prose = await this.narrate(ctx, plan, title, facts, warnings);
    return {
      ref,
      title,
      markdown: joinParts(prose, ...sections),
      frontmatter: {
        source: `${host.origin}/${host.owner}/${host.repo}`,
        ...this.generatedBy(plan, ref.externalId, map.modules.map((m) => m.path)),
      },
      warnings,
    };
  }

  private async dataFlowPage(
    ctx: ConnectorContext,
    plan: RepoPlan,
    ref: ExternalRef,
    warnings: string[],
  ): Promise<ExternalDocument> {
    const { flows, archive } = plan;
    const host = repoHost(ctx);
    const sections: string[] = [];
    const facts: string[] = [`Repository: ${host.repo}`, ''];

    for (const flow of flows) {
      if (!archive.files.has(flow.entry)) {
        warnings.push(t('connector.warning.wiki.flowEntryMissing', { entry: flow.entry }, ctx.locale));
        continue;
      }
      const read = await this.readFile(flow.entry, archive.files);
      const symbols = read?.symbols ?? [];
      const focus = flow.symbol ? symbols.filter((s) => s.name === flow.symbol) : symbols.filter((s) => s.exported);
      const imports = read?.imports ?? [];

      const lines = [
        `### ${escapeHeading(flow.name)}`,
        '',
        `- **Entry** — [\`${flow.entry}\`](${blobUrl(ctx, flow.entry, archive.branch)})${
          flow.symbol ? ` · \`${flow.symbol}\`` : ''
        }`,
      ];
      if (focus.length > 0) {
        lines.push('', ...focus.slice(0, 20).map((s) => `- \`${escapePipes(s.signature)}\``));
      }
      if (imports.length > 0) {
        lines.push('', `- **Reaches into** — ${imports.slice(0, 20).map((i) => `\`${i}\``).join(', ')}`);
      }
      sections.push(lines.join('\n'));

      // The symbol is steering text too; it reaches the facts only once the
      // parser has confirmed a declaration by that name exists.
      const matched = flow.symbol && focus.length > 0 ? ` symbol ${flow.symbol}` : '';
      facts.push(
        `Flow (${flow.seeded ? 'entrypoint' : 'declared'}): entry ${flow.entry}${matched}`,
        ...focus.slice(0, 20).map((s) => `  - ${s.kind} ${s.name}: ${s.signature}`),
        `  imports: ${imports.slice(0, 20).join(', ')}`,
        '',
      );
    }

    const title = this.sectionTitle(ctx, host.repo, 'data-flow');
    // Flow names come from the steering file — repository bytes — so they reach
    // the model inside the untrusted wrapper, never as part of the facts.
    const declared = flows.filter((f) => !f.seeded).map((f) => `${f.entry}: ${f.name}`);
    const prose = await this.narrate(ctx, plan, title, facts.join('\n'), warnings, declared);
    return {
      ref,
      title,
      markdown: joinParts(prose, sections.length > 0 ? ['## Flows', '', sections.join('\n\n')].join('\n') : null),
      frontmatter: {
        source: `${host.origin}/${host.owner}/${host.repo}`,
        ...this.generatedBy(plan, ref.externalId, []),
      },
      warnings,
    };
  }

  private async apiPage(
    ctx: ConnectorContext,
    plan: RepoPlan,
    ref: ExternalRef,
    warnings: string[],
  ): Promise<ExternalDocument> {
    const { map } = plan;
    const host = repoHost(ctx);
    const sections: string[] = [];
    const facts: string[] = [`Repository: ${host.repo}`, ''];

    for (const module of map.modules) {
      const exported = (await this.analysis(ctx, plan, module)).symbols.filter((s) => s.exported);
      if (exported.length === 0) continue;
      const shown = exported.slice(0, MAX_SYMBOLS_SHOWN);
      sections.push(
        [
          `### ${escapeHeading(module.name)}`,
          '',
          '| Name | Kind | Signature |',
          '| --- | --- | --- |',
          ...shown.map((s) => `| \`${s.name}\` | ${s.kind} | \`${escapePipes(s.signature)}\` |`),
          ...(exported.length > shown.length ? ['', `_…and ${exported.length - shown.length} more._`] : []),
        ].join('\n'),
      );
      facts.push(`${module.name}: ${exported.slice(0, 15).map((s) => s.name).join(', ')}`);
    }

    const title = this.sectionTitle(ctx, host.repo, 'api');
    const prose = await this.narrate(ctx, plan, title, facts.join('\n'), warnings);
    return {
      ref,
      title,
      markdown: joinParts(prose, ...sections),
      frontmatter: {
        source: `${host.origin}/${host.owner}/${host.repo}`,
        ...this.generatedBy(plan, ref.externalId, map.modules.map((m) => m.path)),
      },
      warnings,
    };
  }

  private sectionTitle(ctx: ConnectorContext, repo: string, section: WikiPageSection): string {
    return `${repo} — ${t(SECTION_TITLE_KEY[section], {}, ctx.locale)}`;
  }

  /**
   * The frontmatter that says who wrote a page. Wiki pages also carry the
   * commit they describe and the module paths they cover, which is what lets
   * the archaeologist treat those paths as already declared.
   */
  private generatedBy(plan: RepoPlan, unit: string, modulePaths: string[]): Record<string, unknown> {
    if (!plan.wiki.enabled) return { generated: 'codebase-connector', unit };
    return {
      generated: 'repo-wiki',
      unit,
      ...(plan.archive.headSha ? { headSha: plan.archive.headSha } : {}),
      ...(modulePaths.length > 0 ? { modulePaths } : {}),
    };
  }

  /** The steering file's problems, said once per run on the hub page. */
  private steeringWarnings(ctx: ConnectorContext, plan: RepoPlan, warnings: string[]): void {
    const { steering, wiki } = plan;
    if (steering.errors.length > 0) {
      warnings.push(
        t('connector.warning.wiki.configInvalid', { errors: steering.errors.join('; ') }, ctx.locale),
      );
    }
    if (wiki.effort.clamped) {
      warnings.push(
        t('connector.warning.wiki.effortClamped', { asked: wiki.effort.asked, applied: wiki.effort.applied }, ctx.locale),
      );
    }
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
   *
   * `steer` is text the repository wrote about itself (`focus`, flow names).
   * It is handed over wrapped as untrusted — the file is anyone-with-push-access
   * input, so it may say what to emphasise and nothing about what to do.
   */
  private async narrate(
    ctx: ConnectorContext,
    plan: RepoPlan,
    subject: string,
    facts: string,
    warnings: string[],
    steer: string[] = [],
  ): Promise<string | null> {
    // Effort `low` is a promise of zero spend, kept before any other check.
    if (plan.wiki.enabled && plan.wiki.effort.applied === 'low') return null;

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

    const steering = [...(plan.wiki.focus ? [`Focus: ${plan.wiki.focus}`] : []), ...steer];
    const untrusted =
      plan.wiki.enabled && steering.length > 0
        ? `\n\n${wrapUntrusted(steering.join('\n').slice(0, 4_000), WIKI_STEERING_TOOL, 'repo')}`
        : '';

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
          { role: 'user' as const, content: `${subject}\n\n${facts.slice(0, MAX_PROMPT_CHARS)}${untrusted}` },
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

/** The label the steering text carries inside the untrusted wrapper. */
const WIKI_STEERING_TOOL = '.knowledge/wiki.yml';

// --- helpers ---

/**
 * Module → the modules it declares a dependency on, by package name.
 * Manifest-level only: a module with no manifest, or one that imports a sibling
 * without declaring it, has no edge here.
 */
export function internalDependencies(map: RepoMap): Map<RepoModule, Set<RepoModule>> {
  const byName = new Map(map.modules.flatMap((m) => (m.manifest?.name ? [[m.manifest.name, m] as const] : [])));
  const edges = new Map<RepoModule, Set<RepoModule>>();
  for (const module of map.modules) {
    for (const dep of module.manifest?.dependencies ?? []) {
      const target = byName.get(dep);
      if (!target || target === module) continue;
      const set = edges.get(module) ?? new Set<RepoModule>();
      set.add(target);
      edges.set(module, set);
    }
  }
  return edges;
}

/** External dependency → how many modules declare it, most shared first. Internal packages excluded. */
function externalDependencies(map: RepoMap): Array<[string, number]> {
  const internal = new Set(map.modules.flatMap((m) => (m.manifest?.name ? [m.manifest.name] : [])));
  const counts = new Map<string, number>();
  for (const module of map.modules) {
    for (const dep of new Set(module.manifest?.dependencies ?? [])) {
      if (!internal.has(dep)) counts.set(dep, (counts.get(dep) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function joinSections(prose: string | null, deterministic: string): string {
  return prose ? `${prose}\n\n${deterministic}` : deterministic;
}

/** Joins the parts that have something in them — a wiki page's sections can each be empty. */
function joinParts(...parts: Array<string | null>): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join('\n\n');
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

/** Steering text becomes a heading: one line, no markdown that could open a block. */
function escapeHeading(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[`<>[\]#*_]/g, '').trim().slice(0, 120) || '—';
}
