import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { DOCUMENT_CATEGORIES, blueprintText, type Blueprint, type GenerateBlueprintResponse } from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AssistantReadToolsService } from '../assistant/assistant-read-tools.service.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { safeJson } from '../glossary/glossary.service.js';
import { t } from '../i18n/t.js';
import { TemplatesService } from '../templates/templates.service.js';
import { titleLocale } from './derive-rules.js';
import { keyed, outlineOf, readDraftedTree, readStyleguide } from './drafted-blueprint.js';
import { parseBlueprint } from './blueprint.schema.js';

/** The read tools Describe it may use. Intersected with the agent's own list, never widened by it. */
const GENERATE_TOOLS: ReadonlySet<string> = new Set(['list_document_tree', 'search_knowledge']);

const GENERATE_CONTRACT =
  'Draft the outline of a new documentation project from the person\'s description. You may look at how this ' +
  'workspace already organises its pages (list_document_tree) and search what it already covers ' +
  '(search_knowledge), to fit the outline beside them rather than duplicate them; the new project starts empty. ' +
  'Prefer 5–40 pages, at most 3 levels deep. Mark a section whose pages are added one at a time over the ' +
  'project\'s life (decision records, sessions, components, test cases) as a collection instead of listing ' +
  'entries: give it a title pattern such as "ADR {{n:4}}: " or "{{n:2}} — " ({{n:W}} is the next number, ' +
  'zero-padded to W digits) and, when one fits, a child template. Use a template only from the list you are ' +
  'given, by its ref. Respond ONLY with a json object {"name": string, "description": string, "tree": [node], ' +
  '"styleguide": {"description": string, "rules": [{"text": string, "severity": "error"|"warning"|"info"}]}} ' +
  'where node is {"title": string, "category"?: one of ' +
  DOCUMENT_CATEGORIES.map((c) => `"${c}"`).join('|') +
  ', "template"?: ref, "guidance"?: string, "collection"?: {"pattern"?: string, "template"?: ref}, ' +
  '"children"?: [node]}. name is a short name for the project; description one sentence. guidance says in one ' +
  'or two sentences what belongs on that page. Give at most 10 styleguide rules.';

/**
 * Describe it (#716, phase 5): the `scaffolder` drafts a whole blueprint from
 * a person's brief, optionally adapting a starting one. It may read the
 * workspace's tree and search, each call under the caller's own scope, and
 * writes nothing — the wizard takes the result to Shape, and Create is the
 * only write. The route is `@Feature('assistant')`; this service assumes it.
 */
@Injectable()
export class BlueprintGenerateService {
  constructor(
    private readonly agents: AgentRegistryService,
    private readonly aiUsage: AiUsageService,
    private readonly client: AssistantClient,
    private readonly readTools: AssistantReadToolsService,
    private readonly templates: TemplatesService,
  ) {}

  async generate(workspaceId: string, brief: string, start: Blueprint | null, principal: Principal): Promise<GenerateBlueprintResponse> {
    const agent = await this.agents.resolve(workspaceId, 'scaffolder');
    if (!agent.enabled) throw new BadRequestException(t('error.ai.agentDisabled', { key: agent.name }));
    await this.aiUsage.assertWithinBudget(workspaceId, principal.userId);

    const lang = titleLocale(brief);
    // Workspace-wide templates and enabled built-ins: what a page of a project not yet made can use.
    const offered = (await this.templates.list({ workspaceId })).templates.filter((tpl) => tpl.enabled && !tpl.projectId);
    const refs = new Set<string>(offered.map((tpl) => tpl.ref));
    const catalogue = offered.map((tpl) => `${tpl.ref} — ${tpl.name} (${tpl.category})`).join('\n');

    const startText = start
      ? `\n\nAdapt this starting outline to the description:\n${wrapUntrusted(outlineOf(start.tree).lines.join('\n'), 'blueprint-generate', 'template')}`
      : '';
    // The language rides in the system message beside the contract: a mention in the user turn alone lost
    // to an English contract and English tool results, and the text landed under the wrong locale key.
    const language = lang === 'ru' ? 'Russian' : 'English';
    const messages = [
      {
        role: 'system' as const,
        content: `${agent.instructions}\n\n${GENERATE_CONTRACT}\n\nWrite name, description, every title, guidance and rule in ${language}, whatever language the workspace's pages are in. Keep template refs and title-pattern placeholders as they are.`,
      },
      {
        role: 'user' as const,
        content:
          `Answer in ${language}.\n\nTemplates (ref — name (category)):\n${catalogue || '(none)'}` +
          `\n\nThe description:\n${wrapUntrusted(brief, 'blueprint-generate', 'brief')}${startText}` +
          // Asked in the language itself, last: it is what the model reads right before it answers.
          (lang === 'ru' ? '\n\nПиши все названия, описания, подсказки и правила по-русски.' : ''),
      },
    ];

    const call = { config: agent.config, userId: principal.userId, operation: 'blueprint-generate' as const, locale: principal.locale };
    const allowed = new Set(agent.tools.filter((name) => GENERATE_TOOLS.has(name)));
    const tools = this.readTools.definitions().filter((d) => allowed.has(d.function.name));
    const raw =
      agent.missing.includes('tools') || !tools.length
        ? await this.client.chat(call, messages, { json: true })
        : (
            await this.client.runWithTools(
              call,
              messages,
              tools,
              // Checked on execution, not on offer: a name outside the set is refused whatever the model asks.
              (name, args) =>
                allowed.has(name)
                  ? this.readTools.execute(name, args, { principal, workspaceId })
                  : Promise.resolve({ content: JSON.stringify({ error: `Unknown tool ${name}` }), ok: false }),
              { jsonFinalRound: true },
            )
          ).content;

    const parsed = safeJson(raw) ?? {};
    const tree = readDraftedTree(parsed.tree, refs);
    if (!tree.length) throw new UnprocessableEntityException({ statusCode: 422, message: t('error.blueprint.generateEmpty') });

    const name = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 120) : '';
    const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 2_000) : '';
    const styleguide = readStyleguide(parsed.styleguide);
    // A starting blueprint's own conventions (templates, glossary) stay; a drafted styleguide replaces its one.
    const conventions = { ...start?.conventions, ...(styleguide ? { styleguide } : {}) };
    return {
      blueprint: parseBlueprint({
        name: keyed(name || (start ? blueprintText(start.name, lang) : '') || brief.trim().split('\n')[0]!.slice(0, 120)),
        ...(description ? { description: keyed(description) } : {}),
        ...(start?.icon ? { icon: start.icon } : {}),
        tree,
        ...(Object.keys(conventions).length ? { conventions } : {}),
      }),
    };
  }
}
